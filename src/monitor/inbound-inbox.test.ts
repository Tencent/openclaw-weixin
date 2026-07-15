import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MessageItemType, type WeixinMessage } from "../api/types.js";
import type { DurableInboundLifecycle } from "../messaging/process-message.js";
import { createInboundInbox, resolveInboundInboxDir } from "./inbound-inbox.js";

const TEST_STATE_ROOT = path.join(process.cwd(), ".vitest-state");
const SHARED_STATE_SYMBOL = Symbol.for("openclaw-weixin.inbound-inbox.shared-state");

let stateDir = "";

beforeEach(() => {
  stateDir = path.join(
    TEST_STATE_ROOT,
    `inbound-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(stateDir, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = stateDir;
});

afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  delete (globalThis as Record<PropertyKey, unknown>)[SHARED_STATE_SYMBOL];
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("createInboundInbox", () => {
  it("suppresses duplicate processing across overlapping inbox instances", async () => {
    const gate = createDeferred();
    const started: string[] = [];
    const processor = vi.fn(async (message: WeixinMessage) => {
      started.push(getText(message));
      await gate.promise;
    });
    const inboxA = createModernInboundInbox({
      accountId: "acc-overlap",
      aLog: createLogger(),
      processMessage: processor,
    });
    const inboxB = createModernInboundInbox({
      accountId: "acc-overlap",
      aLog: createLogger(),
      processMessage: processor,
    });

    try {
      await inboxA.enqueueBatch([makeMessage("dup", { message_id: 11 })]);
      inboxA.scheduleProcessing();
      inboxB.scheduleProcessing();

      await waitForCondition(() => started.length === 1);
      await delay(30);
      expect(started).toEqual(["dup"]);

      gate.resolve();
      await waitForCondition(() => listDoneFiles("acc-overlap").length === 1);
    } finally {
      gate.resolve();
      inboxA.stop();
      inboxB.stop();
    }
  });

  it("replays pending records when a new inbox instance starts", async () => {
    const seedInbox = createModernInboundInbox({
      accountId: "acc-replay",
      aLog: createLogger(),
      processMessage: vi.fn(async () => {}),
    });
    const replayed: string[] = [];
    const replayInbox = createModernInboundInbox({
      accountId: "acc-replay",
      aLog: createLogger(),
      processMessage: vi.fn(async (message: WeixinMessage) => {
        replayed.push(getText(message));
      }),
    });

    try {
      await seedInbox.enqueueBatch([makeMessage("replay", { message_id: 21 })]);
      replayInbox.scheduleProcessing();

      await waitForCondition(() => replayed.length === 1);
      expect(replayed).toEqual(["replay"]);
    } finally {
      seedInbox.stop();
      replayInbox.stop();
    }
  });

  it("retains a done tombstone and suppresses replay after success", async () => {
    const processed: string[] = [];
    const inbox = createModernInboundInbox({
      accountId: "acc-done",
      aLog: createLogger(),
      processMessage: vi.fn(async (message: WeixinMessage) => {
        processed.push(getText(message));
      }),
    });
    const message = makeMessage("once", { message_id: 31 });

    try {
      await inbox.enqueueBatch([message]);
      inbox.scheduleProcessing();
      await waitForCondition(() => listDoneFiles("acc-done").length === 1);

      await inbox.enqueueBatch([message]);
      inbox.scheduleProcessing();
      await delay(30);

      expect(processed).toEqual(["once"]);
      expect(listPendingFiles("acc-done")).toEqual([]);
      expect(listDoneFiles("acc-done")).toHaveLength(1);
    } finally {
      inbox.stop();
    }
  });

  it("shares retry backoff across overlapping inbox instances", async () => {
    vi.useFakeTimers();
    const aLog = createLogger();
    let retryAttempts = 0;
    const started: string[] = [];
    const retryMessageSids: string[] = [];
    const processor = vi.fn(
      async (
        message: WeixinMessage,
        _lifecycle?: DurableInboundLifecycle,
        messageSid?: string,
      ) => {
        const text = getText(message);
        started.push(text);
        if (text === "retry") {
          retryMessageSids.push(messageSid ?? "");
          if (++retryAttempts === 1) {
            throw new Error("retry me");
          }
        }
      },
    );
    const inboxA = createModernInboundInbox({
      accountId: "acc-retry",
      aLog,
      processMessage: processor,
    });
    const inboxB = createModernInboundInbox({
      accountId: "acc-retry",
      aLog,
      processMessage: processor,
    });

    try {
      await inboxA.enqueueBatch([
        makeMessage("retry", { message_id: 41 }),
        makeMessage("later", { message_id: 42 }),
        makeMessage("/approve plugin:retry deny", { message_id: 43 }),
      ]);
      inboxA.scheduleProcessing();
      inboxB.scheduleProcessing();
      await flushMicrotasks();

      expect(started).toEqual(["retry", "/approve plugin:retry deny"]);
      expect(listPendingFiles("acc-retry")).toHaveLength(2);

      inboxB.scheduleProcessing();
      await flushMicrotasks();
      expect(started).toEqual(["retry", "/approve plugin:retry deny"]);

      await vi.advanceTimersByTimeAsync(999);
      expect(retryAttempts).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
      expect(started).toEqual([
        "retry",
        "/approve plugin:retry deny",
        "retry",
        "later",
      ]);
      expect(listDoneFiles("acc-retry")).toHaveLength(3);
      expect(retryMessageSids).toHaveLength(2);
      expect(new Set(retryMessageSids)).toHaveProperty("size", 1);
      expect(retryMessageSids[0]).toMatch(/^openclaw-weixin:inbox-[0-9a-f]{24}$/);
      expect(aLog.error).toHaveBeenCalledWith(expect.stringContaining("Failed to process inbound record"));
    } finally {
      inboxA.stop();
      inboxB.stop();
      vi.useRealTimers();
    }
  });

  it("blocks later ordinary work while an earlier record read retries", async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    const inbox = createModernInboundInbox({
      accountId: "acc-read-retry",
      aLog: createLogger(),
      processMessage: vi.fn(async (message: WeixinMessage) => {
        started.push(getText(message));
      }),
    });

    try {
      await inbox.enqueueBatch([
        makeMessage("first", { message_id: 46 }),
        makeMessage("second", { message_id: 47 }),
      ]);
      const firstPath = path.join(resolveInboundInboxDir("acc-read-retry"), "msg-46.pending.json");
      const firstRecord = fs.readFileSync(firstPath, "utf-8");
      fs.writeFileSync(firstPath, "invalid", "utf-8");

      inbox.scheduleProcessing();
      await flushMicrotasks();
      expect(started).toEqual([]);

      fs.writeFileSync(firstPath, firstRecord, "utf-8");
      await vi.advanceTimersByTimeAsync(1_000);
      await flushMicrotasks();
      expect(started).toEqual(["first", "second"]);
    } finally {
      inbox.stop();
      vi.useRealTimers();
    }
  });

  it("hands finalization retries to a replacement inbox without processing again", async () => {
    const aLog = createLogger();
    const processGate = createDeferred();
    const processor = vi.fn(async () => {
      await processGate.promise;
    });
    const inboxA = createModernInboundInbox({
      accountId: "acc-finalize",
      aLog,
      processMessage: processor,
    });
    let inboxB: ReturnType<typeof createInboundInbox> | undefined;

    try {
      await inboxA.enqueueBatch([makeMessage("finalize", { message_id: 45 })]);
      const renameSync = fs.renameSync.bind(fs);
      let failedOnce = false;
      vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
        if (
          !failedOnce &&
          String(oldPath).endsWith(".pending.json") &&
          String(newPath).endsWith(".done.json")
        ) {
          failedOnce = true;
          throw new Error("temporarily busy");
        }
        renameSync(oldPath, newPath);
      });

      inboxA.scheduleProcessing();

      await waitForCondition(() => processor.mock.calls.length === 1);
      inboxB = createModernInboundInbox({
        accountId: "acc-finalize",
        aLog,
        processMessage: processor,
      });
      inboxB.scheduleProcessing();
      inboxA.stop();
      processGate.resolve();

      await waitForCondition(() => listDoneFiles("acc-finalize").length === 1);
      expect(processor).toHaveBeenCalledTimes(1);
      expect(aLog.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to finalize inbound record"),
      );
    } finally {
      processGate.resolve();
      inboxA.stop();
      inboxB?.stop();
    }
  });

  it("preserves polling order when message IDs and sequences sort differently", async () => {
    const started: string[] = [];
    const inbox = createModernInboundInbox({
      accountId: "acc-order",
      aLog: createLogger(),
      processMessage: vi.fn(async (message: WeixinMessage) => {
        started.push(getText(message));
      }),
    });

    try {
      await inbox.enqueueBatch([
        makeMessage("first", { message_id: 10, seq: 10 }),
        makeMessage("second", { message_id: 9, seq: 9 }),
      ]);
      inbox.scheduleProcessing();

      await waitForCondition(() => started.length === 2);
      expect(started).toEqual(["first", "second"]);
    } finally {
      inbox.stop();
    }
  });

  it("keeps ordinary work serial without durable queue admission", async () => {
    const ordinaryGate = createDeferred();
    const started: string[] = [];
    const lifecycles = new Map<string, DurableInboundLifecycle | undefined>();
    const inbox = createInboundInbox({
      accountId: "acc-legacy",
      aLog: createLogger(),
      durableQueueAdmissionSupported: false,
      processMessage: vi.fn(
        async (message: WeixinMessage, lifecycle?: DurableInboundLifecycle) => {
          const text = getText(message);
          started.push(text);
          lifecycles.set(text, lifecycle);
          if (!text.startsWith("/approve")) {
            await ordinaryGate.promise;
          }
        },
      ),
    });

    try {
      await inbox.enqueueBatch([
        makeMessage("first", { message_id: 53 }),
        makeMessage("second", { message_id: 54 }),
        makeMessage("/approve plugin:legacy deny", { message_id: 55 }),
      ]);
      inbox.scheduleProcessing();

      await waitForCondition(
        () => started.includes("first") && started.includes("/approve plugin:legacy deny"),
      );
      await delay(30);
      expect(started).not.toContain("second");
      expect([...lifecycles.values()].every((lifecycle) => lifecycle === undefined)).toBe(true);

      ordinaryGate.resolve();
      await waitForCondition(() => started.includes("second"));
      await waitForCondition(() => listDoneFiles("acc-legacy").length === 3);
    } finally {
      ordinaryGate.resolve();
      inbox.stop();
    }
  });

  it("completes an adopted turn without waiting for its handler to settle", async () => {
    const handlerGate = createDeferred();
    const started: string[] = [];
    let firstHandlerSettled = false;
    const inbox = createModernInboundInbox({
      accountId: "acc-adopted",
      aLog: createLogger(),
      processMessage: vi.fn(
        async (message: WeixinMessage, lifecycle?: DurableInboundLifecycle) => {
          const text = getText(message);
          started.push(text);
          lifecycle?.onTurnAdopted();
          if (text === "first") {
            await handlerGate.promise;
            firstHandlerSettled = true;
          }
        },
      ),
    });

    try {
      await inbox.enqueueBatch([
        makeMessage("first", { message_id: 56 }),
        makeMessage("second", { message_id: 57 }),
      ]);
      inbox.scheduleProcessing();

      await waitForCondition(() => listDoneFiles("acc-adopted").length === 2);
      expect(started).toEqual(["first", "second"]);
      expect(firstHandlerSettled).toBe(false);

      handlerGate.resolve();
      await waitForCondition(() => firstHandlerSettled);
    } finally {
      handlerGate.resolve();
      inbox.stop();
    }
  });

  it("keeps queued follow-ups pending while releasing their ordinary slot", async () => {
    const ordinaryGate = createDeferred();
    const started: string[] = [];
    let queuedLifecycle: DurableInboundLifecycle | undefined;
    const inbox = createModernInboundInbox({
      accountId: "acc-followup",
      aLog: createLogger(),
      processMessage: vi.fn(
        async (message: WeixinMessage, lifecycle?: DurableInboundLifecycle) => {
          const text = getText(message);
          started.push(text);
          if (text === "queued") {
            queuedLifecycle = lifecycle;
            lifecycle?.onEnqueued();
            return;
          }
          await ordinaryGate.promise;
        },
      ),
    });

    try {
      await inbox.enqueueBatch([
        makeMessage("queued", { message_id: 58 }),
        makeMessage("ordinary", { message_id: 59 }),
      ]);
      inbox.scheduleProcessing();

      await waitForCondition(() => started.length === 2);
      expect(queuedLifecycle).toBeDefined();
      expect(listPendingFiles("acc-followup")).toHaveLength(2);
      expect(listDoneFiles("acc-followup")).toEqual([]);

      queuedLifecycle?.onComplete();
      await waitForCondition(() => listDoneFiles("acc-followup").length === 1);
      expect(listPendingFiles("acc-followup")).toHaveLength(1);

      ordinaryGate.resolve();
      await waitForCondition(() => listDoneFiles("acc-followup").length === 2);
    } finally {
      ordinaryGate.resolve();
      inbox.stop();
    }
  });

  it("replays a queued follow-up after process-local ownership is lost", async () => {
    let queuedLifecycle: DurableInboundLifecycle | undefined;
    const initialProcessor = vi.fn(
      async (_message: WeixinMessage, lifecycle?: DurableInboundLifecycle) => {
        queuedLifecycle = lifecycle;
        lifecycle?.onEnqueued();
      },
    );
    const initialInbox = createModernInboundInbox({
      accountId: "acc-followup-restart",
      aLog: createLogger(),
      processMessage: initialProcessor,
    });
    let replayInbox: ReturnType<typeof createInboundInbox> | undefined;

    try {
      await initialInbox.enqueueBatch([makeMessage("queued", { message_id: 66 })]);
      initialInbox.scheduleProcessing();
      await waitForCondition(() => queuedLifecycle !== undefined);
      expect(listPendingFiles("acc-followup-restart")).toHaveLength(1);
      expect(listDoneFiles("acc-followup-restart")).toEqual([]);

      initialInbox.stop();
      delete (globalThis as Record<PropertyKey, unknown>)[SHARED_STATE_SYMBOL];

      const replayProcessor = vi.fn(async () => {});
      replayInbox = createModernInboundInbox({
        accountId: "acc-followup-restart",
        aLog: createLogger(),
        processMessage: replayProcessor,
      });
      replayInbox.scheduleProcessing();

      await waitForCondition(() => listDoneFiles("acc-followup-restart").length === 1);
      expect(initialProcessor).toHaveBeenCalledTimes(1);
      expect(replayProcessor).toHaveBeenCalledTimes(1);
    } finally {
      initialInbox.stop();
      replayInbox?.stop();
    }
  });

  it("starts approval work with durable admission while ordinary capacity is saturated", async () => {
    const ordinaryGate = createDeferred();
    const approvalGate = createDeferred();
    const started: string[] = [];
    const lifecycles = new Map<string, DurableInboundLifecycle | undefined>();
    const inbox = createModernInboundInbox({
      accountId: "acc-approval",
      aLog: createLogger(),
      processMessage: vi.fn(
        async (message: WeixinMessage, lifecycle?: DurableInboundLifecycle) => {
          const text = getText(message);
          started.push(text);
          lifecycles.set(text, lifecycle);
          if (text.startsWith("/approve")) {
            await approvalGate.promise;
            return;
          }
          await ordinaryGate.promise;
        },
      ),
    });

    try {
      await inbox.enqueueBatch([
        makeMessage("one", { message_id: 61 }),
        makeMessage("two", { message_id: 62 }),
        makeMessage("three", { message_id: 63 }),
        makeMessage("four", { message_id: 64 }),
        makeMessage("/approve plugin:approval deny", { message_id: 65 }),
      ]);
      inbox.scheduleProcessing();

      await waitForCondition(() => started.some((text) => !text.startsWith("/approve")));
      await waitForCondition(() => started.includes("/approve plugin:approval deny"));
      expect(lifecycles.get("one")).toBeDefined();
      expect(lifecycles.get("/approve plugin:approval deny")).toBeDefined();

      ordinaryGate.resolve();
      approvalGate.resolve();
      await waitForCondition(() => listDoneFiles("acc-approval").length === 5);
    } finally {
      ordinaryGate.resolve();
      approvalGate.resolve();
      inbox.stop();
    }
  });

  it("keeps unrelated approve text on the ordinary lane", async () => {
    const gate = createDeferred();
    const started: string[] = [];
    const inbox = createModernInboundInbox({
      accountId: "acc-approval-shape",
      aLog: createLogger(),
      processMessage: vi.fn(async (message: WeixinMessage) => {
        started.push(getText(message));
        await gate.promise;
      }),
    });

    try {
      await inbox.enqueueBatch([
        makeMessage("ordinary", { message_id: 66 }),
        makeMessage("/approve request for plugin:approval", { message_id: 67 }),
      ]);
      inbox.scheduleProcessing();

      await waitForCondition(() => started.includes("ordinary"));
      await delay(30);
      expect(started).toEqual(["ordinary"]);

      gate.resolve();
      await waitForCondition(() => listDoneFiles("acc-approval-shape").length === 2);
    } finally {
      gate.resolve();
      inbox.stop();
    }
  });

  it("shares ordinary and approval limits across overlapping inbox instances", async () => {
    const gate = createDeferred();
    const started: string[] = [];
    const processor = vi.fn(async (message: WeixinMessage) => {
      started.push(getText(message));
      await gate.promise;
    });
    const inboxA = createModernInboundInbox({
      accountId: "acc-shared-capacity",
      aLog: createLogger(),
      processMessage: processor,
    });
    const inboxB = createModernInboundInbox({
      accountId: "acc-shared-capacity",
      aLog: createLogger(),
      processMessage: processor,
    });

    try {
      await inboxA.enqueueBatch([
        makeMessage("one", { message_id: 71 }),
        makeMessage("two", { message_id: 72 }),
        makeMessage("three", { message_id: 73 }),
        makeMessage("four", { message_id: 74 }),
        makeMessage("five", { message_id: 75 }),
        makeMessage("/approve plugin:first deny", { message_id: 76 }),
        makeMessage("/approve plugin:second deny", { message_id: 77 }),
      ]);
      inboxA.scheduleProcessing();
      inboxB.scheduleProcessing();

      await waitForCondition(() => started.length === 2);
      await delay(30);
      expect(started.filter((text) => !text.startsWith("/approve"))).toHaveLength(1);
      expect(started.filter((text) => text.startsWith("/approve"))).toHaveLength(1);

      gate.resolve();
      await waitForCondition(() => listDoneFiles("acc-shared-capacity").length === 7);
    } finally {
      gate.resolve();
      inboxA.stop();
      inboxB.stop();
    }
  });

  it("retains all tombstones for 24 hours after completion", async () => {
    const processed: string[] = [];
    const processor = vi.fn(async (message: WeixinMessage) => {
      processed.push(getText(message));
    });
    let inbox = createModernInboundInbox({
      accountId: "acc-tombstones",
      aLog: createLogger(),
      processMessage: processor,
    });
    const messages = Array.from({ length: 33 }, (_, index) =>
      makeMessage(`message-${index}`, { message_id: 100 + index }),
    );

    try {
      await inbox.enqueueBatch(messages);
      const beforeRetentionWindow = new Date(Date.now() - 25 * 60 * 60 * 1000);
      for (const name of listPendingFiles("acc-tombstones")) {
        const pendingPath = path.join(resolveInboundInboxDir("acc-tombstones"), name);
        fs.utimesSync(pendingPath, beforeRetentionWindow, beforeRetentionWindow);
      }
      inbox.scheduleProcessing();
      await waitForCondition(
        () => listDoneFiles("acc-tombstones").length === messages.length,
        5_000,
      );

      inbox.stop();
      delete (globalThis as Record<PropertyKey, unknown>)[SHARED_STATE_SYMBOL];
      inbox = createModernInboundInbox({
        accountId: "acc-tombstones",
        aLog: createLogger(),
        processMessage: processor,
      });
      inbox.scheduleProcessing();
      await delay(30);

      await inbox.enqueueBatch([messages[0]]);
      inbox.scheduleProcessing();
      await delay(30);

      expect(processed).toHaveLength(messages.length);
      expect(listDoneFiles("acc-tombstones")).toHaveLength(messages.length);
    } finally {
      inbox.stop();
    }
  });
});

function makeMessage(text: string, overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    from_user_id: "user-a",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
    ...overrides,
  };
}

function getText(message: WeixinMessage): string {
  return message.item_list?.[0]?.text_item?.text ?? "";
}

function listPendingFiles(accountId: string): string[] {
  return fs
    .readdirSync(resolveInboundInboxDir(accountId))
    .filter((name) => name.endsWith(".pending.json"));
}

function listDoneFiles(accountId: string): string[] {
  return fs
    .readdirSync(resolveInboundInboxDir(accountId))
    .filter((name) => name.endsWith(".done.json"));
}

function createLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withAccount: vi.fn(),
    getLogFilePath: vi.fn(() => ""),
    close: vi.fn(),
  } as never;
}

function createModernInboundInbox(
  opts: Omit<Parameters<typeof createInboundInbox>[0], "durableQueueAdmissionSupported">,
) {
  return createInboundInbox({
    ...opts,
    durableQueueAdmissionSupported: true,
  });
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let settled = false;
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = () => {
      if (settled) return;
      settled = true;
      innerResolve();
    };
  });
  return { promise, resolve };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(intervalMs);
  }
  throw new Error("Timed out waiting for condition");
}
