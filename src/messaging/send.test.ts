import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { mockSendMessageApi } = vi.hoisted(() => ({
  mockSendMessageApi: vi.fn(),
}));

vi.mock("../api/api.js", () => ({
  sendMessage: mockSendMessageApi,
}));

vi.mock("node:crypto", () => ({
  default: {
    randomBytes: vi.fn(() => Buffer.from("deadbeef", "hex")),
  },
}));

vi.mock("openclaw/plugin-sdk", () => ({
  stripMarkdown: (text: string) => text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[*-]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, ""),
}));

import {
  sendMessageWeixin,
  sendImageMessageWeixin,
  sendVideoMessageWeixin,
  sendFileMessageWeixin,
} from "./send.js";
import type { UploadedFileInfo } from "../cdn/upload.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(1700000000000);
});

describe("sendMessageWeixin", () => {
  it("sends without contextToken (no throw)", async () => {
    mockSendMessageApi.mockResolvedValueOnce(undefined);
    const result = await sendMessageWeixin({
      to: "user1", text: "hello", opts: { baseUrl: "https://api.com" },
    });
    expect(result.messageId).toBeDefined();
  });

  it("sends text message successfully", async () => {
    mockSendMessageApi.mockResolvedValueOnce(undefined);
    const result = await sendMessageWeixin({
      to: "user1",
      text: "hello",
      opts: { baseUrl: "https://api.com", token: "tok", contextToken: "ctx" },
    });
    expect(result.messageId).toBeDefined();
    expect(mockSendMessageApi).toHaveBeenCalledOnce();
    const callArgs = mockSendMessageApi.mock.calls[0][0];
    expect(callArgs.body.msg.to_user_id).toBe("user1");
    expect(callArgs.body.msg.context_token).toBe("ctx");
  });

  it("sends message with empty text (no item_list)", async () => {
    mockSendMessageApi.mockResolvedValueOnce(undefined);
    const result = await sendMessageWeixin({
      to: "user1",
      text: "",
      opts: { baseUrl: "https://api.com", contextToken: "ctx" },
    });
    expect(result.messageId).toBeDefined();
    const callArgs = mockSendMessageApi.mock.calls[0][0];
    expect(callArgs.body.msg.item_list).toBeUndefined();
  });

  it("re-throws API errors", async () => {
    mockSendMessageApi.mockRejectedValueOnce(new Error("api fail"));
    await expect(
      sendMessageWeixin({
        to: "user1",
        text: "hello",
        opts: { baseUrl: "https://api.com", contextToken: "ctx" },
      }),
    ).rejects.toThrow("api fail");
  });
});

function makeUploadedFileInfo(overrides?: Partial<UploadedFileInfo>): UploadedFileInfo {
  return {
    filekey: "fk",
    downloadEncryptedQueryParam: "param",
    aeskey: "0123456789abcdef0123456789abcdef",
    fileSize: 1024,
    fileSizeCiphertext: 1040,
    ...overrides,
  };
}

describe("sendImageMessageWeixin", () => {
  it("sends without contextToken (no throw)", async () => {
    mockSendMessageApi.mockResolvedValueOnce(undefined);
    const result = await sendImageMessageWeixin({
      to: "u", text: "", uploaded: makeUploadedFileInfo(),
      opts: { baseUrl: "https://api.com" },
    });
    expect(result.messageId).toBeDefined();
  });

  it("sends image message with thumbnail", async () => {
    mockSendMessageApi.mockResolvedValue(undefined);
    const uploaded = makeUploadedFileInfo({
      imageWidth: 800,
      imageHeight: 600,
      thumb: {
        filekey: "fk",
        downloadEncryptedQueryParam: "tp",
        aeskey: "0123456789abcdef0123456789abcdef",
        fileSize: 200,
        fileSizeCiphertext: 208,
        width: 300,
        height: 225,
      },
    });
    const result = await sendImageMessageWeixin({
      to: "user1", text: "caption", uploaded,
      opts: { baseUrl: "https://api.com", contextToken: "ctx" },
    });
    expect(result.messageId).toBeDefined();
    expect(mockSendMessageApi).toHaveBeenCalledTimes(2);
  });

  it("sends image message without caption (single call)", async () => {
    mockSendMessageApi.mockResolvedValue(undefined);
    const result = await sendImageMessageWeixin({
      to: "user1", text: "", uploaded: makeUploadedFileInfo(),
      opts: { baseUrl: "https://api.com", contextToken: "ctx" },
    });
    expect(result.messageId).toBeDefined();
    expect(mockSendMessageApi).toHaveBeenCalledTimes(1);
  });

  it("re-throws error from sendMediaItems on API failure", async () => {
    mockSendMessageApi.mockRejectedValueOnce(new Error("cdn fail"));
    await expect(
      sendImageMessageWeixin({
        to: "user1", text: "", uploaded: makeUploadedFileInfo(),
        opts: { baseUrl: "https://api.com", contextToken: "ctx" },
      }),
    ).rejects.toThrow("cdn fail");
  });
});

describe("sendVideoMessageWeixin", () => {
  it("sends without contextToken (no throw)", async () => {
    mockSendMessageApi.mockResolvedValueOnce(undefined);
    const result = await sendVideoMessageWeixin({
      to: "u", text: "", uploaded: makeUploadedFileInfo(),
      opts: { baseUrl: "https://api.com" },
    });
    expect(result.messageId).toBeDefined();
  });

  it("sends video message", async () => {
    mockSendMessageApi.mockResolvedValue(undefined);
    const result = await sendVideoMessageWeixin({
      to: "user1", text: "", uploaded: makeUploadedFileInfo({ playLength: 30 }),
      opts: { baseUrl: "https://api.com", contextToken: "ctx" },
    });
    expect(result.messageId).toBeDefined();
  });

  it("sends video message with thumbnail", async () => {
    mockSendMessageApi.mockResolvedValue(undefined);
    const uploaded = makeUploadedFileInfo({
      playLength: 30,
      thumb: {
        filekey: "fk",
        downloadEncryptedQueryParam: "tp",
        aeskey: "0123456789abcdef0123456789abcdef",
        fileSize: 200,
        fileSizeCiphertext: 208,
        width: 300,
        height: 225,
      },
    });
    const result = await sendVideoMessageWeixin({
      to: "user1", text: "", uploaded,
      opts: { baseUrl: "https://api.com", contextToken: "ctx" },
    });
    expect(result.messageId).toBeDefined();
  });
});

describe("sendFileMessageWeixin", () => {
  it("sends without contextToken (no throw)", async () => {
    mockSendMessageApi.mockResolvedValueOnce(undefined);
    const result = await sendFileMessageWeixin({
      to: "u", text: "", fileName: "file.pdf", uploaded: makeUploadedFileInfo(),
      opts: { baseUrl: "https://api.com" },
    });
    expect(result.messageId).toBeDefined();
  });

  it("sends file message", async () => {
    mockSendMessageApi.mockResolvedValue(undefined);
    const result = await sendFileMessageWeixin({
      to: "user1", text: "see attached", fileName: "doc.pdf", uploaded: makeUploadedFileInfo(),
      opts: { baseUrl: "https://api.com", contextToken: "ctx" },
    });
    expect(result.messageId).toBeDefined();
    expect(mockSendMessageApi).toHaveBeenCalledTimes(2);
  });
});
