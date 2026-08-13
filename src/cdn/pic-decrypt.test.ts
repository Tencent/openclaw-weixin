import { beforeEach, describe, expect, it, vi } from "vitest";

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../util/logger.js", () => ({ logger: loggerMock }));

import { downloadAndDecryptBuffer, downloadPlainCdnBuffer } from "./pic-decrypt.js";

describe("CDN download log redaction", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    loggerMock.debug.mockReset();
    loggerMock.error.mockReset();
  });

  it("does not expose signed CDN query parameters in network error logs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));
    const fullUrl = "https://cdn.example/download?signature=very-secret&token=also-secret";

    await expect(
      downloadPlainCdnBuffer("encrypted-param", "https://cdn.example", "test", fullUrl),
    ).rejects.toThrow("network unavailable");

    const messages = [
      ...loggerMock.debug.mock.calls,
      ...loggerMock.error.mock.calls,
    ].flat().join("\n");
    expect(messages).toContain("https://cdn.example/download?<redacted>");
    expect(messages).not.toContain("very-secret");
    expect(messages).not.toContain("also-secret");
  });

  it("does not include malformed AES key material in errors", async () => {
    const invalidKey = Buffer.from("secret-key-material").toString("base64");

    await expect(
      downloadAndDecryptBuffer(
        "encrypted-param",
        invalidKey,
        "https://cdn.example",
        "test",
      ),
    ).rejects.toThrow("inputLen=");

    const messages = loggerMock.error.mock.calls.flat().join("\n");
    expect(messages).not.toContain(invalidKey);
    expect(messages).not.toContain("secret-key-material");
  });

  it("redacts sensitive fields returned in CDN error bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: vi.fn().mockResolvedValue('{"aes_key":"secret-key","message":"failed"}'),
      } as unknown as Response),
    );

    let thrown = "";
    try {
      await downloadPlainCdnBuffer(
        "encrypted-param",
        "https://cdn.example",
        "test",
        "https://cdn.example/download?signature=secret",
      );
    } catch (err) {
      thrown = String(err);
    }

    const messages = loggerMock.error.mock.calls.flat().join("\n");
    expect(thrown).toContain("CDN download 500");
    expect(thrown).not.toContain("secret-key");
    expect(messages).toContain('"aes_key":"<redacted>"');
    expect(messages).not.toContain("secret-key");
  });
});
