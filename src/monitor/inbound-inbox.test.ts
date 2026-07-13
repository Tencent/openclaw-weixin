import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MessageItemType, type WeixinMessage } from "../api/types.js";
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
    const inboxA = createInboundInbox({
      accountId: "acc-overlap",
      aLog: createLogger(),
      processMessage: processor,
    });
    const inboxB = createInboundInbox({
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
    const seedInbox = createInboundInbox({
      accountId: "acc-replay",
      aLog: createLogger(),
      processMessage: vi.fn(async () => {}),
    });
    const replayed: string[] = [];
    const replayInbox = createInboundInbox({
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
    const inbox = createInboundInbox({
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
    let attempts = 0;
    const processor = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("retry me");
      }
    });
    const inboxA = createInboundInbox({
      accountId: "acc-retry",
      aLog,
      processMessage: processor,
    });
    const inboxB = createInboundInbox({
      accountId: "acc-retry",
      aLog,
      processMessage: processor,
    });

    try {
      await inboxA.enqueueBatch([makeMessage("retry", { message_id: 41 })]);
      inboxA.scheduleProcessing();
      inboxB.scheduleProcessing();
      await flushMicrotasks();

      expect(attempts).toBe(1);
      expect(listPendingFiles("acc-retry")).toHaveLength(1);

      inboxB.scheduleProcessing();
      await flushMicrotasks();
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
      expect(attempts).toBe(2);
      expect(listDoneFiles("acc-retry")).toHaveLength(1);
      expect(aLog.error).toHaveBeenCalledWith(expect.stringContaining("Failed to process inbound record"));
    } finally {
      inboxA.stop();
      inboxB.stop();
      vi.useRealTimers();
    }
  });

  it("hands finalization retries to a replacement inbox without processing again", async () => {
    const aLog = createLogger();
    const processGate = createDeferred();
    const processor = vi.fn(async () => {
      await processGate.promise;
    });
    const inboxA = createInboundInbox({
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
      inboxB = createInboundInbox({
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

  it("preserves numeric message order when dispatching pending records", async () => {
    const started: string[] = [];
    const inbox = createInboundInbox({
      accountId: "acc-order",
      aLog: createLogger(),
      processMessage: vi.fn(async (message: WeixinMessage) => {
        started.push(getText(message));
      }),
    });

    try {
      await inbox.enqueueBatch([
        makeMessage("nine", { message_id: 9 }),
        makeMessage("ten", { message_id: 10 }),
      ]);
      inbox.scheduleProcessing();

      await waitForCondition(() => started.length === 2);
      expect(started).toEqual(["nine", "ten"]);
    } finally {
      inbox.stop();
    }
  });

  it("allows ordinary messages to overlap", async () => {
    const gate = createDeferred();
    const started: string[] = [];
    const inbox = createInboundInbox({
      accountId: "acc-ordinary",
      aLog: createLogger(),
      processMessage: vi.fn(async (message: WeixinMessage) => {
        started.push(getText(message));
        await gate.promise;
      }),
    });

    try {
      await inbox.enqueueBatch([
        makeMessage("one", { message_id: 51 }),
        makeMessage("two", { message_id: 52 }),
      ]);
      inbox.scheduleProcessing();

      await waitForCondition(() => started.length === 2);
      expect(started).toEqual(expect.arrayContaining(["one", "two"]));

      gate.resolve();
      await waitForCondition(() => listDoneFiles("acc-ordinary").length === 2);
    } finally {
      gate.resolve();
      inbox.stop();
    }
  });

  it("starts approval work while ordinary capacity is saturated", async () => {
    const ordinaryGate = createDeferred();
    const approvalGate = createDeferred();
    const started: string[] = [];
    const inbox = createInboundInbox({
      accountId: "acc-approval",
      aLog: createLogger(),
      processMessage: vi.fn(async (message: WeixinMessage) => {
        const text = getText(message);
        started.push(text);
        if (text.startsWith("/approve")) {
          await approvalGate.promise;
          return;
        }
        await ordinaryGate.promise;
      }),
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

      await waitForCondition(
        () => started.filter((text) => !text.startsWith("/approve")).length === 4,
      );
      await waitForCondition(() => started.includes("/approve plugin:approval deny"));

      ordinaryGate.resolve();
      approvalGate.resolve();
      await waitForCondition(() => listDoneFiles("acc-approval").length === 5);
    } finally {
      ordinaryGate.resolve();
      approvalGate.resolve();
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
    const inboxA = createInboundInbox({
      accountId: "acc-shared-capacity",
      aLog: createLogger(),
      processMessage: processor,
    });
    const inboxB = createInboundInbox({
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

      await waitForCondition(() => started.length === 5);
      await delay(30);
      expect(started.filter((text) => !text.startsWith("/approve"))).toHaveLength(4);
      expect(started.filter((text) => text.startsWith("/approve"))).toHaveLength(1);

      gate.resolve();
      await waitForCondition(() => listDoneFiles("acc-shared-capacity").length === 7);
    } finally {
      gate.resolve();
      inboxA.stop();
      inboxB.stop();
    }
  });

  it("retains all recent tombstones for replay suppression", async () => {
    const processed: string[] = [];
    const inbox = createInboundInbox({
      accountId: "acc-tombstones",
      aLog: createLogger(),
      processMessage: vi.fn(async (message: WeixinMessage) => {
        processed.push(getText(message));
      }),
    });
    const messages = Array.from({ length: 33 }, (_, index) =>
      makeMessage(`message-${index}`, { message_id: 100 + index }),
    );

    try {
      await inbox.enqueueBatch(messages);
      inbox.scheduleProcessing();
      await waitForCondition(
        () => listDoneFiles("acc-tombstones").length === messages.length,
        5_000,
      );

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
