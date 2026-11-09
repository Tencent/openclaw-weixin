import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ updates: vi.fn(), process: vi.fn(), config: vi.fn() }));
vi.mock("../api/api.js", () => ({
  getUpdates: state.updates,
  classifyFetchError: () => ({ type: "network", description: "test" }),
}));
vi.mock("../api/config-cache.js", () => ({
  WeixinConfigManager: class {
    getForUser(...args: unknown[]) {
      return state.config(...args);
    }
  },
}));
vi.mock("../messaging/process-message.js", () => ({ processOneMessage: state.process }));
vi.mock("../messaging/error-notice.js", () => ({ flushWeixinErrorNotices: async () => {} }));
vi.mock("../util/logger.js", () => {
  const log = { info() {}, debug() {}, warn() {}, error() {} };
  return { logger: { ...log, withAccount: () => log } };
});
import { monitorWeixinProvider } from "./monitor.js";
import { getSyncBufFilePath } from "../storage/sync-buf.js";

let root: string;
let controllers: AbortController[];
const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await tick();
  }
  throw new Error("condition not reached");
}
function start(msgs: any[] = [], window = 60_000) {
  const controller = new AbortController();
  controllers.push(controller);
  let polls = 0;
  state.updates.mockImplementation(async ({ abortSignal }) => {
    if (polls++ === 0) return { ret: 0, msgs, get_updates_buf: "after-input" };
    return new Promise((_, reject) => {
      abortSignal.throwIfAborted();
      abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
    });
  });
  const done = monitorWeixinProvider({
    accountId: "bot",
    baseUrl: "https://invalid.test",
    cdnBaseUrl: "https://invalid.test",
    channelRuntime: {} as any,
    abortSignal: controller.signal,
    config: { messages: { inbound: { debounceMs: window } } },
  });
  return { controller, done, polls: () => polls };
}
const photo = { message_id: "photo-1", from_user_id: "user", item_list: [{ type: 2 }] };
const text = (id: string) => ({
  message_id: id,
  from_user_id: "user",
  item_list: [{ type: 1, text_item: { text: id } }],
});
beforeEach(() => {
  vi.resetAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-inbox-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  controllers = [];
  state.config.mockResolvedValue({ typingTicket: "" });
  state.process.mockImplementation(async (_msg, deps) => deps.beforeExecute?.());
});
afterEach(() => {
  controllers.forEach((c) => c.abort());
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
it("restores an image stopped inside its merge window across repeated restarts", async () => {
  for (let n = 0; n < 2; n++) {
    const run = start(n === 0 ? [photo] : []);
    await until(() => run.polls() >= 2);
    run.controller.abort();
    await run.done;
  }
  state.process.mockClear();
  const run = start([], 1);
  await until(() => state.process.mock.calls.length === 1);
  expect(state.process.mock.calls[0][0].message_id).toBe("photo-1");
  run.controller.abort();
  await run.done;
});
it("waits for a cancelled preparation and restores it without starting queued work", async () => {
  let release!: () => void;
  state.config.mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = () => r({});
      }),
  );
  const run = start([text("first"), text("queued")]);
  await until(() => !!release);
  run.controller.abort();
  let ended = false;
  void run.done.then(() => {
    ended = true;
  });
  await tick();
  expect(ended).toBe(false);
  release();
  await run.done;
  expect(state.process).not.toHaveBeenCalled();
  const next = start([], 0);
  await until(() => state.process.mock.calls.length === 2);
  expect(state.process.mock.calls.map(([m]) => m.message_id)).toEqual(["first", "queued"]);
  next.controller.abort();
  await next.done;
});
it("retains queued input but does not rerun an interrupted admitted turn", async () => {
  let admitted = false;
  state.process.mockImplementationOnce(async (_msg, deps) => {
    deps.beforeExecute();
    admitted = true;
    await new Promise((_, reject) =>
      deps.abortSignal.addEventListener("abort", () => reject(deps.abortSignal.reason), {
        once: true,
      }),
    );
  });
  const run = start([text("active"), text("queued")]);
  await until(() => admitted && run.polls() >= 2);
  run.controller.abort();
  await run.done;
  state.process.mockClear();
  const next = start([], 0);
  await until(() => state.process.mock.calls.length === 1);
  expect(state.process.mock.calls[0][0].message_id).toBe("queued");
  const data = JSON.parse(fs.readFileSync(getSyncBufFilePath("bot"), "utf8"));
  expect(data.inbound.records.find((r: any) => r.message.message_id === "active").state).toBe(
    "interrupted",
  );
  next.controller.abort();
  await next.done;
});
it("deduplicates completed messages when the server repeats their original IDs", async () => {
  const run = start([text("done")], 0);
  await until(() => run.polls() >= 2);
  run.controller.abort();
  await run.done;
  state.process.mockClear();
  const next = start([text("done")], 0);
  await until(() => next.polls() >= 2);
  expect(state.process).not.toHaveBeenCalled();
  next.controller.abort();
  await next.done;
});
it("does not dispatch or replace the old cursor when inbox persistence fails", async () => {
  const file = getSyncBufFilePath("bot");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ get_updates_buf: "old-cursor" }));
  const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
    throw new Error("disk full");
  });
  const run = start([text("unsaved")], 0);
  await expect(run.done).rejects.toThrow("Cannot persist");
  rename.mockRestore();
  expect(state.process).not.toHaveBeenCalled();
  expect(JSON.parse(fs.readFileSync(file, "utf8")).get_updates_buf).toBe("old-cursor");
});
it("does not execute or notify when the admission write fails", async () => {
  state.process.mockImplementationOnce(async (_msg, deps) => {
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    try {
      try {
        deps.beforeExecute();
      } catch (error) {
        expect(deps.abortSignal.aborted).toBe(true);
        throw error;
      }
      throw new Error("unexpected execution");
    } finally {
      rename.mockRestore();
    }
  });
  const run = start([text("not-admitted")], 0);
  await expect(run.done).rejects.toThrow("Cannot persist");
  expect(
    JSON.parse(fs.readFileSync(getSyncBufFilePath("bot"), "utf8")).inbound.records[0].state,
  ).toBe("pending");
});
it("stops normally when cancellation arrives during a polling retry", async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    controllers.push(controller);
    state.updates.mockRejectedValue(new Error("network"));
    const done = monitorWeixinProvider({
      accountId: "bot",
      baseUrl: "https://invalid.test",
      cdnBaseUrl: "https://invalid.test",
      config: {},
      channelRuntime: {} as any,
      abortSignal: controller.signal,
    });
    const settled = expect(done).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await settled;
  } finally {
    vi.useRealTimers();
  }
});
it("does not replay executed work if persisting completion fails", async () => {
  state.process.mockImplementationOnce(async (_msg, deps) => {
    deps.beforeExecute();
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("completion failed");
    });
  });
  const run = start([text("already-executed")], 0);
  await expect(run.done).rejects.toThrow("Cannot persist");
  vi.restoreAllMocks();
  state.process.mockClear();
  const next = start([], 0);
  await until(() => next.polls() >= 2);
  expect(state.process).not.toHaveBeenCalled();
  next.controller.abort();
  await next.done;
});
