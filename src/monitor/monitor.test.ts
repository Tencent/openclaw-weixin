import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  updates: vi.fn(),
  process: vi.fn(),
  flush: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../api/api.js", () => ({
  getUpdates: mocks.updates,
  classifyFetchError: () => ({ type: "test", description: "test" }),
}));
vi.mock("../api/config-cache.js", () => ({
  WeixinConfigManager: class {
    async getForUser() {
      return {};
    }
  },
}));
vi.mock("../messaging/process-message.js", () => ({ processOneMessage: mocks.process }));
vi.mock("../messaging/error-notice.js", () => ({ flushWeixinErrorNotices: mocks.flush }));
vi.mock("../storage/sync-buf.js", () => ({
  getSyncBufFilePath: () => "/test",
  loadGetUpdatesBuf: () => "",
  saveGetUpdatesBuf: mocks.save,
}));
vi.mock("../util/logger.js", () => {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withAccount: () => log,
  };
  return { logger: log };
});
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
beforeEach(() => {
  vi.clearAllMocks();
  mocks.flush.mockResolvedValue(undefined);
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
