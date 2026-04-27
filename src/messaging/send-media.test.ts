import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { mockUploadFileToWeixin, mockUploadVideoToWeixin, mockUploadFileAttachmentToWeixin } = vi.hoisted(() => ({
  mockUploadFileToWeixin: vi.fn(),
  mockUploadVideoToWeixin: vi.fn(),
  mockUploadFileAttachmentToWeixin: vi.fn(),
}));

vi.mock("../cdn/upload.js", () => ({
  uploadFileToWeixin: mockUploadFileToWeixin,
  uploadVideoToWeixin: mockUploadVideoToWeixin,
  uploadFileAttachmentToWeixin: mockUploadFileAttachmentToWeixin,
}));

const { mockSendImageMessageWeixin, mockSendVideoMessageWeixin, mockSendFileMessageWeixin } = vi.hoisted(() => ({
  mockSendImageMessageWeixin: vi.fn(),
  mockSendVideoMessageWeixin: vi.fn(),
  mockSendFileMessageWeixin: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendImageMessageWeixin: mockSendImageMessageWeixin,
  sendVideoMessageWeixin: mockSendVideoMessageWeixin,
  sendFileMessageWeixin: mockSendFileMessageWeixin,
}));

import {
  sendWeixinMediaFile,
  __resetSendMediaDedupForTests,
  __sendMediaDedupSizeForTests,
} from "./send-media.js";

const baseParams = {
  to: "user1",
  text: "caption",
  opts: { baseUrl: "https://api.com", token: "tok", contextToken: "ctx" },
  cdnBaseUrl: "https://cdn.com",
};

const fakeUploaded = {
  filekey: "fk",
  downloadEncryptedQueryParam: "dp",
  aeskey: "abc",
  fileSize: 100,
  fileSizeCiphertext: 112,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  __resetSendMediaDedupForTests();
});

describe("sendWeixinMediaFile", () => {
  it("routes video/* to uploadVideoToWeixin + sendVideoMessageWeixin", async () => {
    mockUploadVideoToWeixin.mockResolvedValueOnce(fakeUploaded);
    mockSendVideoMessageWeixin.mockResolvedValueOnce({ messageId: "vid1" });
    const result = await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/clip.mp4" });
    expect(result.messageId).toBe("vid1");
    expect(mockUploadVideoToWeixin).toHaveBeenCalledOnce();
    expect(mockSendVideoMessageWeixin).toHaveBeenCalledOnce();
  });

  it("routes image/* to uploadFileToWeixin + sendImageMessageWeixin", async () => {
    mockUploadFileToWeixin.mockResolvedValueOnce(fakeUploaded);
    mockSendImageMessageWeixin.mockResolvedValueOnce({ messageId: "img1" });
    const result = await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/photo.png" });
    expect(result.messageId).toBe("img1");
    expect(mockUploadFileToWeixin).toHaveBeenCalledOnce();
    expect(mockSendImageMessageWeixin).toHaveBeenCalledOnce();
  });

  it("routes file attachments to uploadFileAttachmentToWeixin + sendFileMessageWeixin", async () => {
    mockUploadFileAttachmentToWeixin.mockResolvedValueOnce(fakeUploaded);
    mockSendFileMessageWeixin.mockResolvedValueOnce({ messageId: "file1" });
    const result = await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/doc.pdf" });
    expect(result.messageId).toBe("file1");
    expect(mockUploadFileAttachmentToWeixin).toHaveBeenCalledOnce();
    expect(mockSendFileMessageWeixin).toHaveBeenCalledWith({
      to: "user1",
      text: "caption",
      fileName: "doc.pdf",
      uploaded: fakeUploaded,
      opts: baseParams.opts,
    });
  });

  it("routes .webm as video", async () => {
    mockUploadVideoToWeixin.mockResolvedValueOnce(fakeUploaded);
    mockSendVideoMessageWeixin.mockResolvedValueOnce({ messageId: "v" });
    await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/clip.webm" });
    expect(mockUploadVideoToWeixin).toHaveBeenCalledOnce();
  });

  it("routes .gif as image", async () => {
    mockUploadFileToWeixin.mockResolvedValueOnce(fakeUploaded);
    mockSendImageMessageWeixin.mockResolvedValueOnce({ messageId: "i" });
    await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/anim.gif" });
    expect(mockUploadFileToWeixin).toHaveBeenCalledOnce();
  });

  it("routes unknown extension as file attachment", async () => {
    mockUploadFileAttachmentToWeixin.mockResolvedValueOnce(fakeUploaded);
    mockSendFileMessageWeixin.mockResolvedValueOnce({ messageId: "f" });
    await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/data.xyz" });
    expect(mockUploadFileAttachmentToWeixin).toHaveBeenCalledOnce();
  });
});

describe("sendWeixinMediaFile dedup (#74)", () => {
  it("second call within window short-circuits and returns the previous messageId", async () => {
    mockUploadFileToWeixin.mockResolvedValueOnce(fakeUploaded);
    mockSendImageMessageWeixin.mockResolvedValueOnce({ messageId: "img1" });

    const first = await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/photo.png" });
    expect(first.messageId).toBe("img1");

    const second = await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/photo.png" });
    expect(second.messageId).toBe("img1");

    // No second upload, no second send.
    expect(mockUploadFileToWeixin).toHaveBeenCalledOnce();
    expect(mockSendImageMessageWeixin).toHaveBeenCalledOnce();
  });

  it("calls outside the window both go through", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    mockUploadFileToWeixin.mockResolvedValue(fakeUploaded);
    mockSendImageMessageWeixin
      .mockResolvedValueOnce({ messageId: "img1" })
      .mockResolvedValueOnce({ messageId: "img2" });

    const first = await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/photo.png" });
    expect(first.messageId).toBe("img1");

    // Advance well past the 5s window.
    vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));

    const second = await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/photo.png" });
    expect(second.messageId).toBe("img2");
    expect(mockUploadFileToWeixin).toHaveBeenCalledTimes(2);
    expect(mockSendImageMessageWeixin).toHaveBeenCalledTimes(2);
  });

  it("different filePaths to the same recipient both go through", async () => {
    mockUploadFileToWeixin.mockResolvedValue(fakeUploaded);
    mockSendImageMessageWeixin
      .mockResolvedValueOnce({ messageId: "a" })
      .mockResolvedValueOnce({ messageId: "b" });

    await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/a.png" });
    await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/b.png" });

    expect(mockUploadFileToWeixin).toHaveBeenCalledTimes(2);
    expect(mockSendImageMessageWeixin).toHaveBeenCalledTimes(2);
  });

  it("same filePath to different recipients both go through", async () => {
    mockUploadFileToWeixin.mockResolvedValue(fakeUploaded);
    mockSendImageMessageWeixin
      .mockResolvedValueOnce({ messageId: "u1" })
      .mockResolvedValueOnce({ messageId: "u2" });

    await sendWeixinMediaFile({ ...baseParams, to: "user1", filePath: "/tmp/photo.png" });
    await sendWeixinMediaFile({ ...baseParams, to: "user2", filePath: "/tmp/photo.png" });

    expect(mockUploadFileToWeixin).toHaveBeenCalledTimes(2);
    expect(mockSendImageMessageWeixin).toHaveBeenCalledTimes(2);
  });

  it("dedup map garbage-collects stale entries past the threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    mockUploadFileToWeixin.mockResolvedValue(fakeUploaded);
    mockSendImageMessageWeixin.mockImplementation(async ({ to }: { to: string }) => ({
      messageId: `m-${to}`,
    }));

    // Fill the map past the GC threshold (100) with stale-by-construction entries.
    for (let i = 0; i < 101; i++) {
      await sendWeixinMediaFile({ ...baseParams, to: `user${i}`, filePath: "/tmp/p.png" });
    }
    expect(__sendMediaDedupSizeForTests()).toBe(101);

    // Advance beyond DEDUP_GC_MAX_AGE_MS (60s) so existing entries become stale.
    vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));

    // Next send triggers GC because size > threshold.
    await sendWeixinMediaFile({ ...baseParams, to: "newuser", filePath: "/tmp/p.png" });

    // After GC, only the freshly-recorded entry should remain.
    expect(__sendMediaDedupSizeForTests()).toBe(1);
  });

  it("dedups regardless of media type (file attachment branch)", async () => {
    mockUploadFileAttachmentToWeixin.mockResolvedValueOnce(fakeUploaded);
    mockSendFileMessageWeixin.mockResolvedValueOnce({ messageId: "file1" });

    const first = await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/doc.pdf" });
    const second = await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/doc.pdf" });

    expect(first.messageId).toBe("file1");
    expect(second.messageId).toBe("file1");
    expect(mockUploadFileAttachmentToWeixin).toHaveBeenCalledOnce();
    expect(mockSendFileMessageWeixin).toHaveBeenCalledOnce();
  });
});
