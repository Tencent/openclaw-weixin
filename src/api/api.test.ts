import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { getUpdates, getUploadUrl, sendMessage, getConfig, sendTyping } from "./api.js";

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
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve("") } as Response);
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
