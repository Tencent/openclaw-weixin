import { logger } from "../util/logger.js";

const SESSION_PAUSE_DURATION_MS = 60 * 60 * 1000;

/** Error code returned by the server when the bot session has expired. */
export const SESSION_EXPIRED_ERRCODE = -14;

const pauseUntilMap = new Map<string, number>();

/**
 * Pause the long-poll loop for `accountId` (default: one hour).
 *
 * This pause is intentionally scoped to the `getUpdates` long-poll path only.
 * Outbound REST calls (`sendMessage`, `sendTyping`, `sendMedia`, ...) are
 * independent of the long-poll session and must not be blocked here — see
 * #155 for the death-loop bug that resulted from gating them on this state.
 *
 * Callers may pass a shorter `durationMs` to implement exponential backoff
 * when `notifyStart`-based recovery has just failed.
 */
export function pauseSession(accountId: string, durationMs?: number): void {
  const dur = durationMs ?? SESSION_PAUSE_DURATION_MS;
  const until = Date.now() + dur;
  pauseUntilMap.set(accountId, until);
  logger.info(
    `session-guard: paused accountId=${accountId} until=${new Date(until).toISOString()} (${Math.round(dur / 1000)}s)`,
  );
}

/**
 * Clear a previously-set pause for `accountId`.
 *
 * Used by the monitor after a successful `notifyStart` recovery so the
 * long-poll can resume immediately instead of waiting out the cooldown.
 */
export function clearSessionPause(accountId: string): void {
  if (pauseUntilMap.delete(accountId)) {
    logger.info(`session-guard: cleared pause for accountId=${accountId}`);
  }
}

/** Returns `true` when the long-poll is still within its cooldown window. */
export function isSessionPaused(accountId: string): boolean {
  const until = pauseUntilMap.get(accountId);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    pauseUntilMap.delete(accountId);
    return false;
  }
  return true;
}

/** Milliseconds remaining until the pause expires (0 when not paused). */
export function getRemainingPauseMs(accountId: string): number {
  const until = pauseUntilMap.get(accountId);
  if (until === undefined) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    pauseUntilMap.delete(accountId);
    return 0;
  }
  return remaining;
}

/**
 * Throw if the long-poll session is currently paused.
 *
 * NOTE: This guard is intended for callers that are part of the inbound
 * long-poll lifecycle. Outbound REST send paths must NOT call this — see
 * the file-level comment on `pauseSession` and #155.
 */
export function assertSessionActive(accountId: string): void {
  if (isSessionPaused(accountId)) {
    const remainingMin = Math.ceil(getRemainingPauseMs(accountId) / 60_000);
    throw new Error(
      `session paused for accountId=${accountId}, ${remainingMin} min remaining (errcode ${SESSION_EXPIRED_ERRCODE})`,
    );
  }
}

/**
 * Reset internal state — only for tests.
 * @internal
 */
export function _resetForTest(): void {
  pauseUntilMap.clear();
}
