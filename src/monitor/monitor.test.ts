import { describe, it, expect, vi, beforeEach } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  resolveWeixinChannelRuntime: vi.fn(),
  waitForWeixinRuntime: vi.fn(),
}));

vi.mock("../runtime.js", () => ({
  resolveWeixinChannelRuntime: runtimeMocks.resolveWeixinChannelRuntime,
  waitForWeixinRuntime: runtimeMocks.waitForWeixinRuntime,
}));

vi.mock("../api/api.js", () => ({
  getUpdates: vi.fn(),
}));

vi.mock("../api/config-cache.js", () => ({
  WeixinConfigManager: vi.fn(),
}));

vi.mock("../api/session-guard.js", () => ({
  SESSION_EXPIRED_ERRCODE: -1,
  pauseSession: vi.fn(),
  getRemainingPauseMs: vi.fn(() => 0),
}));

vi.mock("../messaging/process-message.js", () => ({
  processOneMessage: vi.fn(),
}));

vi.mock("../storage/sync-buf.js", () => ({
  getSyncBufFilePath: vi.fn(() => "/tmp/openclaw-weixin-test-sync-buf"),
  loadGetUpdatesBuf: vi.fn(() => ""),
  saveGetUpdatesBuf: vi.fn(),
}));

vi.mock("../util/logger.js", () => ({
  logger: {
    withAccount: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

import { monitorWeixinProvider } from "./monitor.js";

beforeEach(() => {
  vi.clearAllMocks();
  runtimeMocks.resolveWeixinChannelRuntime.mockResolvedValue({ commands: {} });
  runtimeMocks.waitForWeixinRuntime.mockRejectedValue(new Error("global runtime unavailable"));
});

describe("monitorWeixinProvider", () => {
  it("uses injected channelRuntime instead of waiting for the global runtime", async () => {
    const channelRuntime = { commands: {} };
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      monitorWeixinProvider({
        baseUrl: "https://api.example.com",
        cdnBaseUrl: "https://cdn.example.com",
        accountId: "acct",
        config: {} as never,
        abortSignal: abortController.signal,
        channelRuntime: channelRuntime as never,
      }),
    ).resolves.toBeUndefined();

    expect(runtimeMocks.resolveWeixinChannelRuntime).toHaveBeenCalledWith({
      channelRuntime,
      waitTimeoutMs: 30_000,
    });
    expect(runtimeMocks.waitForWeixinRuntime).not.toHaveBeenCalled();
  });
});
