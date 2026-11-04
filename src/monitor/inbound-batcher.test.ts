import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MessageItemType } from "../api/types.js";
import type { WeixinMessage } from "../api/types.js";
import {
  createInboundBatcher,
  mergeInboundMessages,
  resolveInboundBatchWindowMs,
} from "./inbound-batcher.js";

const text = (t: string, extra: Partial<WeixinMessage> = {}): WeixinMessage => ({
  from_user_id: "u1",
  item_list: [{ type: MessageItemType.TEXT, text_item: { text: t } }],
  ...extra,
});
const image = (id: string): WeixinMessage => ({
  from_user_id: "u1",
  item_list: [{ type: MessageItemType.IMAGE, msg_id: id, image_item: {} }],
});
const file = (name: string): WeixinMessage => ({
  from_user_id: "u1",
  item_list: [{ type: MessageItemType.FILE, file_item: { file_name: name } }],
});

/** Compact rendering of a processed message for assertions. */
function describeMsg(msg: WeixinMessage): string {
  return (msg.item_list ?? [])
    .map((i) =>
      i.type === MessageItemType.TEXT
        ? `T(${i.text_item?.text?.replace(/\n/g, "|")})`
        : i.type === MessageItemType.IMAGE
          ? `I(${i.msg_id})`
          : i.type === MessageItemType.FILE
            ? `F(${i.file_item?.file_name})`
            : `#${i.type}`,
    )
    .join(" ");
}

describe("resolveInboundBatchWindowMs", () => {
  it("is disabled when not configured", () => {
    expect(resolveInboundBatchWindowMs(undefined)).toBe(0);
    expect(resolveInboundBatchWindowMs({} as never)).toBe(0);
  });

  it("prefers the channel override over the global debounce", () => {
    const cfg = {
      messages: { inbound: { debounceMs: 800, byChannel: { "openclaw-weixin": 1500 } } },
    };
    expect(resolveInboundBatchWindowMs(cfg as never)).toBe(1500);
    expect(
      resolveInboundBatchWindowMs({ messages: { inbound: { debounceMs: 800 } } } as never),
    ).toBe(800);
  });

  it("lets an explicit channel 0 disable a global debounce", () => {
    const cfg = { messages: { inbound: { debounceMs: 800, byChannel: { "openclaw-weixin": 0 } } } };
    expect(resolveInboundBatchWindowMs(cfg as never)).toBe(0);
  });
});

describe("mergeInboundMessages", () => {
  it("returns a single message unchanged, keeping native quote handling", () => {
    const quoted = text("this", {
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: "this" },
          ref_msg: { message_item: { type: MessageItemType.TEXT, text_item: { text: "orig" } } },
        },
      ],
    });
    expect(mergeInboundMessages([quoted])).toBe(quoted);
  });

  it("joins texts, inlines quotes and transcribed voice, and keeps all media", () => {
    const merged = mergeInboundMessages([
      text("a", { context_token: "old" }),
      {
        from_user_id: "u1",
        item_list: [
          {
            type: MessageItemType.TEXT,
            text_item: { text: "what about this" },
            ref_msg: {
              message_item: { type: MessageItemType.TEXT, text_item: { text: "breakfast?" } },
            },
          },
        ],
      },
      {
        from_user_id: "u1",
        item_list: [{ type: MessageItemType.VOICE, voice_item: { text: "voice" } }],
      },
      image("1"),
      file("report.pdf"),
      { ...text("b"), context_token: "new", message_id: "42" },
    ]);
    expect(describeMsg(merged)).toBe(
      "T(a|（引用：breakfast?）what about this|voice|b) I(1) F(report.pdf)",
    );
    expect(merged.context_token).toBe("new");
    expect(merged.message_id).toBe("42");
    expect(merged.item_list?.[0].ref_msg).toBeUndefined();
  });

  it("renders ID-only and media quotes as placeholders", () => {
    const merged = mergeInboundMessages([
      {
        item_list: [
          { type: MessageItemType.TEXT, text_item: { text: "x" }, ref_msg: { svr_id: "9" } },
        ],
      },
      {
        item_list: [
          {
            type: MessageItemType.TEXT,
            text_item: { text: "y" },
            ref_msg: { message_item: { type: MessageItemType.IMAGE } },
          },
        ],
      },
    ]);
    expect(describeMsg(merged)).toBe("T(（引用了之前的一条消息）x|（引用：[图片]）y)");
  });
});

describe("createInboundBatcher", () => {
  let processed: Array<{ at: number; msg: string }>;
  let start: number;
  let release: Array<() => void>;

  /** Processing stays "running" until the test calls finishTurn(). */
  const process = vi.fn(
    (msg: WeixinMessage) =>
      new Promise<void>((resolve) => {
        processed.push({ at: Date.now() - start, msg: describeMsg(msg) });
        release.push(resolve);
      }),
  );
  const finishTurn = async () => {
    release.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    processed = [];
    release = [];
    start = Date.now();
    process.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches text immediately while idle", async () => {
    const batcher = createInboundBatcher({ imageWindowMs: 1500, process });
    batcher.push(text("hi"));
    expect(processed).toEqual([{ at: 0, msg: "T(hi)" }]);
  });

  it("collects an image burst until the quiet window elapses", async () => {
    const batcher = createInboundBatcher({ imageWindowMs: 1500, process });
    batcher.push(image("1"));
    await vi.advanceTimersByTimeAsync(1000);
    batcher.push(image("2"));
    await vi.advanceTimersByTimeAsync(1499);
    expect(processed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(processed).toEqual([{ at: 2500, msg: "I(1) I(2)" }]);
  });

  it("flushes the image burst as soon as a text follows", async () => {
    const batcher = createInboundBatcher({ imageWindowMs: 1500, process });
    batcher.push(image("1"));
    batcher.push(image("2"));
    await vi.advanceTimersByTimeAsync(200);
    batcher.push(text("look"));
    expect(processed).toEqual([{ at: 200, msg: "T(look) I(1) I(2)" }]);
  });

  it("merges everything that arrives during a running turn, except commands", async () => {
    const onMerged = vi.fn();
    const batcher = createInboundBatcher({ imageWindowMs: 1500, process, onMerged });
    batcher.push(text("a"));
    batcher.push(file("report.pdf"));
    batcher.push(text("is this normal?"));
    batcher.push(text("/new"));
    batcher.push(text("c"));
    expect(processed.map((p) => p.msg)).toEqual(["T(a)"]);

    await finishTurn();
    expect(processed.map((p) => p.msg)).toEqual(["T(a)", "T(is this normal?) F(report.pdf)"]);
    expect(onMerged).toHaveBeenCalledWith({ from: "u1", count: 2, media: 1 });

    await finishTurn();
    expect(processed.map((p) => p.msg).slice(2)).toEqual(["T(/new)"]);
    await finishTurn();
    expect(processed.map((p) => p.msg).slice(3)).toEqual(["T(c)"]);
  });

  it.each([
    ["text then image", [text("what is this?"), image("1")]],
    ["image then text", [image("1"), text("what is this?")]],
  ])("folds %s received during a running turn into one follow-up", async (_, msgs) => {
    const batcher = createInboundBatcher({ imageWindowMs: 1500, process });
    batcher.push(text("a"));
    for (const msg of msgs) batcher.push(msg);

    await finishTurn();
    expect(processed.map((p) => p.msg)).toEqual(["T(a)", "T(what is this?) I(1)"]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(processed).toHaveLength(2);
  });

  it("does not move images ahead of a command queued before them", async () => {
    const batcher = createInboundBatcher({ imageWindowMs: 1500, process });
    batcher.push(text("a"));
    batcher.push(text("b"));
    batcher.push(text("/new"));
    batcher.push(image("1"));

    await finishTurn();
    expect(processed.map((p) => p.msg)).toEqual(["T(a)", "T(b)"]);
    await finishTurn();
    expect(processed.map((p) => p.msg).slice(2)).toEqual(["T(/new)"]);
    await finishTurn();
    await vi.advanceTimersByTimeAsync(1500);
    expect(processed.map((p) => p.msg).slice(3)).toEqual(["I(1)"]);
  });

  it("keeps senders independent", async () => {
    const batcher = createInboundBatcher({ imageWindowMs: 1500, process });
    batcher.push(text("a"));
    batcher.push({ ...text("b"), from_user_id: "u2" });
    expect(processed.map((p) => p.msg)).toEqual(["T(a)", "T(b)"]);
  });

  it("continues with the next turn after a processing error", async () => {
    const onError = vi.fn();
    const failing = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const batcher = createInboundBatcher({ imageWindowMs: 1500, process: failing, onError });
    batcher.push(text("a"));
    batcher.push(text("b"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledOnce();
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("flush() dispatches a pending image burst immediately", async () => {
    const batcher = createInboundBatcher({ imageWindowMs: 1500, process });
    batcher.push(image("1"));
    batcher.flush();
    expect(processed).toEqual([{ at: 0, msg: "I(1)" }]);
  });
});
