import { setImmediate as nextTurn } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { MessageItemType } from "../api/types.js";
import { logger } from "../util/logger.js";

import { WeixinReplyProgressSender } from "./reply-progress-sender.js";
import { sendMessageWeixin } from "./send.js";

// Keep the sender, send helpers and JSON parser real; replace only HTTP transport.
const transport = vi.fn<typeof fetch>();
const opts = { baseUrl: "https://offline.invalid", contextToken: "ctx", accountId: "account" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function response(success = false): Response {
  return new Response(success ? '{"ret":0,"message_id":"123"}' : "", { status: 200 });
}

function createSender(runId = "run", abortSignal?: AbortSignal) {
  return new WeixinReplyProgressSender({
    runId,
    to: "user",
    accountId: "account",
    opts: { ...opts, abortSignal },
  });
}

function emit(
  sender: WeixinReplyProgressSender,
  index: number,
  phase = index % 2 ? "end" : "start",
) {
  sender.replyOptions.onItemEvent({
    kind: "tool",
    phase,
    itemId: `call-${index}`,
    name: `tool-${index}`,
    status: "completed",
  });
}

function requests() {
  return transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).msg);
}

function summaries() {
  return vi
    .mocked(logger.warn)
    .mock.calls.filter(([message]) => message.includes("tool progress disabled"));
}

async function settle() {
  // One event-loop turn drains this finite chain of already-settled Promises.
  // Do not finalize here: late-event checks must exercise an active run.
  await nextTurn();
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.mockReset();
  transport.mockImplementation(async () => response());
  vi.stubGlobal("fetch", transport);
});

afterEach(() => vi.unstubAllGlobals());

describe("tool progress circuit breaker through real send and parse code", () => {
  it.each(["start", "end", "mixed"])(
    "drops an already-queued %s burst after three failures",
    async (phase) => {
      const first = deferred<Response>();
      const started = deferred<void>();
      transport.mockImplementationOnce(() => {
        started.resolve();
        return first.promise;
      });
      const sender = createSender();
      // All ten events arrive synchronously before the first HTTP response.
      for (let i = 0; i < 10; i++) emit(sender, i, phase === "mixed" ? undefined : phase);
      await started.promise;
      expect(transport).toHaveBeenCalledTimes(1);
      first.resolve(response());
      await settle();
      await sender.finalize();
      expect(transport).toHaveBeenCalledTimes(3);
      expect(requests().map((msg) => msg.item_list[0].type)).toEqual(
        phase === "start"
          ? [
              MessageItemType.TOOL_CALL_START,
              MessageItemType.TOOL_CALL_START,
              MessageItemType.TOOL_CALL_START,
            ]
          : phase === "end"
            ? [
                MessageItemType.TOOL_CALL_RESULT,
                MessageItemType.TOOL_CALL_RESULT,
                MessageItemType.TOOL_CALL_RESULT,
              ]
            : [
                MessageItemType.TOOL_CALL_START,
                MessageItemType.TOOL_CALL_RESULT,
                MessageItemType.TOOL_CALL_START,
              ],
      );
    },
  );

  it("rejects late events while the run is still active and logs the transition once", async () => {
    const sender = createSender();
    for (let i = 0; i < 3; i++) emit(sender, i);
    await settle();
    expect(transport).toHaveBeenCalledTimes(3);
    expect(summaries()).toHaveLength(1);
    const warningCount = vi.mocked(logger.warn).mock.calls.length;
    const errorCount = vi.mocked(logger.error).mock.calls.length;
    for (let i = 3; i < 10; i++) emit(sender, i);
    await settle();
    expect(transport).toHaveBeenCalledTimes(3);
    expect(vi.mocked(logger.warn).mock.calls).toHaveLength(warningCount);
    expect(vi.mocked(logger.error).mock.calls).toHaveLength(errorCount);
    await sender.finalize();
  });

  it.each([
    { outcomes: [false, false, true, false, false, true, true], sends: 7, trips: 0 },
    { outcomes: [false, false, true, false, false, false, true, true], sends: 6, trips: 1 },
  ])("resets only the pre-trip failure streak: $outcomes", async ({ outcomes, sends, trips }) => {
    for (const success of outcomes) transport.mockImplementationOnce(async () => response(success));
    const sender = createSender();
    for (let i = 0; i < outcomes.length; i++) emit(sender, i);
    await sender.finalize();
    expect(transport).toHaveBeenCalledTimes(sends);
    expect(summaries()).toHaveLength(trips);
  });

  it("starts each new run with a fresh breaker for the same account and recipient", async () => {
    const oldRun = createSender("old");
    for (let i = 0; i < 3; i++) emit(oldRun, i);
    await settle();
    transport.mockImplementation(async () => response(true));
    const newRun = createSender("new");
    emit(newRun, 0);
    emit(newRun, 1);
    emit(oldRun, 3);
    await newRun.finalize();
    await oldRun.finalize();
    expect(requests().map((msg) => msg.run_id)).toEqual(["old", "old", "old", "new", "new"]);
    expect(summaries()).toHaveLength(1);
  });

  it("does not let successful text sends reopen a tripped tool breaker", async () => {
    const sender = createSender();
    for (let i = 0; i < 3; i++) emit(sender, i);
    await settle();
    transport.mockImplementation(async () => response(true));
    await expect(
      sendMessageWeixin({ to: "user", text: "final answer", opts: { ...opts, runId: "run" } }),
    ).resolves.toMatchObject({ serverMessageId: "123" });
    emit(sender, 3);
    await sender.finalize();
    expect(requests()).toHaveLength(4);
    expect(requests()[3]).toMatchObject({
      run_id: "run",
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: "final answer" } }],
    });
    expect(summaries()).toHaveLength(1);
  });

  it("does not reset the tool failure streak when an ordinary text send succeeds", async () => {
    const sender = createSender();
    emit(sender, 0);
    emit(sender, 1);
    await settle();
    transport.mockImplementationOnce(async () => response(true));
    await sendMessageWeixin({ to: "user", text: "still working", opts });
    emit(sender, 2);
    await settle();
    expect(summaries()).toHaveLength(1);
    emit(sender, 3);
    await sender.finalize();
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it("delivers text while a tool send is pending and after the breaker trips", async () => {
    const first = deferred<Response>();
    const started = deferred<void>();
    transport.mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    });
    transport.mockImplementation(async (_url, init) =>
      response(JSON.parse(String(init?.body)).msg.item_list[0].type === MessageItemType.TEXT),
    );
    const sender = createSender();
    for (let i = 0; i < 10; i++) emit(sender, i);
    await started.promise;
    await expect(sendMessageWeixin({ to: "user", text: "working", opts })).resolves.toHaveProperty(
      "messageId",
    );
    first.resolve(response());
    await settle();
    await expect(sendMessageWeixin({ to: "user", text: "done", opts })).resolves.toHaveProperty(
      "messageId",
    );
    await sender.finalize();
    const items = requests().map((msg) => msg.item_list[0]);
    expect(items.filter((item) => item.type !== MessageItemType.TEXT)).toHaveLength(3);
    expect(
      items.filter((item) => item.type === MessageItemType.TEXT).map((item) => item.text_item.text),
    ).toEqual(["working", "done"]);
  });

  it.each([true, false])("drains accepted work during finalize, success=%s", async (success) => {
    const first = deferred<Response>();
    const started = deferred<void>();
    transport.mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    });
    transport.mockImplementation(async () => response(success));
    const sender = createSender();
    for (let i = 0; i < 10; i++) emit(sender, i);
    await started.promise;
    let completed = false;
    const completion = sender.finalize().then(() => {
      completed = true;
    });
    await nextTurn();
    expect(completed).toBe(false);
    emit(sender, 10);
    first.resolve(response(success));
    await expect(completion).resolves.toBeUndefined();
    await sender.finalize();
    expect(transport).toHaveBeenCalledTimes(success ? 10 : 3);
  });

  it("discards pending work after cancellation without tripping the breaker", async () => {
    const started = deferred<void>();
    transport.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
          started.resolve();
        }),
    );
    const controller = new AbortController();
    const sender = createSender("run", controller.signal);
    for (let i = 0; i < 10; i++) emit(sender, i);
    await started.promise;
    controller.abort();
    emit(sender, 10);
    await expect(sender.finalize()).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(summaries()).toHaveLength(0);
  });

  it("bounds failure logs for a queued burst and emits just one transition summary", async () => {
    const sender = createSender();
    for (let i = 0; i < 10; i++) emit(sender, i);
    await sender.finalize();
    // Existing policy logs each attempted failure in both send.ts and the sender.
    expect(vi.mocked(logger.error).mock.calls).toHaveLength(3);
    expect(vi.mocked(logger.warn).mock.calls).toHaveLength(4);
    expect(summaries()).toHaveLength(1);
  });
});
