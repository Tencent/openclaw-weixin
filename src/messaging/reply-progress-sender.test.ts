import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSendMessageItemWeixin } = vi.hoisted(() => ({
  mockSendMessageItemWeixin: vi.fn(),
}));

vi.mock("../util/logger.js", () => ({
  logger: {
    warn: vi.fn(),
  },
}));

vi.mock("./send.js", () => ({
  sendMessageItemWeixin: mockSendMessageItemWeixin,
}));

import { MessageItemType } from "../api/types.js";

import { WeixinReplyProgressSender } from "./reply-progress-sender.js";

describe("WeixinReplyProgressSender", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessageItemWeixin.mockResolvedValue({ messageId: "msg-1" });
  });

  it("sends tool start and result messages from item lifecycle events", async () => {
    const sender = new WeixinReplyProgressSender({
      runId: "run-1",
      to: "user-1",
      accountId: "account-1",
      opts: { baseUrl: "https://api.example.com", contextToken: "ctx-1" },
    });

    vi.spyOn(Date, "now").mockReturnValueOnce(1700000000000).mockReturnValueOnce(1700000000100);

    sender.replyOptions.onItemEvent({
      itemId: "tool:call-1",
      kind: "tool",
      name: "read",
      phase: "start",
      status: "running",
      summary: "should not be sent",
      progressText: "should not be sent",
    });
    sender.replyOptions.onItemEvent({
      itemId: "tool:call-1",
      kind: "tool",
      name: "read",
      phase: "end",
      status: "completed",
      summary: "should not be sent",
    });

    await sender.finalize();

    expect(mockSendMessageItemWeixin).toHaveBeenCalledTimes(2);
    expect(mockSendMessageItemWeixin.mock.calls[0][0].item).toEqual({
      type: MessageItemType.TOOL_CALL_START,
      create_time_ms: 1700000000000,
      is_completed: false,
      tool_call_start_item: {
        tool_name: "read",
        tool_call_id: "tool:call-1",
      },
    });
    expect(mockSendMessageItemWeixin.mock.calls[1][0].item).toEqual({
      type: MessageItemType.TOOL_CALL_RESULT,
      create_time_ms: 1700000000100,
      is_completed: true,
      tool_call_result_item: {
        tool_name: "read",
        tool_call_id: "tool:call-1",
        status: "completed",
      },
    });
    expect(mockSendMessageItemWeixin.mock.calls[0][0].opts.runId).toBe("run-1");
  });

  it("normalizes non-completed tool end statuses", async () => {
    const sender = new WeixinReplyProgressSender({
      runId: "run-1",
      to: "user-1",
      accountId: "account-1",
      opts: { baseUrl: "https://api.example.com" },
    });

    vi.spyOn(Date, "now").mockReturnValue(1700000000000);

    sender.replyOptions.onItemEvent({
      itemId: "tool:call-2",
      kind: "tool",
      title: "unknown tool",
      phase: "end",
      status: "failed",
    });

    await sender.finalize();

    expect(mockSendMessageItemWeixin).toHaveBeenCalledOnce();
    expect(mockSendMessageItemWeixin.mock.calls[0][0].item).toMatchObject({
      type: MessageItemType.TOOL_CALL_RESULT,
      tool_call_result_item: {
        tool_name: "unknown tool",
        tool_call_id: "tool:call-2",
        status: "failed",
      },
    });
  });
});
