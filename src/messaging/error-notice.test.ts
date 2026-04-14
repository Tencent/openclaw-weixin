import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { mockSendMessageWeixin } = vi.hoisted(() => ({
  mockSendMessageWeixin: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageWeixin: mockSendMessageWeixin,
}));

import { sendWeixinErrorNotice } from "./error-notice.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendWeixinErrorNotice", () => {
  it("sends error message when contextToken is provided", async () => {
    mockSendMessageWeixin.mockResolvedValueOnce({ messageId: "m1" });
    await sendWeixinErrorNotice({
      to: "user1",
      contextToken: "ctx-tok",
      message: "Something went wrong",
      baseUrl: "https://api.com",
      token: "tok",
      errLog: vi.fn(),
    });
    expect(mockSendMessageWeixin).toHaveBeenCalledOnce();
    expect(mockSendMessageWeixin).toHaveBeenCalledWith({
      to: "user1",
      text: "Something went wrong",
      opts: { baseUrl: "https://api.com", token: "tok", contextToken: "ctx-tok" },
    });
  });

  it("sends even when contextToken is undefined", async () => {
    mockSendMessageWeixin.mockResolvedValueOnce({ messageId: "m2" });
    await sendWeixinErrorNotice({
      to: "user1",
      contextToken: undefined,
      message: "err",
      baseUrl: "https://api.com",
      errLog: vi.fn(),
    });
    expect(mockSendMessageWeixin).toHaveBeenCalledOnce();
  });

  it("catches and logs errors from sendMessageWeixin", async () => {
    mockSendMessageWeixin.mockRejectedValueOnce(new Error("send failed"));
    const errLog = vi.fn();
    await sendWeixinErrorNotice({
      to: "user1",
      contextToken: "ctx",
      message: "err msg",
      baseUrl: "https://api.com",
      errLog,
    });
    // Should not throw
    expect(errLog).toHaveBeenCalledWith(
      expect.stringContaining("sendWeixinErrorNotice failed"),
    );
  });
});
