import { describe, it, expect, vi, beforeEach } from "vitest";

import { handleSlashCommand } from "./slash-commands.js";
import type { SlashCommandContext } from "./slash-commands.js";
import { isDebugMode, _resetForTest as resetDebugMode } from "./debug-mode.js";

const mockSendMessageWeixin = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: "test-id" }));

vi.mock("./send.js", () => ({
  sendMessageWeixin: mockSendMessageWeixin,
}));

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("handleSlashCommand", () => {
  let ctx: SlashCommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDebugMode();
    ctx = {
      to: "user123",
      contextToken: "token123",
      baseUrl: "https://api.example.com",
      token: "bot-token",
      accountId: "acc1",
      log: vi.fn(),
      errLog: vi.fn(),
    };
  });

  it("returns handled=false for non-slash messages", async () => {
    const result = await handleSlashCommand("hello world", ctx, Date.now());
    expect(result.handled).toBe(false);
    expect(mockSendMessageWeixin).not.toHaveBeenCalled();
  });

  it("returns handled=false for unknown slash commands", async () => {
    const result = await handleSlashCommand("/unknown arg", ctx, Date.now());
    expect(result.handled).toBe(false);
    expect(mockSendMessageWeixin).not.toHaveBeenCalled();
  });

  it("handles /echo with message and timing", async () => {
    const receivedAt = Date.now();
    const eventTimestamp = receivedAt - 100;
    const result = await handleSlashCommand("/echo hello", ctx, receivedAt, eventTimestamp);

    expect(result.handled).toBe(true);
    expect(mockSendMessageWeixin).toHaveBeenCalledTimes(2);

    const firstCall = mockSendMessageWeixin.mock.calls[0][0];
    expect(firstCall.to).toBe("user123");
    expect(firstCall.text).toBe("hello");
    expect(firstCall.opts.contextToken).toBe("token123");

    const secondCall = mockSendMessageWeixin.mock.calls[1][0];
    expect(secondCall.text).toContain("⏱ 通道耗时");
    expect(secondCall.text).toContain("平台→插件");
  });

  it("handles /echo without message (timing only)", async () => {
    const receivedAt = Date.now();
    const result = await handleSlashCommand("/echo", ctx, receivedAt);

    expect(result.handled).toBe(true);
    expect(mockSendMessageWeixin).toHaveBeenCalledTimes(1);

    const call = mockSendMessageWeixin.mock.calls[0][0];
    expect(call.text).toContain("⏱ 通道耗时");
  });

  it("handles /echo case-insensitively", async () => {
    const result = await handleSlashCommand("/ECHO test", ctx, Date.now());
    expect(result.handled).toBe(true);
    expect(mockSendMessageWeixin).toHaveBeenCalledTimes(2);
  });

  it("shows N/A when eventTimestamp is not provided", async () => {
    const result = await handleSlashCommand("/echo", ctx, Date.now());

    expect(result.handled).toBe(true);
    const call = mockSendMessageWeixin.mock.calls[0][0];
    expect(call.text).toContain("N/A");
  });

  it("sends error message when command execution fails", async () => {
    mockSendMessageWeixin.mockRejectedValueOnce(new Error("network error"));

    const result = await handleSlashCommand("/echo hello", ctx, Date.now());

    expect(result.handled).toBe(true);
    expect(mockSendMessageWeixin).toHaveBeenCalledTimes(2);
    const errorCall = mockSendMessageWeixin.mock.calls[1][0];
    expect(errorCall.text).toContain("❌ 指令执行失败");
  });

  it("handles error when sending error message also fails", async () => {
    mockSendMessageWeixin.mockRejectedValue(new Error("network error"));

    const result = await handleSlashCommand("/echo hello", ctx, Date.now());

    expect(result.handled).toBe(true);
  });

  it("trims whitespace from content", async () => {
    const result = await handleSlashCommand("  /echo hello  ", ctx, Date.now());
    expect(result.handled).toBe(true);
  });

  it("/toggle-debug enables debug mode and replies", async () => {
    const result = await handleSlashCommand("/toggle-debug", ctx, Date.now());
    expect(result.handled).toBe(true);
    expect(isDebugMode("acc1")).toBe(true);

    const call = mockSendMessageWeixin.mock.calls[0][0];
    expect(call.text).toContain("Debug 模式已开启");
  });

  it("/toggle-debug disables debug mode when already on", async () => {
    await handleSlashCommand("/toggle-debug", ctx, Date.now());
    mockSendMessageWeixin.mockClear();

    const result = await handleSlashCommand("/toggle-debug", ctx, Date.now());
    expect(result.handled).toBe(true);
    expect(isDebugMode("acc1")).toBe(false);

    const call = mockSendMessageWeixin.mock.calls[0][0];
    expect(call.text).toContain("Debug 模式已关闭");
  });

  it("/toggle-debug is case-insensitive", async () => {
    const result = await handleSlashCommand("/TOGGLE-DEBUG", ctx, Date.now());
    expect(result.handled).toBe(true);
    expect(isDebugMode("acc1")).toBe(true);
  });
});
