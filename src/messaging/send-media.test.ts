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

describe("sendWeixinMediaFile dedup — remote URL edge case (#74, reviewer Re-Ch-X)", () => {
  /**
   * When the LLM passes a remote HTTP URL as mediaURL, both duplicate calls
   * download it to *different* ephemeral temp paths. If we key the dedup on
   * filePath alone, the two temp paths never match and the duplicate goes
   * through. The fix: callers pass `sourceUrl` (the original remote URL) and
   * we key on that instead.
   */
  it("two calls with the same sourceUrl but different temp filePaths are deduped", async () => {
    mockUploadFileToWeixin.mockResolvedValueOnce(fakeUploaded);
    mockSendImageMessageWeixin.mockResolvedValueOnce({ messageId: "img-remote-1" });

    const sourceUrl = "https://example.com/images/cat.jpg";

    // First call: downloaded to /tmp/abc123.jpg
    const first = await sendWeixinMediaFile({
      ...baseParams,
      filePath: "/tmp/abc123.jpg",
      sourceUrl,
    });
    expect(first.messageId).toBe("img-remote-1");

    // Second call (duplicate): downloaded to a *different* temp path
    const second = await sendWeixinMediaFile({
      ...baseParams,
      filePath: "/tmp/def456.jpg", // different path!
      sourceUrl,                   // same source URL → should dedup
    });
    expect(second.messageId).toBe("img-remote-1");

    // Upload/send must have happened exactly once.
    expect(mockUploadFileToWeixin).toHaveBeenCalledOnce();
    expect(mockSendImageMessageWeixin).toHaveBeenCalledOnce();
  });

  it("two calls with different sourceUrls both go through even within the window", async () => {
    mockUploadFileToWeixin.mockResolvedValue(fakeUploaded);
    mockSendImageMessageWeixin
      .mockResolvedValueOnce({ messageId: "img-A" })
      .mockResolvedValueOnce({ messageId: "img-B" });

    await sendWeixinMediaFile({
      ...baseParams,
      filePath: "/tmp/tmp1.jpg",
      sourceUrl: "https://example.com/a.jpg",
    });
    await sendWeixinMediaFile({
      ...baseParams,
      filePath: "/tmp/tmp2.jpg",
      sourceUrl: "https://example.com/b.jpg",
    });

    expect(mockUploadFileToWeixin).toHaveBeenCalledTimes(2);
    expect(mockSendImageMessageWeixin).toHaveBeenCalledTimes(2);
  });

  it("same sourceUrl to different recipients both go through", async () => {
    mockUploadFileToWeixin.mockResolvedValue(fakeUploaded);
    mockSendImageMessageWeixin
      .mockResolvedValueOnce({ messageId: "u1" })
      .mockResolvedValueOnce({ messageId: "u2" });

    const sourceUrl = "https://example.com/shared.jpg";
    await sendWeixinMediaFile({ ...baseParams, to: "user1", filePath: "/tmp/t1.jpg", sourceUrl });
    await sendWeixinMediaFile({ ...baseParams, to: "user2", filePath: "/tmp/t2.jpg", sourceUrl });

    expect(mockUploadFileToWeixin).toHaveBeenCalledTimes(2);
    expect(mockSendImageMessageWeixin).toHaveBeenCalledTimes(2);
  });

  it("URL normalisation: same URL with different casing in scheme/host is treated as one key", async () => {
    mockUploadFileToWeixin.mockResolvedValueOnce(fakeUploaded);
    mockSendImageMessageWeixin.mockResolvedValueOnce({ messageId: "norm-1" });

    const first = await sendWeixinMediaFile({
      ...baseParams,
      filePath: "/tmp/t1.jpg",
      sourceUrl: "HTTPS://Example.COM/img/photo.jpg",
    });
    expect(first.messageId).toBe("norm-1");

    const second = await sendWeixinMediaFile({
      ...baseParams,
      filePath: "/tmp/t2.jpg",
      sourceUrl: "https://example.com/img/photo.jpg", // same URL, lowercase
    });
    expect(second.messageId).toBe("norm-1");

    expect(mockUploadFileToWeixin).toHaveBeenCalledOnce();
    expect(mockSendImageMessageWeixin).toHaveBeenCalledOnce();
  });

  it("sourceUrl dedup also expires after the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    mockUploadFileToWeixin.mockResolvedValue(fakeUploaded);
    mockSendImageMessageWeixin
      .mockResolvedValueOnce({ messageId: "r1" })
      .mockResolvedValueOnce({ messageId: "r2" });

    const sourceUrl = "https://example.com/pic.jpg";

    const first = await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/t1.jpg", sourceUrl });
    expect(first.messageId).toBe("r1");

    // Advance past DEDUP_WINDOW_MS (5 s)
    vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));

    const second = await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/t2.jpg", sourceUrl });
    expect(second.messageId).toBe("r2");

    expect(mockUploadFileToWeixin).toHaveBeenCalledTimes(2);
    expect(mockSendImageMessageWeixin).toHaveBeenCalledTimes(2);
  });

  it("local filePath and remote sourceUrl for same content are independent keys", async () => {
    // A local file with the same basename as a remote URL should NOT be
    // deduped against a remote URL call — they are different code paths.
    mockUploadFileToWeixin.mockResolvedValue(fakeUploaded);
    mockSendImageMessageWeixin
      .mockResolvedValueOnce({ messageId: "local-1" })
      .mockResolvedValueOnce({ messageId: "remote-1" });

    // First call: local file, no sourceUrl
    await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/photo.jpg" });
    // Second call: remote URL downloaded to a different path, with sourceUrl
    await sendWeixinMediaFile({
      ...baseParams,
      filePath: "/tmp/other-photo.jpg",
      sourceUrl: "https://example.com/photo.jpg",
    });

    expect(mockUploadFileToWeixin).toHaveBeenCalledTimes(2);
    expect(mockSendImageMessageWeixin).toHaveBeenCalledTimes(2);
  });
});
