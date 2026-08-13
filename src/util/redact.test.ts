import { describe, it, expect } from "vitest";

import { truncate, redactToken, redactBody, redactUrl } from "./redact.js";

describe("truncate", () => {
  it("returns empty string for undefined", () => {
    expect(truncate(undefined, 10)).toBe("");
  });

  it("returns original when within limit", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  it("truncates and appends length", () => {
    const result = truncate("a]long-string-here", 5);
    expect(result).toBe("a]lon…(len=18)");
  });
});

describe("redactToken", () => {
  it("returns (none) for undefined", () => {
    expect(redactToken(undefined)).toBe("(none)");
  });

  it("returns (none) for empty string", () => {
    expect(redactToken("")).toBe("(none)");
  });

  it("masks short tokens entirely", () => {
    expect(redactToken("abc", 6)).toBe("****(len=3)");
  });

  it("shows prefix for longer tokens", () => {
    expect(redactToken("abcdef1234567890")).toBe("abcdef…(len=16)");
  });

  it("respects custom prefix length", () => {
    expect(redactToken("abcdef1234567890", 3)).toBe("abc…(len=16)");
  });
});

describe("redactBody", () => {
  it("returns (empty) for undefined", () => {
    expect(redactBody(undefined)).toBe("(empty)");
  });

  it("returns original when within limit", () => {
    const body = '{"key":"value"}';
    expect(redactBody(body)).toBe(body);
  });

  it("truncates long bodies", () => {
    const body = "x".repeat(300);
    const result = redactBody(body);
    expect(result).toContain("…(truncated, totalLen=300)");
    expect(result.length).toBeLessThan(300);
  });

  it("respects custom max length", () => {
    const body = "x".repeat(50);
    const result = redactBody(body, 10);
    expect(result).toBe("xxxxxxxxxx…(truncated, totalLen=50)");
  });

  it("redacts context_token values", () => {
    const body = '{"to":"user1","context_token":"secret123","text":"hello"}';
    expect(redactBody(body)).toBe('{"to":"user1","context_token":"<redacted>","text":"hello"}');
  });

  it("redacts bot_token values", () => {
    const body = '{"bot_token":"abc-xyz-secret"}';
    expect(redactBody(body)).toBe('{"bot_token":"<redacted>"}');
  });

  it("redacts token values", () => {
    const body = '{"token":"my-secret-token"}';
    expect(redactBody(body)).toBe('{"token":"<redacted>"}');
  });

  it("redacts nested credential and CDN fields", () => {
    const body = JSON.stringify({
      status: "confirmed",
      result: {
        aes_key: "base64-secret",
        encrypt_query_param: "signed-download-param",
        upload_full_url: "https://cdn.example/upload?signature=secret",
      },
    });

    const redacted = redactBody(body);
    expect(redacted).toContain('"status":"confirmed"');
    expect(redacted).not.toContain("base64-secret");
    expect(redacted).not.toContain("signed-download-param");
    expect(redacted).not.toContain("signature=secret");
  });

  it("redacts arrays stored in sensitive fields", () => {
    const body = '{"local_token_list":["token-a","token-b"],"count":2}';
    expect(redactBody(body)).toBe('{"local_token_list":"<redacted>","count":2}');
  });

  it("redacts sensitive fields case-insensitively", () => {
    expect(redactBody('{"Authorization":"Bearer secret"}')).toBe(
      '{"Authorization":"<redacted>"}',
    );
  });

  it("redacts sensitive values in malformed JSON as a fallback", () => {
    const body = 'partial:{"bot_token":"secret","local_token_list":["a","b"]';
    const redacted = redactBody(body);
    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain('"a"');
    expect(redacted).toContain('"bot_token":"<redacted>"');
    expect(redacted).toContain('"local_token_list":"<redacted>"');
  });
});

describe("redactUrl", () => {
  it("preserves URL without query", () => {
    expect(redactUrl("https://example.com/api/test")).toBe("https://example.com/api/test");
  });

  it("strips query parameters", () => {
    expect(redactUrl("https://example.com/upload?sig=secret&token=abc")).toBe(
      "https://example.com/upload?<redacted>",
    );
  });

  it("handles invalid URLs gracefully", () => {
    const result = redactUrl("not-a-url-but-very-long-" + "x".repeat(100));
    expect(result).toContain("…(len=");
  });
});
