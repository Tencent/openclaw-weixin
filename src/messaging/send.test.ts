import { beforeEach, describe, expect, it, vi } from "vitest";

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
  stripMarkdown: (text: string) =>
    text
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^[*-]\s+/gm, "")
      .replace(/^\d+\.\s+/gm, ""),
}));

import { MessageItemType } from "../api/types.js";
import type { UploadedFileInfo } from "../cdn/upload.js";
import {
  sendFileMessageWeixin,
  sendImageMessageWeixin,
  sendMessageItemWeixin,
  sendMessageWeixin,
  sendVideoMessageWeixin,
} from "./send.js";

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) so queued mock*Once values from a
  // previous test that never called the mock don't leak into the next test.
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(1700000000000);
});

describe("sendMessageWeixin", () => {
  it("refuses to send without contextToken (throws)", async () => {
    await expect(
      sendMessageWeixin({
        to: "user1",
        text: "hello",
        opts: { baseUrl: "https://api.com" },
      }),
    ).rejects.toThrow(/contextToken missing/);
    expect(mockSendMessageApi).not.toHaveBeenCalled();
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

  it("includes run_id when provided", async () => {
    mockSendMessageApi.mockResolvedValueOnce(undefined);
    await sendMessageWeixin({
      to: "user1",
      text: "hello",
      opts: { baseUrl: "https://api.com", contextToken: "ctx", runId: "run-1" },
    });
    const callArgs = mockSendMessageApi.mock.calls[0][0];
    expect(callArgs.body.msg.run_id).toBe("run-1");
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

describe("sendMessageItemWeixin", () => {
  it("sends structured message item with run_id", async () => {
    mockSendMessageApi.mockResolvedValueOnce(undefined);
    await sendMessageItemWeixin({
      to: "user1",
      item: {
        type: MessageItemType.TOOL_CALL_START,
        is_completed: false,
        tool_call_start_item: {
          tool_name: "read",
          tool_call_id: "tool:call-1",
        },
      },
      opts: { baseUrl: "https://api.com", contextToken: "ctx", runId: "run-1" },
    });
    const callArgs = mockSendMessageApi.mock.calls[0][0];
    expect(callArgs.body.msg.run_id).toBe("run-1");
    expect(callArgs.body.msg.item_list).toEqual([
      {
        type: MessageItemType.TOOL_CALL_START,
        is_completed: false,
        tool_call_start_item: {
          tool_name: "read",
          tool_call_id: "tool:call-1",
        },
      },
    ]);
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
  it("refuses to send without contextToken (throws)", async () => {
    await expect(
      sendImageMessageWeixin({
        to: "u",
        text: "",
        uploaded: makeUploadedFileInfo(),
        opts: { baseUrl: "https://api.com" },
      }),
    ).rejects.toThrow(/contextToken missing/);
    expect(mockSendMessageApi).not.toHaveBeenCalled();
  });

  it("sends image caption before the media item", async () => {
    mockSendMessageApi.mockResolvedValue(undefined);
    const result = await sendImageMessageWeixin({
      to: "user1",
      text: "caption",
      uploaded: makeUploadedFileInfo(),
      opts: { baseUrl: "https://api.com", contextToken: "ctx" },
    });
    expect(result.messageId).toBeDefined();
    expect(mockSendMessageApi).toHaveBeenCalledTimes(2);
  });

  it("includes run_id on media caption and item sends", async () => {
    mockSendMessageApi.mockResolvedValue(undefined);
    await sendImageMessageWeixin({
      to: "user1",
      text: "caption",
      uploaded: makeUploadedFileInfo(),
      opts: { baseUrl: "https://api.com", contextToken: "ctx", runId: "run-media" },
    });
    expect(mockSendMessageApi).toHaveBeenCalledTimes(2);
    expect(mockSendMessageApi.mock.calls[0][0].body.msg.run_id).toBe("run-media");
    expect(mockSendMessageApi.mock.calls[1][0].body.msg.run_id).toBe("run-media");
  });

  it("sends image message without caption (single call)", async () => {
    mockSendMessageApi.mockResolvedValue(undefined);
    const result = await sendImageMessageWeixin({
      to: "user1",
      text: "",
      uploaded: makeUploadedFileInfo(),
      opts: { baseUrl: "https://api.com", contextToken: "ctx" },
    });
    expect(result.messageId).toBeDefined();
    expect(mockSendMessageApi).toHaveBeenCalledTimes(1);
  });

  it("re-throws error from sendMediaItems on API failure", async () => {
    mockSendMessageApi.mockRejectedValueOnce(new Error("cdn fail"));
    await expect(
      sendImageMessageWeixin({
        to: "user1",
        text: "",
        uploaded: makeUploadedFileInfo(),
        opts: { baseUrl: "https://api.com", contextToken: "ctx" },
      }),
    ).rejects.toThrow("cdn fail");
  });
});

describe("sendVideoMessageWeixin", () => {
  it("refuses to send without contextToken (throws)", async () => {
    await expect(
      sendVideoMessageWeixin({
        to: "u",
        text: "",
        uploaded: makeUploadedFileInfo(),
        opts: { baseUrl: "https://api.com" },
      }),
    ).rejects.toThrow(/contextToken missing/);
    expect(mockSendMessageApi).not.toHaveBeenCalled();
  });

  it("sends video message", async () => {
    mockSendMessageApi.mockResolvedValue(undefined);
    const result = await sendVideoMessageWeixin({
      to: "user1",
      text: "",
      uploaded: makeUploadedFileInfo(),
      opts: { baseUrl: "https://api.com", contextToken: "ctx" },
    });
    expect(result.messageId).toBeDefined();
  });

  it("uses the ciphertext size in the video payload", async () => {
    mockSendMessageApi.mockResolvedValue(undefined);
    await sendVideoMessageWeixin({
      to: "user1",
      text: "",
      uploaded: makeUploadedFileInfo({ fileSizeCiphertext: 2048 }),
      opts: { baseUrl: "https://api.com", contextToken: "ctx" },
    });
    expect(mockSendMessageApi.mock.calls[0][0].body.msg.item_list[0].video_item?.video_size).toBe(2048);
  });
});

describe("sendFileMessageWeixin", () => {
  it("refuses to send without contextToken (throws)", async () => {
    await expect(
      sendFileMessageWeixin({
        to: "u",
        text: "",
        fileName: "file.pdf",
        uploaded: makeUploadedFileInfo(),
        opts: { baseUrl: "https://api.com" },
      }),
    ).rejects.toThrow(/contextToken missing/);
    expect(mockSendMessageApi).not.toHaveBeenCalled();
  });

  it("sends file message", async () => {
    mockSendMessageApi.mockResolvedValue(undefined);
    const result = await sendFileMessageWeixin({
      to: "user1",
      text: "see attached",
      fileName: "doc.pdf",
      uploaded: makeUploadedFileInfo(),
      opts: { baseUrl: "https://api.com", contextToken: "ctx" },
    });
    expect(result.messageId).toBeDefined();
    expect(mockSendMessageApi).toHaveBeenCalledTimes(2);
  });
});

describe("missing contextToken refuses to send (silent-drop fix, upstream #247)", () => {
  const FULL_ID = "o9cq806PLhqoC5-fjuN63zCyAInQ@im.wechat";

  it("sendMessageWeixin throws and does not call the backend", async () => {
    await expect(sendMessageWeixin({ to: FULL_ID, text: "hi", opts: { baseUrl: "https://api.com" } })).rejects.toThrow(
      /contextToken missing/,
    );
    expect(mockSendMessageApi).not.toHaveBeenCalled();
  });

  it("sendMessageItemWeixin throws and does not call the backend", async () => {
    await expect(
      sendMessageItemWeixin({
        to: FULL_ID,
        item: {
          type: MessageItemType.TOOL_CALL_START,
          is_completed: false,
          tool_call_start_item: { tool_name: "read", tool_call_id: "tool:call-1" },
        },
        opts: { baseUrl: "https://api.com" },
      }),
    ).rejects.toThrow(/contextToken missing/);
    expect(mockSendMessageApi).not.toHaveBeenCalled();
  });

  it("sendImageMessageWeixin throws and does not call the backend", async () => {
    await expect(
      sendImageMessageWeixin({
        to: FULL_ID,
        text: "",
        uploaded: makeUploadedFileInfo(),
        opts: { baseUrl: "https://api.com" },
      }),
    ).rejects.toThrow(/contextToken missing/);
    expect(mockSendMessageApi).not.toHaveBeenCalled();
  });

  it("sendVideoMessageWeixin throws and does not call the backend", async () => {
    await expect(
      sendVideoMessageWeixin({
        to: FULL_ID,
        text: "",
        uploaded: makeUploadedFileInfo(),
        opts: { baseUrl: "https://api.com" },
      }),
    ).rejects.toThrow(/contextToken missing/);
    expect(mockSendMessageApi).not.toHaveBeenCalled();
  });

  it("sendFileMessageWeixin throws and does not call the backend", async () => {
    await expect(
      sendFileMessageWeixin({
        to: FULL_ID,
        text: "",
        fileName: "f.pdf",
        uploaded: makeUploadedFileInfo(),
        opts: { baseUrl: "https://api.com" },
      }),
    ).rejects.toThrow(/contextToken missing/);
    expect(mockSendMessageApi).not.toHaveBeenCalled();
  });

  it("does not leak the full recipient id in the thrown error (privacy)", async () => {
    let thrown: unknown;
    try {
      await sendMessageWeixin({ to: FULL_ID, text: "hi", opts: { baseUrl: "https://api.com" } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    // the recipient peer id must never appear verbatim in the error surface
    expect(msg).not.toContain(FULL_ID);
    expect(msg).toMatch(/contextToken missing/);
  });

  it("counterexample: a valid contextToken sends successfully", async () => {
    mockSendMessageApi.mockResolvedValueOnce(undefined);
    const result = await sendMessageWeixin({
      to: "user1",
      text: "hi",
      opts: { baseUrl: "https://api.com", contextToken: "ctx" },
    });
    expect(result.messageId).toBeDefined();
    expect(mockSendMessageApi).toHaveBeenCalledOnce();
  });
});
