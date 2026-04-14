import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));
vi.stubGlobal("fetch", mockFetch);

import { encryptAesEcb, aesEcbPaddedSize } from "./aes-ecb.js";
import { uploadBufferToCdn } from "./cdn-upload.js";
import crypto from "node:crypto";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("aesEcbPaddedSize", () => {
  it("pads to 16-byte boundary", () => {
    expect(aesEcbPaddedSize(0)).toBe(16);
    expect(aesEcbPaddedSize(1)).toBe(16);
    expect(aesEcbPaddedSize(15)).toBe(16);
    expect(aesEcbPaddedSize(16)).toBe(32);
    expect(aesEcbPaddedSize(31)).toBe(32);
    expect(aesEcbPaddedSize(32)).toBe(48);
  });
});

describe("encryptAesEcb", () => {
  it("encrypts and produces correct ciphertext length", () => {
    const key = crypto.randomBytes(16);
    const plaintext = Buffer.from("hello world 1234");
    const ct = encryptAesEcb(plaintext, key);
    // 16 bytes plaintext + PKCS7 padding = 32 bytes ciphertext
    expect(ct.length).toBe(32);
  });
});

describe("uploadBufferToCdn", () => {
  const aeskey = crypto.randomBytes(16);

  it("uploads successfully and returns downloadParam", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "x-encrypted-param": "dl-param" }),
    });

    const result = await uploadBufferToCdn({
      buf: Buffer.from("data"),
      uploadParam: "up",
      filekey: "fk",
      cdnBaseUrl: "https://cdn.com",
      label: "test",
      aeskey,
    });
    expect(result.downloadParam).toBe("dl-param");
  });

  it("POSTs to uploadFullUrl when provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "x-encrypted-param": "dl-full" }),
    });

    const fullUrl = "http://host/c2c/upload?q=1";
    const result = await uploadBufferToCdn({
      buf: Buffer.from("data"),
      uploadFullUrl: fullUrl,
      filekey: "fk",
      cdnBaseUrl: "https://unused.example",
      label: "test",
      aeskey,
    });
    expect(result.downloadParam).toBe("dl-full");
    expect(mockFetch).toHaveBeenCalledWith(
      fullUrl,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("retries on server error then succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers({ "x-error-message": "busy" }),
        text: () => Promise.resolve("busy"),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "x-encrypted-param": "dl" }),
      });

    const result = await uploadBufferToCdn({
      buf: Buffer.from("data"),
      uploadParam: "up",
      filekey: "fk",
      cdnBaseUrl: "https://cdn.com",
      label: "test",
      aeskey,
    });
    expect(result.downloadParam).toBe("dl");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on 4xx client error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: new Headers({}),
      text: () => Promise.resolve("forbidden"),
    });

    await expect(
      uploadBufferToCdn({
        buf: Buffer.from("data"),
        uploadParam: "up",
        filekey: "fk",
        cdnBaseUrl: "https://cdn.com",
        label: "test",
        aeskey,
      }),
    ).rejects.toThrow("client error");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws when x-encrypted-param header is missing after all retries", async () => {
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({}),
      });
    }

    await expect(
      uploadBufferToCdn({
        buf: Buffer.from("data"),
        uploadParam: "up",
        filekey: "fk",
        cdnBaseUrl: "https://cdn.com",
        label: "test",
        aeskey,
      }),
    ).rejects.toThrow("x-encrypted-param");
  });

  it("uses x-error-message header for 4xx when available", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: new Headers({ "x-error-message": "bad request detail" }),
      text: () => Promise.resolve("fallback text"),
    });

    await expect(
      uploadBufferToCdn({
        buf: Buffer.from("data"),
        uploadParam: "up",
        filekey: "fk",
        cdnBaseUrl: "https://cdn.com",
        label: "test",
        aeskey,
      }),
    ).rejects.toThrow("bad request detail");
  });
});
