import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

import { getUpdates, classifyFetchError } from "../api/api.js";
import { WeixinConfigManager } from "../api/config-cache.js";
import { STALE_TOKEN_ERRCODE, pauseSession, getRemainingPauseMs } from "../api/session-guard.js";
import type { WeixinMessage } from "../api/types.js";
import { processOneMessage } from "../messaging/process-message.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
import { logger } from "../util/logger.js";
import type { Logger } from "../util/logger.js";
import { redactBody } from "../util/redact.js";
import { createInboundInbox } from "./inbound-inbox.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export type MonitorWeixinOpts = {
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  accountId: string;
  /** When non-empty, only messages whose from_user_id is in this list are processed. */
  allowFrom?: string[];
  config: import("openclaw/plugin-sdk/core").OpenClawConfig;
  runtime?: { log?: (msg: string) => void; error?: (msg: string) => void };
  /**
   * Gateway-injected channel runtime surface (reply/routing/session/media/commands/...).
   * Required for inbound message processing; provided by `ChannelGatewayContext.channelRuntime`.
   */
  channelRuntime: PluginRuntime["channel"];
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  /** Gateway status callback ? called on each successful poll and inbound message. */
  setStatus?: (next: ChannelAccountSnapshot) => void;
};

/**
 * Long-poll loop: getUpdates -> durable enqueue -> cursor commit -> asynchronous dispatch.
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
  const errLog = opts.runtime?.error ?? ((message: string) => log(message));
  const aLog: Logger = logger.withAccount(accountId);

  if (!channelRuntime) {
    const message =
      "channelRuntime missing on monitor opts; gateway must inject ChannelGatewayContext.channelRuntime";
    aLog.error(message);
    throw new Error(message);
  }

  log(`weixin monitor started (${baseUrl}, account=${accountId})`);
  aLog.info(
    `Monitor started: baseUrl=${baseUrl} timeoutMs=${longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS}`,
  );

  const syncFilePath = getSyncBufFilePath(accountId);
  const previousGetUpdatesBuf = loadGetUpdatesBuf(syncFilePath);
  let getUpdatesBuf = previousGetUpdatesBuf ?? "";
  if (previousGetUpdatesBuf) {
    log(`[weixin] resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
  } else {
    log(`[weixin] no previous sync buf, starting fresh`);
  }

  const configManager = new WeixinConfigManager({ baseUrl, token }, log);
  const processInbound = async (full: WeixinMessage): Promise<void> => {
    aLog.info(
      `inbound message: from=${full.from_user_id} types=${full.item_list?.map((item) => item.type).join(",") ?? "none"}`,
    );
    const now = Date.now();
    setStatus?.({ accountId, lastEventAt: now, lastInboundAt: now });
    const cachedConfig = await configManager.getForUser(full.from_user_id ?? "", full.context_token);
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
    });
  };
  const inbox = createInboundInbox({
    accountId,
    aLog,
    processMessage: processInbound,
  });
  inbox.scheduleProcessing();

  let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  try {
    while (!abortSignal?.aborted) {
      try {
        const response = await getUpdates({
          baseUrl,
          token,
          get_updates_buf: getUpdatesBuf,
          timeoutMs: nextTimeoutMs,
          abortSignal,
        });

        if (response.longpolling_timeout_ms != null && response.longpolling_timeout_ms > 0) {
          nextTimeoutMs = response.longpolling_timeout_ms;
        }
        const isApiError =
          (response.ret !== undefined && response.ret !== 0) ||
          (response.errcode !== undefined && response.errcode !== 0);
        if (isApiError) {
          const isStaleToken =
            response.errcode === STALE_TOKEN_ERRCODE ||
            response.ret === STALE_TOKEN_ERRCODE;
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
            `weixin getUpdates failed: ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
          );
          aLog.error(
            `getUpdates failed: ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg} response=${redactBody(JSON.stringify(response))}`,
          );
          const shouldBackOff = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
          if (shouldBackOff) consecutiveFailures = 0;
          await sleep(shouldBackOff ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, abortSignal);
          continue;
        }

        consecutiveFailures = 0;
        setStatus?.({ accountId, lastEventAt: Date.now() });
        const messages = response.msgs ?? [];
        await inbox.enqueueBatch(messages);
        saveCursor(response.get_updates_buf);
        inbox.scheduleProcessing();
      } catch (err) {
        if (abortSignal?.aborted) {
          aLog.info("Monitor stopped (aborted)");
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
        const shouldBackOff = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
        if (shouldBackOff) consecutiveFailures = 0;
        await sleep(shouldBackOff ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, abortSignal);
      }
    }
  } finally {
    inbox.stop();
    aLog.info("Monitor ended");
  }

  function saveCursor(nextCursor: string | undefined): void {
    if (nextCursor == null || nextCursor === "") return;
    saveGetUpdatesBuf(syncFilePath, nextCursor);
    getUpdatesBuf = nextCursor;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
