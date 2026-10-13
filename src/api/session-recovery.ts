import { notifyStart } from "./api.js";
import { triggerWeixinChannelReload } from "../auth/accounts.js";
import { logger } from "../util/logger.js";

/**
 * Local patch (2026-10-03): self-healing for degraded Weixin bot sessions.
 *
 * Background: `sendMessage ret=-2 errmsg=prepare failed` has two distinct causes:
 *   1. Stale context_token  -> fixed by retrying without the token (send.js fallback)
 *   2. Degraded server-side bot session (long-poll went unhealthy) -> retrying
 *      without the token ALSO fails; only re-establishing the session helps.
 *
 * This module implements cause-2 recovery:
 *   1. notifyStart  — re-assert this client to the Weixin server (lightweight)
 *   2. triggerWeixinChannelReload — bump channelConfigUpdatedAt so the gateway
 *      hot-reloads the channel: stopAccount (notifyStop) + startAccount
 *      (notifyStart + fresh long-poll loop). This is the same reload path used
 *      after QR login, so it is a supported, safe operation.
 *
 * A per-account cooldown prevents a storm of failing sends from triggering
 * repeated reloads.
 */
const RECOVERY_COOLDOWN_MS = 60_000;
const lastRecovery = new Map<string, number>();

export type RecoverWeixinSessionParams = {
  accountId: string;
  baseUrl: string;
  token?: string;
};

/**
 * Attempt to recover a degraded Weixin session for `accountId`.
 * Returns true when a recovery was triggered, false when skipped (cooldown)
 * or when the recovery itself failed.
 */
export async function recoverWeixinSession(params: RecoverWeixinSessionParams): Promise<boolean> {
  const { accountId, baseUrl, token } = params;
  const now = Date.now();
  const last = lastRecovery.get(accountId) ?? 0;
  if (now - last < RECOVERY_COOLDOWN_MS) {
    const remainingS = Math.ceil((RECOVERY_COOLDOWN_MS - (now - last)) / 1000);
    logger.info(
      `session-recovery: cooldown active for ${accountId} (${remainingS}s remaining), skipping`,
    );
    return false;
  }
  lastRecovery.set(accountId, now);
  const aLog = logger.withAccount(accountId);
  aLog.warn(`session-recovery: degraded session detected, triggering recovery for ${accountId}`);
  try {
    // Step 1: re-assert client to server (may fix mild degradation on its own).
    try {
      await notifyStart({ baseUrl, token });
      aLog.info("session-recovery: notifyStart succeeded");
    } catch (err) {
      aLog.warn(`session-recovery: notifyStart failed (non-fatal): ${String(err)}`);
    }
    // Step 2: force channel reload -> gateway stops and restarts the account,
    // establishing a fresh long-poll session.
    await triggerWeixinChannelReload();
    aLog.info("session-recovery: channel reload triggered");
    return true;
  } catch (err) {
    aLog.error(`session-recovery: failed: ${String(err)}`);
    lastRecovery.delete(accountId); // allow an immediate retry next time
    return false;
  }
}
