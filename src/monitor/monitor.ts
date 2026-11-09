import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

import { getUpdates, classifyFetchError } from "../api/api.js";
import { WeixinConfigManager } from "../api/config-cache.js";
import { STALE_TOKEN_ERRCODE, pauseSession, getRemainingPauseMs } from "../api/session-guard.js";
import type { WeixinMessage } from "../api/types.js";
import { processOneMessage } from "../messaging/process-message.js";
import { flushWeixinErrorNotices } from "../messaging/error-notice.js";
import { getSyncBufFilePath } from "../storage/sync-buf.js";
import { InboundJournal, InboundJournalError } from "../storage/inbound-journal.js";
import { getInboundSources } from "../messaging/inbound-sources.js";
import { logger } from "../util/logger.js";
import type { Logger } from "../util/logger.js";
import { redactBody } from "../util/redact.js";

import { createInboundBatcher, resolveInboundBatchWindowMs } from "./inbound-batcher.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export type MonitorWeixinOpts = {
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  accountId: string;
  config: import("openclaw/plugin-sdk/core").OpenClawConfig;
  runtime?: { log?: (msg: string) => void; error?: (msg: string) => void };
  /**
   * Gateway-injected channel runtime surface (reply/routing/session/media/commands/...).
   * Required for inbound message processing; provided by `ChannelGatewayContext.channelRuntime`.
   */
  channelRuntime: PluginRuntime["channel"];
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  /** Gateway status callback — called on each successful poll and inbound message. */
  setStatus?: (next: ChannelAccountSnapshot) => void;
};

/**
 * Long-poll loop: getUpdates -> normalize -> recordInboundSession -> dispatchReplyFromConfig.
 * Runs until abort.
 */
export async function monitorWeixinProvider(opts: MonitorWeixinOpts): Promise<void> {
  const {
    baseUrl,
    cdnBaseUrl,
    token,
    accountId,
    config,
    channelRuntime,
    longPollTimeoutMs,
    setStatus,
  } = opts;
  const lifetime = new AbortController();
  const abortSignal = opts.abortSignal
    ? AbortSignal.any([opts.abortSignal, lifetime.signal])
    : lifetime.signal;
  const log = opts.runtime?.log ?? (() => {});
  const errLog = opts.runtime?.error ?? ((m: string) => log(m));
  const aLog: Logger = logger.withAccount(accountId);

  if (!channelRuntime) {
    const msg =
      "channelRuntime missing on monitor opts; gateway must inject ChannelGatewayContext.channelRuntime";
    aLog.error(msg);
    throw new Error(msg);
  }

  log(`weixin monitor started (${baseUrl}, account=${accountId})`);
  aLog.info(
    `Monitor started: baseUrl=${baseUrl} timeoutMs=${longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS}`,
  );

  const syncFilePath = getSyncBufFilePath(accountId);
  aLog.debug(`syncFilePath: ${syncFilePath}`);

  const journal = new InboundJournal(syncFilePath);
  const previousGetUpdatesBuf = journal.cursor;
  let getUpdatesBuf = previousGetUpdatesBuf;
  if (journal.interruptedCount) {
    errLog(
      `weixin: ${journal.interruptedCount} interrupted inbound message(s) retained; automatic replay disabled`,
    );
  }

  if (previousGetUpdatesBuf) {
    log(`[weixin] resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
    aLog.debug(`Using previous get_updates_buf (${getUpdatesBuf.length} bytes)`);
  } else {
    log(`[weixin] no previous sync buf, starting fresh`);
    aLog.info(`No previous get_updates_buf found, starting fresh`);
  }

  const configManager = new WeixinConfigManager({ baseUrl, token, abortSignal }, log);

  let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  let fatalError: InboundJournalError | undefined;
  const stopForPersistenceError = (error: InboundJournalError): void => {
    fatalError ??= error;
    lifetime.abort(error);
  };
  const processInbound = async (full: WeixinMessage): Promise<void> => {
    let sources = [...getInboundSources(full)];
    let admitted = false;
    try {
      abortSignal.throwIfAborted();
      const cachedConfig = await configManager.getForUser(
        full.from_user_id ?? "",
        full.context_token,
      );
      abortSignal.throwIfAborted();
      await processOneMessage(full, {
        accountId,
        config,
        channelRuntime,
        baseUrl,
        cdnBaseUrl,
        token,
        typingTicket: cachedConfig.typingTicket,
        log,
        errLog,
        abortSignal,
        onPreparationFailure: (source) => {
          try {
            journal.finish([source]);
            sources = sources.filter((message) => message !== source);
          } catch (error) {
            if (error instanceof InboundJournalError) stopForPersistenceError(error);
            throw error;
          }
        },
        beforeExecute: () => {
          abortSignal.throwIfAborted();
          if (!admitted) {
            try {
              journal.start(sources);
              admitted = true;
            } catch (error) {
              if (error instanceof InboundJournalError) stopForPersistenceError(error);
              throw error;
            }
          }
        },
      });
      if (abortSignal.aborted) {
        if (admitted) journal.interrupt(sources);
      } else if (sources.length) journal.finish(sources);
    } catch (error) {
      if (error instanceof InboundJournalError) {
        stopForPersistenceError(error);
      } else {
        try {
          if (abortSignal.aborted) {
            if (admitted) journal.interrupt(sources);
          } else if (sources.length) journal.finish(sources);
        } catch (persistError) {
          if (persistError instanceof InboundJournalError) stopForPersistenceError(persistError);
          else throw persistError;
        }
      }
      throw error;
    }
  };

  // Opt-in inbound batching (messages.inbound.byChannel["openclaw-weixin"] / debounceMs).
  // When disabled, messages are processed one by one exactly as before.
  const imageWindowMs = resolveInboundBatchWindowMs(config);
  const batcher =
    imageWindowMs > 0
      ? createInboundBatcher({
          imageWindowMs,
          process: processInbound,
          onError: (err) =>
            aLog.error(`processOneMessage failed: ${String(err)} stack=${(err as Error)?.stack}`),
          onMerged: ({ from, count, media }) =>
            aLog.info(`inbound batching: merged ${count} messages (media=${media}) from=${from}`),
        })
      : undefined;
  if (batcher) aLog.info(`inbound batching enabled: imageWindow=${imageWindowMs}ms`);

  // Recover notices through existing channel activity without delaying new input.
  let noticeRecovery = flushWeixinErrorNotices({ config, accountId, abortSignal, errLog });
  const stopBatcher = () => {
    void batcher?.stop();
  };
  abortSignal.addEventListener("abort", stopBatcher, { once: true });
  const deliver = async (list: WeixinMessage[]): Promise<void> => {
    for (const full of list) {
      if (abortSignal.aborted) break;
      const now = Date.now();
      setStatus?.({ accountId, lastEventAt: now, lastInboundAt: now });
      try {
        if (batcher) batcher.push(full);
        else await processInbound(full);
      } catch (error) {
        if (!abortSignal.aborted) errLog(`weixin inbound processing failed: ${String(error)}`);
      }
    }
  };
  try {
    await deliver(journal.pending());
    while (!abortSignal?.aborted) {
      let pollCompleted = false;
      try {
        aLog.debug(
          `getUpdates: get_updates_buf=${getUpdatesBuf.substring(0, 50)}..., timeoutMs=${nextTimeoutMs}`,
        );
        const resp = await getUpdates({
          baseUrl,
          token,
          get_updates_buf: getUpdatesBuf,
          timeoutMs: nextTimeoutMs,
          // Stop/hot-reload should cancel the in-flight long-poll immediately
          // instead of waiting for the server-side long-poll timeout.
          abortSignal,
        });
        pollCompleted = true;
        if (abortSignal?.aborted) {
          break;
        }
        aLog.debug(
          `getUpdates response: ret=${resp.ret}, msgs=${resp.msgs?.length ?? 0}, get_updates_buf_length=${resp.get_updates_buf?.length ?? 0}`,
        );

        if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
          nextTimeoutMs = resp.longpolling_timeout_ms;
          aLog.debug(`Updated next poll timeout: ${nextTimeoutMs}ms`);
        }
        const isApiError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);
        if (isApiError) {
          setStatus?.({ accountId, connected: false });
          const isStaleToken =
            resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE;

          if (isStaleToken) {
            pauseSession(accountId);
            const pauseMs = getRemainingPauseMs(accountId);
            aLog.error(
              `getUpdates: token for ${accountId} is stale, pausing all requests for ${Math.ceil(pauseMs / 60_000)} min`,
            );
            consecutiveFailures = 0;
            await sleep(pauseMs, abortSignal);
            continue;
          }

          consecutiveFailures += 1;
          errLog(
            `weixin getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
          );
          aLog.error(
            `getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg} response=${redactBody(JSON.stringify(resp))}`,
          );
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            errLog(
              `weixin getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
            );
            aLog.error(
              `getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
            );
            consecutiveFailures = 0;
            await sleep(BACKOFF_DELAY_MS, abortSignal);
          } else {
            await sleep(RETRY_DELAY_MS, abortSignal);
          }
          continue;
        }
        consecutiveFailures = 0;
        noticeRecovery = flushWeixinErrorNotices({ config, accountId, abortSignal, errLog });
        const pollTime = Date.now();
        setStatus?.({
          accountId,
          connected: true,
          lastConnectedAt: pollTime,
          lastEventAt: pollTime,
          lastError: null,
        });
        const list = journal.accept(resp.msgs ?? [], resp.get_updates_buf);
        getUpdatesBuf = journal.cursor;
        await deliver(list);
      } catch (err) {
        if (abortSignal?.aborted) {
          aLog.info(`Monitor stopped (aborted)`);
          break;
        }
        if (err instanceof InboundJournalError) {
          stopForPersistenceError(err);
          break;
        }
        if (!pollCompleted) {
          setStatus?.({ accountId, connected: false });
        }
        consecutiveFailures += 1;
        const classified = classifyFetchError(err);
        errLog(
          `weixin getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)} type=${classified.type} description=${classified.description}${classified.code ? ` code=${classified.code}` : ""}`,
        );
        aLog.error(
          `getUpdates error: ${String(err)}, type=${classified.type} code=${classified.code ?? "none"}, stack=${(err as Error).stack}`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          errLog(
            `weixin getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
          );
          aLog.error(
            `getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
          );
          consecutiveFailures = 0;
          await sleep(30_000, abortSignal);
        } else {
          await sleep(2000, abortSignal);
        }
      }
    }
  } catch (error) {
    if (!abortSignal.aborted) throw error;
  } finally {
    lifetime.abort();
    await batcher?.stop();
    abortSignal.removeEventListener("abort", stopBatcher);
    await noticeRecovery;
    setStatus?.({ accountId, connected: false });
  }
  if (fatalError) throw fatalError;
  aLog.info(`Monitor ended`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
