import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock logger
vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock crypto for deterministic headers
vi.mock("node:crypto", () => ({
  default: {
    randomBytes: vi.fn(() => ({
      readUInt32BE: () => 12345,
      toString: () => "deadbeef",
    })),
  },
}));

import {
  getUpdates,
  getUploadUrl,
  sendMessage,
  describeSendMessageFailure,
  getConfig,
  sendTyping,
  sanitizeBotAgent,
  readPackageJsonFromDir,
  classifyFetchError,
} from "./api.js";

function mockResponse(body: object | string, status = 200, ok = true): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status,
    text: () => Promise.resolve(text),
    headers: new Headers(),
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getUpdates", () => {
  it("returns parsed response on success", async () => {
    const resp = { ret: 0, msgs: [{ seq: 1 }], get_updates_buf: "buf" };
    mockFetch.mockResolvedValueOnce(mockResponse(resp));
    const result = await getUpdates({
      baseUrl: "https://api.example.com",
      get_updates_buf: "old-buf",
      token: "tok",
    });
    expect(result.ret).toBe(0);
    expect(result.msgs).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("ilink/bot/getupdates");
    expect(opts.method).toBe("POST");
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse("err", 500, false));
    await expect(getUpdates({ baseUrl: "https://api.example.com" })).rejects.toThrow("getUpdates 500");
  });

  it("returns empty response on abort/timeout", async () => {
    const abortErr = new Error("AbortError");
    abortErr.name = "AbortError";
    mockFetch.mockRejectedValueOnce(abortErr);
    const result = await getUpdates({
      baseUrl: "https://api.example.com",
      get_updates_buf: "buf",
      timeoutMs: 100,
    });
    expect(result.ret).toBe(0);
    expect(result.get_updates_buf).toBe("buf");
  });

  it("re-throws non-abort errors", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));
    await expect(getUpdates({ baseUrl: "https://api.example.com" })).rejects.toThrow("network error");
  });

  it("adds trailing slash to baseUrl", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ret: 0 }));
    await getUpdates({ baseUrl: "https://api.example.com" });
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("https://api.example.com/ilink/bot/getupdates");
  });

  it("forwards external abortSignal to the underlying fetch", async () => {
    let receivedSignal: AbortSignal | undefined;
    mockFetch.mockImplementationOnce((_url: string, opts: RequestInit) => {
      receivedSignal = opts.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const external = new AbortController();
    const pending = getUpdates({
      baseUrl: "https://api.example.com",
      get_updates_buf: "resume-buf",
      timeoutMs: 60_000,
      abortSignal: external.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    external.abort();
    const result = await pending;

    expect(receivedSignal).toBeDefined();
    expect(result.ret).toBe(0);
    expect(result.get_updates_buf).toBe("resume-buf");
  });

  it("aborts immediately when external signal is already aborted", async () => {
    let receivedSignal: AbortSignal | undefined;
    mockFetch.mockImplementationOnce((_url: string, opts: RequestInit) => {
      receivedSignal = opts.signal as AbortSignal;
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });

    const external = new AbortController();
    external.abort();
    const result = await getUpdates({
      baseUrl: "https://api.example.com",
      abortSignal: external.signal,
    });

    expect(receivedSignal?.aborted).toBe(true);
    expect(result.ret).toBe(0);
  });
});

describe("getUploadUrl", () => {
  it("returns parsed response on success", async () => {
    const resp = { upload_param: "param", thumb_upload_param: "tparam" };
    mockFetch.mockResolvedValueOnce(mockResponse(resp));
    const result = await getUploadUrl({
      baseUrl: "https://api.example.com/",
      filekey: "fk",
      media_type: 1,
      to_user_id: "user1",
      rawsize: 100,
      rawfilemd5: "md5",
      filesize: 112,
    });
    expect(result.upload_param).toBe("param");
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse("fail", 400, false));
    await expect(
      getUploadUrl({ baseUrl: "https://api.example.com/" }),
    ).rejects.toThrow("getUploadUrl 400");
  });
});

describe("sendMessage", () => {
  it("succeeds on ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve("{}") } as Response);
    await expect(
      sendMessage({ baseUrl: "https://api.example.com/", body: { msg: { to_user_id: "u" } } }),
    ).resolves.toBeUndefined();
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse("error", 403, false));
    await expect(
      sendMessage({ baseUrl: "https://api.example.com/", body: { msg: {} } }),
    ).rejects.toThrow("sendMessage 403");
  });

  it("throws an actionable error when ret is non-zero with empty errmsg and a context_token was sent", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ret: -2, errmsg: "" }));
    await expect(
      sendMessage({
        baseUrl: "https://api.example.com/",
        body: { msg: { to_user_id: "u", context_token: "tok" } },
      }),
    ).rejects.toThrow(/ret=-2.*context_token.*expired/);
  });

  it("explains the missing context_token when none was sent", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ret: -2 }));
    await expect(
      sendMessage({ baseUrl: "https://api.example.com/", body: { msg: { to_user_id: "u" } } }),
    ).rejects.toThrow(/agent-initiated outbound requires one/);
  });
});

describe("describeSendMessageFailure", () => {
  it("passes through a non-empty server errmsg", () => {
    expect(
      describeSendMessageFailure({ ret: -2, errmsg: "rate limited" }, { msg: {} }),
    ).toBe("sendMessage ret=-2 errmsg=rate limited");
  });

  it("flags a likely expired context_token when one was present", () => {
    const msg = describeSendMessageFailure({ ret: -2, errmsg: "" }, { msg: { context_token: "tok" } });
    expect(msg).toContain("ret=-2");
    expect(msg).toContain("expired");
  });

  it("flags a missing context_token when none was present", () => {
    const msg = describeSendMessageFailure({ ret: -2 }, { msg: {} });
    expect(msg).toContain("agent-initiated outbound requires one");
  });
});

describe("getConfig", () => {
  it("returns parsed response", async () => {
    const resp = { ret: 0, typing_ticket: "ticket" };
    mockFetch.mockResolvedValueOnce(mockResponse(resp));
    const result = await getConfig({
      baseUrl: "https://api.example.com/",
      ilinkUserId: "user1",
    });
    expect(result.typing_ticket).toBe("ticket");
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse("fail", 500, false));
    await expect(
      getConfig({ baseUrl: "https://api.example.com/", ilinkUserId: "u" }),
    ).rejects.toThrow("getConfig 500");
  });
});

describe("sendTyping", () => {
  it("succeeds on ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ret: 0 }));
    await expect(
      sendTyping({
        baseUrl: "https://api.example.com/",
        body: { ilink_user_id: "u", typing_ticket: "t", status: 1 },
      }),
    ).resolves.toBeUndefined();
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse("err", 500, false));
    await expect(
      sendTyping({ baseUrl: "https://api.example.com/", body: {} }),
    ).rejects.toThrow("sendTyping 500");
  });
});

describe("sanitizeBotAgent", () => {
  it("returns default when input is empty / undefined / whitespace", () => {
    expect(sanitizeBotAgent(undefined)).toBe("OpenClaw");
    expect(sanitizeBotAgent("")).toBe("OpenClaw");
    expect(sanitizeBotAgent("   ")).toBe("OpenClaw");
    expect(sanitizeBotAgent("\t\n")).toBe("OpenClaw");
  });

  it("passes through a single valid product", () => {
    expect(sanitizeBotAgent("MyBot/1.2.0")).toBe("MyBot/1.2.0");
  });

  it("passes through multiple space-separated products", () => {
    expect(sanitizeBotAgent("MyBot/1.2.0 LangChain/0.3.5")).toBe(
      "MyBot/1.2.0 LangChain/0.3.5",
    );
  });

  it("preserves a (comment) attached to a product", () => {
    expect(sanitizeBotAgent("MyBot/1.2.0 (region=cn;env=prod)")).toBe(
      "MyBot/1.2.0 (region=cn;env=prod)",
    );
  });

  it("supports multi-word comments", () => {
    expect(sanitizeBotAgent("MyBot/1.2.0 (built on linux)")).toBe(
      "MyBot/1.2.0 (built on linux)",
    );
  });

  it("accepts semver pre-release and build metadata", () => {
    expect(sanitizeBotAgent("MyBot/1.2.0-rc.1+build.5")).toBe(
      "MyBot/1.2.0-rc.1+build.5",
    );
  });

  it("drops tokens that fail to parse, keeps valid ones", () => {
    // "My Bot" splits into "My" and "Bot" — neither matches Name/Version, both dropped.
    // The trailing valid product is kept.
    expect(sanitizeBotAgent("My Bot ValidApp/1.0")).toBe("ValidApp/1.0");
  });

  it("falls back to default when all tokens are invalid", () => {
    expect(sanitizeBotAgent("garbage no slashes here")).toBe("OpenClaw");
  });

  it("drops non-ASCII characters by failing the token regex", () => {
    // "中文/1.0" contains non-ASCII chars in name → token rejected.
    expect(sanitizeBotAgent("中文/1.0")).toBe("OpenClaw");
    // Mixed: invalid token dropped, valid kept.
    expect(sanitizeBotAgent("中文/1.0 MyBot/1.2.0")).toBe("MyBot/1.2.0");
  });

  it("rejects tokens with too-long name or version", () => {
    const longName = "a".repeat(33);
    expect(sanitizeBotAgent(`${longName}/1.0`)).toBe("OpenClaw");
    const longVersion = "1".repeat(33);
    expect(sanitizeBotAgent(`MyBot/${longVersion}`)).toBe("OpenClaw");
  });

  it("orphan or malformed comment is dropped without breaking siblings", () => {
    // Standalone "(foo)" without a preceding product is dropped.
    expect(sanitizeBotAgent("(orphan) MyBot/1.0")).toBe("MyBot/1.0");
    // "(comment)" with non-ASCII inside is dropped, product kept.
    expect(sanitizeBotAgent("MyBot/1.0 (中文)")).toBe("MyBot/1.0");
  });

  it("truncates by dropping trailing tokens to stay within 256 bytes", () => {
    const product = "App/1.0"; // 7 bytes
    // Build a string longer than 256 bytes.
    const tokens = Array.from({ length: 50 }, (_, i) => `App${i}/1.0`);
    const input = tokens.join(" ");
    const result = sanitizeBotAgent(input);
    expect(result.length).toBeLessThanOrEqual(256);
    // Should still contain at least the first product.
    expect(result.startsWith("App0/1.0")).toBe(true);
    // Truncation point is per-token (no half tokens).
    expect(result.split(" ").every((t) => /^App\d+\/1\.0$/.test(t))).toBe(true);
    // Suppress unused var warning.
    expect(product).toBe("App/1.0");
  });

  it("never returns empty string", () => {
    expect(sanitizeBotAgent("")).not.toBe("");
    expect(sanitizeBotAgent("garbage")).not.toBe("");
  });
});

describe("readPackageJsonFromDir", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-weixin-pkg-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writePkg(dir: string, contents: object) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(contents), "utf-8");
  }

  it("finds package.json from compiled layout (dist/src/api/)", () => {
    // Reproduces the publish-time layout: source compiles to dist/src/...
    writePkg(tmpRoot, {
      name: "@tencent-weixin/openclaw-weixin",
      version: "2.4.2",
      ilink_appid: "bot",
    });
    const startDir = path.join(tmpRoot, "dist", "src", "api");
    fs.mkdirSync(startDir, { recursive: true });

    const result = readPackageJsonFromDir(startDir);
    expect(result.ilink_appid).toBe("bot");
    expect(result.version).toBe("2.4.2");
    expect(result.name).toBe("@tencent-weixin/openclaw-weixin");
  });

  it("finds package.json from dev layout (src/api/)", () => {
    writePkg(tmpRoot, {
      name: "@tencent/openclaw-weixin",
      version: "2.4.2",
      ilink_appid: "bot",
    });
    const startDir = path.join(tmpRoot, "src", "api");
    fs.mkdirSync(startDir, { recursive: true });

    const result = readPackageJsonFromDir(startDir);
    expect(result.ilink_appid).toBe("bot");
  });

  it("skips unrelated package.json on the way up (e.g. nested node_modules dep)", () => {
    // Outer plugin package.
    writePkg(tmpRoot, {
      name: "@tencent-weixin/openclaw-weixin",
      version: "2.4.2",
      ilink_appid: "bot",
    });
    // A transitive dep with its own package.json sitting between us and the
    // plugin root — must NOT shadow the plugin's package.json.
    const depDir = path.join(tmpRoot, "dist", "node_modules", "some-dep");
    writePkg(depDir, { name: "some-dep", version: "9.9.9" });
    const startDir = path.join(depDir, "lib");
    fs.mkdirSync(startDir, { recursive: true });

    const result = readPackageJsonFromDir(startDir);
    expect(result.name).toBe("@tencent-weixin/openclaw-weixin");
    expect(result.ilink_appid).toBe("bot");
  });

  it("returns empty object when no matching package.json exists", () => {
    const startDir = path.join(tmpRoot, "nowhere", "deep");
    fs.mkdirSync(startDir, { recursive: true });

    const result = readPackageJsonFromDir(startDir);
    expect(result).toEqual({});
  });

  it("tolerates malformed package.json and keeps walking", () => {
    // Drop a broken package.json closer to startDir; valid one further up.
    const brokenDir = path.join(tmpRoot, "dist");
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, "package.json"), "{not-json", "utf-8");
    writePkg(tmpRoot, {
      name: "@tencent-weixin/openclaw-weixin",
      version: "2.4.2",
      ilink_appid: "bot",
    });
    const startDir = path.join(brokenDir, "src", "api");
    fs.mkdirSync(startDir, { recursive: true });

    const result = readPackageJsonFromDir(startDir);
    expect(result.ilink_appid).toBe("bot");
  });
});

describe("classifyFetchError", () => {
  it("classifies DNS resolution errors (ENOTFOUND)", () => {
    const err = Object.assign(new Error("fetch failed"), {
      cause: { code: "ENOTFOUND" },
    });
    expect(classifyFetchError(err)).toEqual({
      type: "dns",
      description: "DNS resolution failed, check DNS configuration",
      code: "ENOTFOUND",
    });
  });

  it("classifies EAI_AGAIN as dns", () => {
    const err = Object.assign(new Error("fetch failed"), {
      cause: { code: "EAI_AGAIN" },
    });
    const result = classifyFetchError(err);
    expect(result.type).toBe("dns");
    expect(result.code).toBe("EAI_AGAIN");
  });

  it("classifies getaddrinfo in message as dns", () => {
    const err = new Error("getaddrinfo ENOTFOUND example.com");
    const result = classifyFetchError(err);
    expect(result.type).toBe("dns");
    expect(result.code).toBeUndefined();
  });

  it("classifies TCP connection refused", () => {
    const err = Object.assign(new Error("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    expect(classifyFetchError(err)).toEqual({
      type: "tcp",
      description: "TCP connection refused",
      code: "ECONNREFUSED",
    });
  });

  it("classifies TCP timeout / unreachable codes", () => {
    for (const code of ["ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"]) {
      const err = Object.assign(new Error("fetch failed"), {
        cause: { code },
      });
      const result = classifyFetchError(err);
      expect(result.type).toBe("tcp");
      expect(result.description).toBe("TCP connection timeout or unreachable");
      expect(result.code).toBe(code);
    }
  });

  it("classifies UND_ERR_CONNECT_TIMEOUT as tcp", () => {
    const err = new Error("fetch failed");
    (err as any).cause = "UND_ERR_CONNECT_TIMEOUT";
    const result = classifyFetchError(err);
    expect(result.type).toBe("tcp");
    expect(result.code).toBe("UND_ERR_CONNECT_TIMEOUT");
  });

  it("classifies TLS handshake errors", () => {
    for (const cause of [
      "UND_ERR_SOCKET",
      "ERR_SSL_PROTOCOL_ERROR",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ]) {
      const err = new Error("fetch failed");
      (err as any).cause = cause;
      const result = classifyFetchError(err);
      expect(result.type).toBe("tls");
      expect(result.code).toBe(cause);
    }
  });

  it("classifies AbortError as timeout", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    expect(classifyFetchError(err)).toEqual({
      type: "timeout",
      description: "request timeout",
    });
  });

  it("returns unknown for unrecognized errors", () => {
    const err = new Error("something unexpected");
    expect(classifyFetchError(err)).toEqual({
      type: "unknown",
      description: "network request failed",
    });
  });

  it("reads cause from err.cause when available", () => {
    const err = Object.assign(new Error("fetch failed"), {
      cause: "ETIMEDOUT",
    });
    const result = classifyFetchError(err);
    expect(result.type).toBe("tcp");
    expect(result.code).toBe("ETIMEDOUT");
  });
});
