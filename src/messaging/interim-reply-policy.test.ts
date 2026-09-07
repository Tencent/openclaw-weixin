import { describe, expect, it } from "vitest";

import { isInterimTextOnlyWeixinReply } from "./interim-reply-policy.js";

describe("isInterimTextOnlyWeixinReply", () => {
  it("skips block-streamed commentary text (interim narration between tool calls)", () => {
    expect(
      isInterimTextOnlyWeixinReply({ text: "我先查一下你的订单状态" }, { kind: "block" }),
    ).toBe(true);
  });

  it("keeps the final reply text", () => {
    expect(isInterimTextOnlyWeixinReply({ text: "这是最终回复" }, { kind: "final" })).toBe(false);
  });

  it("keeps every final payload when the reply is split across multiple messages", () => {
    expect(isInterimTextOnlyWeixinReply({ text: "第一条" }, { kind: "final" })).toBe(false);
    expect(isInterimTextOnlyWeixinReply({ text: "第二条" }, { kind: "final" })).toBe(false);
  });

  it("keeps tool-summary text (tool output is never re-merged into the final reply)", () => {
    expect(isInterimTextOnlyWeixinReply({ text: "查询到订单 3 条" }, { kind: "tool" })).toBe(false);
  });

  it("keeps interim payloads that carry media alongside text", () => {
    expect(
      isInterimTextOnlyWeixinReply(
        { text: "图片如下", mediaUrl: "https://example.com/a.png" },
        { kind: "block" },
      ),
    ).toBe(false);
    expect(
      isInterimTextOnlyWeixinReply(
        { text: "多图如下", mediaUrls: ["https://example.com/a.png"] },
        { kind: "tool" },
      ),
    ).toBe(false);
  });

  it("keeps interim payloads that carry a command-execution approval prompt", () => {
    expect(
      isInterimTextOnlyWeixinReply(
        { text: "是否允许执行 rm -rf / ?", channelData: { execApproval: {} } },
        { kind: "block" },
      ),
    ).toBe(false);
  });

  it("keeps interim error payloads so failures are not silently dropped", () => {
    expect(
      isInterimTextOnlyWeixinReply({ text: "工具调用失败", isError: true }, { kind: "block" }),
    ).toBe(false);
  });

  it("keeps payloads whose delivery kind is unknown (defensive: legacy host)", () => {
    expect(isInterimTextOnlyWeixinReply({ text: "不确定来源" }, undefined)).toBe(false);
    expect(isInterimTextOnlyWeixinReply({ text: "不确定来源" })).toBe(false);
  });

  it("keeps empty and media-only interim payloads", () => {
    expect(isInterimTextOnlyWeixinReply({}, { kind: "block" })).toBe(false);
    expect(
      isInterimTextOnlyWeixinReply({ mediaUrl: "https://example.com/a.png" }, { kind: "block" }),
    ).toBe(false);
  });
});
