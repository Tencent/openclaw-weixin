/**
 * Tests for the long-poll monitor's errcode -14 (session expired) handling.
 *
 * Regression coverage for #155: the original code unconditionally paused the
 * session for 60 minutes on `-14`, then retried `getUpdates` without first
 * calling `notifyStart`, which immediately returned `-14` again. The new
 * behavior calls `notifyStart` to rebuild the server session and falls back
 * to exponential backoff (not a 60-minute wall) if recovery itself fails.
 *
 * Test pacing: we run with real timers. To keep loop iterations cheap, every
 * mocked `getUpdates` response is delayed by a few ms so the loop yields to
 * the event loop between calls (mirrors how long-poll actually behaves).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetUpdates, mockNotifyStart } = vi.hoisted(() => ({
  mockGetUpdates: vi.fn(),
  mockNotifyStart: vi.fn(),
}));

vi.mock("../api/api.js", () => ({
  getUpdates: mockGetUpdates,
  notifyStart: mockNotifyStart,
}));

vi.mock("../api/config-cache.js", () => ({
  WeixinConfigManager: vi.fn().mockImplementation(() => ({
    getForUser: vi.fn().mockResolvedValue({ typingTicket: undefined }),
  })),
}));

vi.mock("../messaging/process-message.js", () => ({
  processOneMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../storage/sync-buf.js", () => ({
  getSyncBufFilePath: vi.fn(() => "/tmp/sync-buf-test"),
  loadGetUpdatesBuf: vi.fn(() => undefined),
  saveGetUpdatesBuf: vi.fn(),
}));

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withAccount: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

vi.mock("../util/redact.js", () => ({
  redactBody: (s: string) => s,
}));

import { monitorWeixinProvider } from "./monitor.js";
import {
  isSessionPaused,
  getRemainingPauseMs,
  _resetForTest,
} from "../api/session-guard.js";

const SUCCESS_RESP = { ret: 0, msgs: [], get_updates_buf: "" } as const;
const ERR_14_RESP = { errcode: -14, errmsg: "session expired" } as const;

function delayed<T>(value: T, ms = 5): () => Promise<T> {
  return () => new Promise((r) => setTimeout(() => r(value), ms));
}

function delayedReject(err: Error, ms = 5): () => Promise<never> {
  return () => new Promise((_, rej) => setTimeout(() => rej(err), ms));
}

/**
 * Build a minimal opts object that satisfies the monitor's runtime contract.
 * `channelRuntime` is a stub — none of the tested branches exercise inbound
 * dispatch, since we drive `getUpdates` straight into the `-14` path.
 */
function buildOpts(accountId: string, abortSignal: AbortSignal) {
  return {
    baseUrl: "https://test.example/",
    cdnBaseUrl: "https://cdn.example/",
    token: "test-token",
    accountId,
    config: {} as never,
    channelRuntime: {} as never,
    abortSignal,
    longPollTimeoutMs: 50,
  };
}

async function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 10;
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function stop(
  ac: AbortController,
  p: Promise<void>,
): Promise<void> {
  ac.abort();
  try {
    await p;
  } catch {
    // expected — sleep() throws on abort
  }
}

describe("monitor.ts — errcode -14 recovery (#155)", () => {
  beforeEach(() => {
    _resetForTest();
    mockGetUpdates.mockReset();
    mockNotifyStart.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls notifyStart BEFORE entering a long pause when getUpdates returns -14", async () => {
    mockGetUpdates
      .mockImplementationOnce(delayed(ERR_14_RESP))
      .mockImplementation(delayed(SUCCESS_RESP, 50));
    mockNotifyStart.mockImplementation(delayed({ ret: 0 } as never, 2));

    const ac = new AbortController();
    const p = monitorWeixinProvider(buildOpts("acc-a", ac.signal));

    await waitFor(() => mockNotifyStart.mock.calls.length >= 1, {
      timeoutMs: 10_000,
    });
    await stop(ac, p);

    expect(mockNotifyStart).toHaveBeenCalledTimes(1);
    expect(mockNotifyStart).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://test.example/",
        token: "test-token",
      }),
    );
  }, 15_000);

  it("clears the pause after a successful notifyStart so getUpdates resumes within seconds", async () => {
    mockGetUpdates
      .mockImplementationOnce(delayed(ERR_14_RESP))
      .mockImplementation(delayed(SUCCESS_RESP, 50));
    mockNotifyStart.mockImplementation(delayed({ ret: 0 } as never, 2));

    const ac = new AbortController();
    const p = monitorWeixinProvider(buildOpts("acc-b", ac.signal));

    // Wait for notifyStart to be called and at least one more getUpdates.
    await waitFor(
      () =>
        mockNotifyStart.mock.calls.length >= 1 &&
        mockGetUpdates.mock.calls.length >= 2,
      { timeoutMs: 15_000 },
    );

    // Right after recovery + retry, the pause must be clear.
    expect(isSessionPaused("acc-b")).toBe(false);
    expect(getRemainingPauseMs("acc-b")).toBe(0);
    expect(mockGetUpdates.mock.calls.length).toBeGreaterThanOrEqual(2);

    await stop(ac, p);
  }, 20_000);

  it("falls back to a SHORT pause (<60min) when notifyStart fails — no 60-minute wall", async () => {
    mockGetUpdates.mockImplementation(delayed(ERR_14_RESP));
    mockNotifyStart.mockImplementation(delayedReject(new Error("network down")));

    const ac = new AbortController();
    const p = monitorWeixinProvider(buildOpts("acc-c", ac.signal));

    // Wait both for notifyStart to be observed AND the pause map to reflect
    // the fallback backoff window (set just before the awaited notifyStart).
    await waitFor(
      () =>
        mockNotifyStart.mock.calls.length >= 1 &&
        getRemainingPauseMs("acc-c") > 0,
      { timeoutMs: 10_000 },
    );

    // Pause window after a failed recovery attempt must be strictly less
    // than the original 60-minute wall — that's the whole point of #155.
    const remaining = getRemainingPauseMs("acc-c");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(60 * 60 * 1000);

    await stop(ac, p);
  }, 15_000);

  it("on persistent -14, retries notifyStart again instead of dying for 60 minutes", async () => {
    mockGetUpdates.mockImplementation(delayed(ERR_14_RESP));
    mockNotifyStart.mockImplementation(delayedReject(new Error("upstream 500")));

    const ac = new AbortController();
    const p = monitorWeixinProvider(buildOpts("acc-d", ac.signal));

    // Two notifyStart attempts must happen well inside 60 minutes
    // (we cap the wait at a few seconds and assert the call count).
    await waitFor(() => mockNotifyStart.mock.calls.length >= 2, {
      timeoutMs: 30_000,
    });

    expect(mockNotifyStart.mock.calls.length).toBeGreaterThanOrEqual(2);
    await stop(ac, p);
  }, 35_000);

  it("behaves identically on normal traffic — no notifyStart, no pause", async () => {
    mockGetUpdates.mockImplementation(delayed(SUCCESS_RESP, 50));

    const ac = new AbortController();
    const p = monitorWeixinProvider(buildOpts("acc-e", ac.signal));

    await waitFor(() => mockGetUpdates.mock.calls.length >= 3);

    expect(mockNotifyStart).not.toHaveBeenCalled();
    expect(isSessionPaused("acc-e")).toBe(false);

    await stop(ac, p);
  });

  it("recovers a second time when -14 reappears after a prior recovery (no death loop)", async () => {
    mockGetUpdates
      .mockImplementationOnce(delayed(ERR_14_RESP))
      .mockImplementationOnce(delayed(SUCCESS_RESP, 20))
      .mockImplementationOnce(delayed(ERR_14_RESP))
      .mockImplementation(delayed(SUCCESS_RESP, 50));
    mockNotifyStart.mockImplementation(delayed({ ret: 0 } as never, 2));

    const ac = new AbortController();
    const p = monitorWeixinProvider(buildOpts("acc-f", ac.signal));

    // Wait for the second notifyStart to be observed, then give the loop a
    // tick to run its post-await `clearSessionPause` so we don't race on it.
    await waitFor(() => mockNotifyStart.mock.calls.length >= 2, {
      timeoutMs: 30_000,
    });
    await waitFor(() => !isSessionPaused("acc-f"), { timeoutMs: 2_000 });

    expect(mockNotifyStart).toHaveBeenCalledTimes(2);
    expect(isSessionPaused("acc-f")).toBe(false);

    await stop(ac, p);
  }, 35_000);
});
