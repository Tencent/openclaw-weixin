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

import { sendWeixinMediaFile } from "./send-media.js";

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
