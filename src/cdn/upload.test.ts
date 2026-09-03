import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { mockGetUploadUrl } = vi.hoisted(() => ({
  mockGetUploadUrl: vi.fn(),
}));

vi.mock("../api/api.js", () => ({
  getUploadUrl: mockGetUploadUrl,
}));

// `downloadRemoteImageToTemp` still uses `global fetch` (it downloads media,
// it does not POST to the Weixin CDN). The CDN upload path (issue #149) now
// uses `node:https` via `postBufferRaw`, so we mock that instead.
const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));
vi.stubGlobal("fetch", mockFetch);

const { mockPostBufferRaw } = vi.hoisted(() => ({
  mockPostBufferRaw: vi.fn(),
}));
vi.mock("./cdn-transport.js", () => ({
  postBufferRaw: mockPostBufferRaw,
}));

import { downloadRemoteImageToTemp, uploadFileToWeixin, uploadVideoToWeixin, uploadFileAttachmentToWeixin } from "./upload.js";

/** Build a `CdnUploadResponse`-shaped object from a header map. */
function cdnRes(
  status: number,
  headers: Record<string, string> = {},
  bodyText = "",
): { status: number; getHeader: (n: string) => string | undefined; text: () => Promise<string> } {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    getHeader: (name: string) => lower[name.toLowerCase()],
    text: async () => bodyText,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("downloadRemoteImageToTemp", () => {
  it("downloads and saves file to temp dir", async () => {
    const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "upload-test-"));
    try {
      const imageBytes = Buffer.from("fake-image-data");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength)),
        headers: new Headers({ "content-type": "image/png" }),
      });
      const filePath = await downloadRemoteImageToTemp("https://example.com/photo.png", tmpDir);
      expect(filePath).toContain(tmpDir);
      expect(filePath).toMatch(/\.png$/);
      const content = await fs.readFile(filePath);
      expect(content.toString()).toBe("fake-image-data");
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });
    await expect(
      downloadRemoteImageToTemp("https://example.com/missing.png", "/tmp/test"),
    ).rejects.toThrow("remote media download failed");
  });
});

describe("uploadFileToWeixin", () => {
  it("uploads image file and returns info", async () => {
    const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "upload-img-test-"));
    try {
      const filePath = path.join(tmpDir, "test.png");
      await fs.writeFile(filePath, "fake-image-data");

      mockGetUploadUrl.mockResolvedValueOnce({ upload_param: "up-param" });
      mockPostBufferRaw.mockResolvedValueOnce(cdnRes(200, { "x-encrypted-param": "dl-param" }));

      const result = await uploadFileToWeixin({
        filePath,
        toUserId: "user1",
        opts: { baseUrl: "https://api.com", token: "tok" },
        cdnBaseUrl: "https://cdn.com",
      });

      expect(result.filekey).toBeDefined();
      expect(result.downloadEncryptedQueryParam).toBe("dl-param");
      expect(result.fileSize).toBe(15);
      expect(result.fileSizeCiphertext).toBe(16);
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uploads via upload_full_url when upload_param is absent", async () => {
    const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "upload-fullurl-test-"));
    try {
      const filePath = path.join(tmpDir, "test.png");
      await fs.writeFile(filePath, "fake-image-data");

      const fullUrl = "http://cdn.example/c2c/upload?encrypted_query_param=x&filekey=y";
      mockGetUploadUrl.mockResolvedValueOnce({ upload_full_url: fullUrl });
      mockPostBufferRaw.mockResolvedValueOnce(cdnRes(200, { "x-encrypted-param": "dl-full" }));

      const result = await uploadFileToWeixin({
        filePath,
        toUserId: "user1",
        opts: { baseUrl: "https://api.com", token: "tok" },
        cdnBaseUrl: "https://ignored-cdn.com",
      });

      expect(result.downloadEncryptedQueryParam).toBe("dl-full");
      expect(mockPostBufferRaw).toHaveBeenCalledTimes(1);
      const [calledUrl] = mockPostBufferRaw.mock.calls[0] as [string, Buffer];
      expect(calledUrl).toBe(fullUrl);
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when getUploadUrl returns neither upload_full_url nor upload_param", async () => {
    const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "upload-fail-test-"));
    try {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "data");

      mockGetUploadUrl.mockResolvedValueOnce({});

      await expect(
        uploadFileToWeixin({
          filePath,
          toUserId: "user1",
          opts: { baseUrl: "https://api.com" },
          cdnBaseUrl: "https://cdn.com",
        }),
      ).rejects.toThrow("no upload URL");
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("retries CDN upload on server error then succeeds", async () => {
    const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "upload-retry-test-"));
    try {
      const filePath = path.join(tmpDir, "data.bin");
      await fs.writeFile(filePath, "some data for upload");

      mockGetUploadUrl.mockResolvedValueOnce({ upload_param: "up" });

      mockPostBufferRaw.mockResolvedValueOnce(
        cdnRes(500, { "x-error-message": "server busy" }, "server busy"),
      );
      mockPostBufferRaw.mockResolvedValueOnce(
        cdnRes(200, { "x-encrypted-param": "dl-retry" }),
      );

      const result = await uploadFileToWeixin({
        filePath,
        toUserId: "user1",
        opts: { baseUrl: "https://api.com" },
        cdnBaseUrl: "https://cdn.com",
      });
      expect(result.downloadEncryptedQueryParam).toBe("dl-retry");
      expect(mockPostBufferRaw).toHaveBeenCalledTimes(2);
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws immediately on CDN client error (4xx)", async () => {
    const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "upload-4xx-test-"));
    try {
      const filePath = path.join(tmpDir, "data.bin");
      await fs.writeFile(filePath, "data");

      mockGetUploadUrl.mockResolvedValueOnce({ upload_param: "up" });
      mockPostBufferRaw.mockResolvedValueOnce(
        cdnRes(403, { "x-error-message": "forbidden" }, "forbidden"),
      );

      await expect(
        uploadFileToWeixin({
          filePath,
          toUserId: "user1",
          opts: { baseUrl: "https://api.com" },
          cdnBaseUrl: "https://cdn.com",
        }),
      ).rejects.toThrow("client error");
      expect(mockPostBufferRaw).toHaveBeenCalledTimes(1);
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when CDN returns no x-encrypted-param after all retries", async () => {
    const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "upload-no-param-test-"));
    try {
      const filePath = path.join(tmpDir, "data.bin");
      await fs.writeFile(filePath, "data");

      mockGetUploadUrl.mockResolvedValueOnce({ upload_param: "up" });

      for (let i = 0; i < 3; i++) {
        mockPostBufferRaw.mockResolvedValueOnce(cdnRes(200, {}));
      }

      await expect(
        uploadFileToWeixin({
          filePath,
          toUserId: "user1",
          opts: { baseUrl: "https://api.com" },
          cdnBaseUrl: "https://cdn.com",
        }),
      ).rejects.toThrow("x-encrypted-param");
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("uploadVideoToWeixin", () => {
  it("uploads video file", async () => {
    const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "upload-vid-test-"));
    try {
      const filePath = path.join(tmpDir, "clip.mp4");
      await fs.writeFile(filePath, "fake-video-content");

      mockGetUploadUrl.mockResolvedValueOnce({ upload_param: "up-vid" });
      mockPostBufferRaw.mockResolvedValueOnce(cdnRes(200, { "x-encrypted-param": "dl-vid" }));

      const result = await uploadVideoToWeixin({
        filePath,
        toUserId: "user1",
        opts: { baseUrl: "https://api.com" },
        cdnBaseUrl: "https://cdn.com",
      });

      expect(result.filekey).toBeDefined();
      expect(result.downloadEncryptedQueryParam).toBe("dl-vid");
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("uploadFileAttachmentToWeixin", () => {
  it("uploads file attachment", async () => {
    const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "upload-att-test-"));
    try {
      const filePath = path.join(tmpDir, "doc.pdf");
      await fs.writeFile(filePath, "pdf-content");

      mockGetUploadUrl.mockResolvedValueOnce({ upload_param: "up" });
      mockPostBufferRaw.mockResolvedValueOnce(cdnRes(200, { "x-encrypted-param": "dl" }));

      const result = await uploadFileAttachmentToWeixin({
        filePath,
        fileName: "doc.pdf",
        toUserId: "user1",
        opts: { baseUrl: "https://api.com" },
        cdnBaseUrl: "https://cdn.com",
      });
      expect(result.filekey).toBeDefined();
      expect(result.downloadEncryptedQueryParam).toBe("dl");
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
