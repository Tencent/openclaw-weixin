import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updates: vi.fn(),
  process: vi.fn(),
  flush: vi.fn(),
  save: vi.fn(),
  getForUser: vi.fn(),
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../api/api.js", () => ({
  getUpdates: mocks.updates,
  classifyFetchError: () => ({ type: "network", description: "test error" }),
}));
vi.mock("../api/config-cache.js", () => ({
  WeixinConfigManager: class {
    getForUser(...args: unknown[]) {
      return mocks.getForUser(...args);
    }
  },
}));
vi.mock("../api/session-guard.js", () => ({
  STALE_TOKEN_ERRCODE: -14,
  pauseSession: vi.fn(),
  getRemainingPauseMs: () => 0,
}));
vi.mock("../messaging/process-message.js", () => ({ processOneMessage: mocks.process }));
vi.mock("../messaging/error-notice.js", () => ({ flushWeixinErrorNotices: mocks.flush }));
vi.mock("../storage/sync-buf.js", () => ({
  getSyncBufFilePath: () => "/test",
  loadGetUpdatesBuf: () => "",
  saveGetUpdatesBuf: mocks.save,
}));
vi.mock("../util/logger.js", () => ({
  logger: { ...mocks.log, withAccount: () => mocks.log },
}));
import { monitorWeixinProvider } from "./monitor.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(fn: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await tick();
  }
  throw new Error("condition not reached");
}
function fixture(batches: any[][]) {
  const controller = new AbortController();
  let polls = 0;
  mocks.updates.mockImplementation(async ({ abortSignal }) => {
    const index = polls++;
    if (index < batches.length)
      return { ret: 0, msgs: batches[index], get_updates_buf: String(index) };
    if (abortSignal.aborted) throw abortSignal.reason;
    return new Promise((_, reject) =>
      abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true }),
    );
  });
  const deps = {
    accountId: "test",
    baseUrl: "https://invalid.test",
    cdnBaseUrl: "https://invalid.test",
    config: {},
    channelRuntime: {} as any,
    abortSignal: controller.signal,
    runtime: { error: vi.fn() },
  };
  return { controller, polls: () => polls, run: () => monitorWeixinProvider(deps) };
}

describe("monitor message handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flush.mockResolvedValue(undefined);
    mocks.getForUser.mockResolvedValue({});
  });

  it("preserves sequential message handling", async () => {
    const gate = deferred();
    const f = fixture([[{ message_id: 1 }, { message_id: 2 }]]);
    mocks.process.mockImplementation(async (m) => {
      if (m.message_id === 1) await gate.promise;
    });
    const running = f.run();
    await until(() => mocks.process.mock.calls.length === 1);
    await tick();
    expect(mocks.process).toHaveBeenCalledTimes(1);
    gate.resolve();
    await until(() => mocks.process.mock.calls.length === 2);
    f.controller.abort();
    await running;
  });

  it("continues the received batch after a preparation rejection", async () => {
    const f = fixture([[{ message_id: 1 }, { message_id: 2 }]]);
    mocks.process.mockImplementation(async (m) => {
      if (m.message_id === 1) throw new Error("preparation failed");
    });
    const running = f.run();
    await until(() => mocks.process.mock.calls.length === 2);
    f.controller.abort();
    await running;
  });

  it("recovery does not block incoming messages and remains owned at shutdown", async () => {
    const recovery = deferred();
    mocks.flush.mockReturnValue(recovery.promise);
    const f = fixture([[{ message_id: 1 }]]);
    mocks.process.mockResolvedValue(undefined);
    let done = false;
    const running = f.run().then(() => {
      done = true;
    });
    await until(() => mocks.process.mock.calls.length === 1);
    f.controller.abort();
    await tick();
    expect(done).toBe(false);
    recovery.resolve();
    await running;
    expect(done).toBe(true);
  });
});

describe("monitor connection status", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getForUser.mockResolvedValue({});
    mocks.flush.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function start(controller: AbortController, setStatus = vi.fn()) {
    return {
      setStatus,
      done: monitorWeixinProvider({
        baseUrl: "https://example.invalid",
        cdnBaseUrl: "https://example.invalid",
        accountId: "test-account",
        config: {},
        channelRuntime: {} as never,
        abortSignal: controller.signal,
        setStatus,
      }),
    };
  }

  it("reports a successful poll as connected and clears it when aborted", async () => {
    const controller = new AbortController();
    mocks.updates.mockResolvedValueOnce({ ret: 0, msgs: [] }).mockImplementationOnce(() => {
      controller.abort();
      throw new Error("aborted");
    });

    const { done, setStatus } = start(controller);
    await done;

    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "test-account",
        connected: true,
        lastConnectedAt: expect.any(Number),
        lastEventAt: expect.any(Number),
        lastError: null,
      }),
    );
    expect(setStatus).toHaveBeenLastCalledWith({ accountId: "test-account", connected: false });
  });

  it("clears a previous connection when the API returns an error", async () => {
    const controller = new AbortController();
    const setStatus = vi.fn();
    let statusBeforeRetry: unknown;
    mocks.updates
      .mockResolvedValueOnce({ ret: 0, msgs: [] })
      .mockResolvedValueOnce({ ret: -2, errmsg: "test error" })
      .mockImplementationOnce(() => {
        statusBeforeRetry = setStatus.mock.lastCall?.[0];
        controller.abort();
        throw new Error("aborted");
      });

    const { done } = start(controller, setStatus);
    await vi.advanceTimersByTimeAsync(2000);
    await done;

    expect(statusBeforeRetry).toEqual(
      expect.objectContaining({
        accountId: "test-account",
        connected: false,
      }),
    );
  });

  it("does not report a connection when stopped before the first poll", async () => {
    const controller = new AbortController();
    controller.abort();

    const { done, setStatus } = start(controller);
    await done;

    expect(mocks.updates).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith({ accountId: "test-account", connected: false });
  });

  it("clears a previous connection when polling throws a network error", async () => {
    const controller = new AbortController();
    const setStatus = vi.fn();
    let statusBeforeRetry: unknown;
    mocks.updates
      .mockResolvedValueOnce({ ret: 0, msgs: [] })
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockImplementationOnce(() => {
        statusBeforeRetry = setStatus.mock.lastCall?.[0];
        controller.abort();
        throw new Error("aborted");
      });

    const { done } = start(controller, setStatus);
    await vi.advanceTimersByTimeAsync(2000);
    await done;

    expect(statusBeforeRetry).toEqual(
      expect.objectContaining({
        accountId: "test-account",
        connected: false,
      }),
    );
  });

  it("does not report an aborted poll's empty response as connected", async () => {
    const controller = new AbortController();
    mocks.updates.mockImplementationOnce(async () => {
      controller.abort();
      return { ret: 0, msgs: [] };
    });

    const { done, setStatus } = start(controller);
    await done;

    expect(setStatus).toHaveBeenCalledWith({ accountId: "test-account", connected: false });
    expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
  });

  it("clears connection status when aborted during a message-processing retry", async () => {
    const controller = new AbortController();
    mocks.updates.mockResolvedValueOnce({
      ret: 0,
      msgs: [{ from_user_id: "test@im.wechat" }],
    });
    mocks.getForUser.mockRejectedValueOnce(new Error("message configuration failed"));

    const { done, setStatus } = start(controller);
    const settled = done.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await settled;

    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
    expect(setStatus).toHaveBeenLastCalledWith({ accountId: "test-account", connected: false });
  });
});
