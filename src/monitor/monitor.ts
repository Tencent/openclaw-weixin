import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

import { getUpdates, classifyFetchError } from "../api/api.js";
import { WeixinConfigManager } from "../api/config-cache.js";
import { STALE_TOKEN_ERRCODE, pauseSession, getRemainingPauseMs } from "../api/session-guard.js";
import type { WeixinMessage } from "../api/types.js";
import { processOneMessage } from "../messaging/process-message.js";
import { flushWeixinErrorNotices } from "../messaging/error-notice.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
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
    abortSignal,
    longPollTimeoutMs,
    setStatus,
  } = opts;
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

  const previousGetUpdatesBuf = loadGetUpdatesBuf(syncFilePath);
  let getUpdatesBuf = previousGetUpdatesBuf ?? "";

  if (previousGetUpdatesBuf) {
    log(`[weixin] resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
    aLog.debug(`Using previous get_updates_buf (${getUpdatesBuf.length} bytes)`);
  } else {
    log(`[weixin] no previous sync buf, starting fresh`);
    aLog.info(`No previous get_updates_buf found, starting fresh`);
  }

  const configManager = new WeixinConfigManager({ baseUrl, token }, log);

  let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  const processInbound = async (full: WeixinMessage): Promise<void> => {
    const fromUserId = full.from_user_id ?? "";
    const cachedConfig = await configManager.getForUser(fromUserId, full.context_token);

    await processOneMessage(full, {
      accountId,
      config,
      channelRuntime,
      baseUrl,
      cdnBaseUrl,
      token,
      typingTicket: cachedConfig.typingTicket,
      log: opts.runtime?.log ?? (() => {}),
      errLog,
      abortSignal,
    });
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
  try {
    while (!abortSignal?.aborted) {
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
        setStatus?.({ accountId, lastEventAt: Date.now() });
        if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
          saveGetUpdatesBuf(syncFilePath, resp.get_updates_buf);
          getUpdatesBuf = resp.get_updates_buf;
          aLog.debug(`Saved new get_updates_buf (${getUpdatesBuf.length} bytes)`);
        }
        const list = resp.msgs ?? [];
        for (const full of list) {
          aLog.info(
            `inbound message: from=${full.from_user_id} types=${full.item_list?.map((i) => i.type).join(",") ?? "none"}`,
          );

          const now = Date.now();
          setStatus?.({ accountId, lastEventAt: now, lastInboundAt: now });

          if (abortSignal?.aborted) break;
          try {
            if (batcher) batcher.push(full);
            else await processInbound(full);
          } catch (error) {
            if (!abortSignal?.aborted) {
              errLog(`weixin inbound processing failed: ${String(error)}`);
            }
          }
        }
      } catch (err) {
        if (abortSignal?.aborted) {
          batcher?.flush();
          aLog.info(`Monitor stopped (aborted)`);
          return;
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
  } finally {
    await noticeRecovery;
  }
  batcher?.flush();
  aLog.info(`Monitor ended`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
