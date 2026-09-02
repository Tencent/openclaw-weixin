import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const {
  mockUploadFileToWeixin,
  mockUploadVideoToWeixin,
  mockUploadFileAttachmentToWeixin,
  mockUploadVoiceToWeixin,
} = vi.hoisted(() => ({
  mockUploadFileToWeixin: vi.fn(),
  mockUploadVideoToWeixin: vi.fn(),
  mockUploadFileAttachmentToWeixin: vi.fn(),
  mockUploadVoiceToWeixin: vi.fn(),
}));

vi.mock("../cdn/upload.js", () => ({
  uploadFileToWeixin: mockUploadFileToWeixin,
  uploadVideoToWeixin: mockUploadVideoToWeixin,
  uploadFileAttachmentToWeixin: mockUploadFileAttachmentToWeixin,
  uploadVoiceToWeixin: mockUploadVoiceToWeixin,
}));

const {
  mockSendImageMessageWeixin,
  mockSendVideoMessageWeixin,
  mockSendFileMessageWeixin,
  mockSendVoiceMessageWeixin,
} = vi.hoisted(() => ({
  mockSendImageMessageWeixin: vi.fn(),
  mockSendVideoMessageWeixin: vi.fn(),
  mockSendFileMessageWeixin: vi.fn(),
  mockSendVoiceMessageWeixin: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendImageMessageWeixin: mockSendImageMessageWeixin,
  sendVideoMessageWeixin: mockSendVideoMessageWeixin,
  sendFileMessageWeixin: mockSendFileMessageWeixin,
  sendVoiceMessageWeixin: mockSendVoiceMessageWeixin,
}));

const mockPrepareOutboundVoice = vi.hoisted(() => vi.fn());
const mockIsWeixinAudioFilename = vi.hoisted(() => vi.fn());

vi.mock("../media/silk-transcode.js", () => ({
  prepareOutboundVoice: mockPrepareOutboundVoice,
  isWeixinAudioFilename: mockIsWeixinAudioFilename,
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
  mockIsWeixinAudioFilename.mockImplementation((p: string) =>
    /\.(mp3|wav|ogg|silk|slk|amr|opus|m4a|aac)$/i.test(p),
  );
  mockPrepareOutboundVoice.mockResolvedValue({
    filePath: "/tmp/out.silk",
    playtimeMs: 6100,
    sampleRate: 16000,
    encodeType: 6,
    bitsPerSample: 16,
    cleanup: vi.fn().mockResolvedValue(undefined),
  });
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

  it("routes audio/mpeg to FILE attachment (native VOICE disabled)", async () => {
    mockUploadFileAttachmentToWeixin.mockResolvedValueOnce(fakeUploaded);
    mockSendFileMessageWeixin.mockResolvedValueOnce({ messageId: "file-audio" });
    const result = await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/clip.mp3" });
    expect(result.messageId).toBe("file-audio");
    expect(mockPrepareOutboundVoice).not.toHaveBeenCalled();
    expect(mockUploadVoiceToWeixin).not.toHaveBeenCalled();
    expect(mockUploadFileAttachmentToWeixin).toHaveBeenCalledOnce();
  });

  it("forceDocument keeps audio as FILE attachment", async () => {
    mockUploadFileAttachmentToWeixin.mockResolvedValueOnce(fakeUploaded);
    mockSendFileMessageWeixin.mockResolvedValueOnce({ messageId: "file-audio" });
    await sendWeixinMediaFile({
      ...baseParams,
      filePath: "/tmp/clip.mp3",
      forceDocument: true,
    });
    expect(mockUploadVoiceToWeixin).not.toHaveBeenCalled();
    expect(mockUploadFileAttachmentToWeixin).toHaveBeenCalledOnce();
  });

  it("does not call native VOICE helpers for audio", async () => {
    mockUploadFileAttachmentToWeixin.mockResolvedValueOnce(fakeUploaded);
    mockSendFileMessageWeixin.mockResolvedValueOnce({ messageId: "fallback" });
    const result = await sendWeixinMediaFile({ ...baseParams, filePath: "/tmp/clip.mp3" });
    expect(result.messageId).toBe("fallback");
    expect(mockPrepareOutboundVoice).not.toHaveBeenCalled();
    expect(mockSendVoiceMessageWeixin).not.toHaveBeenCalled();
    expect(mockSendFileMessageWeixin).toHaveBeenCalledOnce();
  });
});

  it("asVoice true still sends FILE while native VOICE is disabled", async () => {
    mockIsWeixinAudioFilename.mockReturnValue(false);
    mockUploadFileAttachmentToWeixin.mockResolvedValueOnce(fakeUploaded);
    mockSendFileMessageWeixin.mockResolvedValueOnce({ messageId: "forced-file" });
    const result = await sendWeixinMediaFile({
      ...baseParams,
      filePath: "/tmp/data.bin",
      asVoice: true,
    });
    expect(result.messageId).toBe("forced-file");
    expect(mockUploadVoiceToWeixin).not.toHaveBeenCalled();
    expect(mockUploadFileAttachmentToWeixin).toHaveBeenCalledOnce();
  });

  it("asVoice false keeps audio as FILE", async () => {
    mockUploadFileAttachmentToWeixin.mockResolvedValueOnce(fakeUploaded);
    mockSendFileMessageWeixin.mockResolvedValueOnce({ messageId: "no-voice" });
    await sendWeixinMediaFile({
      ...baseParams,
      filePath: "/tmp/clip.mp3",
      asVoice: false,
    });
    expect(mockUploadVoiceToWeixin).not.toHaveBeenCalled();
    expect(mockSendFileMessageWeixin).toHaveBeenCalledOnce();
  });
