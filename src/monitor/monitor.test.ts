import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WeixinMessage } from "../api/types.js";
import { monitorWeixinProvider } from "./monitor.js";

const {
  mockGetUpdates,
  mockGetForUser,
  mockProcessOneMessage,
  mockWaitForWeixinRuntime,
  mockGetSyncBufFilePath,
  mockLoadGetUpdatesBuf,
  mockSaveGetUpdatesBuf,
  mockLogger,
} = vi.hoisted(() => ({
  mockGetUpdates: vi.fn(),
  mockGetForUser: vi.fn(),
  mockProcessOneMessage: vi.fn(),
  mockWaitForWeixinRuntime: vi.fn(),
  mockGetSyncBufFilePath: vi.fn(),
  mockLoadGetUpdatesBuf: vi.fn(),
  mockSaveGetUpdatesBuf: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../api/api.js", () => ({
  getUpdates: mockGetUpdates,
}));

vi.mock("../api/config-cache.js", () => ({
  WeixinConfigManager: vi.fn().mockImplementation(() => ({
    getForUser: mockGetForUser,
  })),
}));

vi.mock("../messaging/process-message.js", () => ({
  processOneMessage: mockProcessOneMessage,
}));

vi.mock("../runtime.js", () => ({
  getWeixinRuntime: vi.fn(),
  waitForWeixinRuntime: mockWaitForWeixinRuntime,
}));

vi.mock("../storage/sync-buf.js", () => ({
  getSyncBufFilePath: mockGetSyncBufFilePath,
  loadGetUpdatesBuf: mockLoadGetUpdatesBuf,
  saveGetUpdatesBuf: mockSaveGetUpdatesBuf,
}));

vi.mock("../util/logger.js", () => ({
  logger: {
    withAccount: vi.fn(() => mockLogger),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockWaitForWeixinRuntime.mockResolvedValue({ channel: {} });
  mockGetSyncBufFilePath.mockReturnValue("/tmp/openclaw-weixin-test-sync-buf");
  mockLoadGetUpdatesBuf.mockReturnValue("");
  mockGetForUser.mockResolvedValue({ typingTicket: "ticket-1" });
});

describe("monitorWeixinProvider", () => {
  it("continues polling while an inbound message is still being processed", async () => {
    const abortController = new AbortController();
    const inbound: WeixinMessage = {
      message_id: 1,
      from_user_id: "user-1",
      context_token: "ctx-1",
      item_list: [{ type: 1, text_item: { text: "hello" } }],
    };

    let releaseMessageProcessing!: () => void;
    const messageProcessing = new Promise<void>((resolve) => {
      releaseMessageProcessing = resolve;
    });
    mockProcessOneMessage.mockReturnValue(messageProcessing);

    let markSecondPollStarted!: () => void;
    const secondPollStarted = new Promise<void>((resolve) => {
      markSecondPollStarted = resolve;
    });

    mockGetUpdates
      .mockResolvedValueOnce({ ret: 0, get_updates_buf: "buf-1", msgs: [inbound] })
      .mockImplementationOnce(async () => {
        markSecondPollStarted();
        abortController.abort();
        return { ret: 0, get_updates_buf: "buf-2", msgs: [] };
      });

    const monitorPromise = monitorWeixinProvider({
      baseUrl: "https://api.example.test",
      cdnBaseUrl: "https://cdn.example.test",
      accountId: "acct-1",
      config: {} as Parameters<typeof monitorWeixinProvider>[0]["config"],
      abortSignal: abortController.signal,
    });

    await secondPollStarted;

    expect(mockGetUpdates).toHaveBeenCalledTimes(2);
    expect(mockProcessOneMessage).toHaveBeenCalledTimes(1);

    let processed = false;
    void messageProcessing.then(() => {
      processed = true;
    });
    await Promise.resolve();
    expect(processed).toBe(false);

    releaseMessageProcessing();
    await monitorPromise;
    await messageProcessing;
  });
});
