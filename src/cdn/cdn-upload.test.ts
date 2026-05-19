import { describe, it, expect, vi, beforeEach, afterEach, afterAll, beforeAll } from "vitest";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

import { encryptAesEcb, aesEcbPaddedSize } from "./aes-ecb.js";
import { uploadBufferToCdn } from "./cdn-upload.js";
import { postBufferRaw } from "./cdn-transport.js";

// ---------------------------------------------------------------------------
// Local loopback CDN server.
//
// The whole point of issue #149 is that `global fetch` exposes empty response
// headers for CDN POSTs in the live message-tool path, even when the server
// actually sent the headers. Mocking `fetch` cannot catch that regression
// because the bug is in the transport layer, not the call site.
//
// So we spin up a real `node:http` server that mimics the Weixin CDN: it
// accepts a POST, returns 200 with `x-encrypted-param`, and lets us assert
// that the new `node:https`/`node:http` transport in `cdn-upload.ts`
// successfully reads that header. This is the real regression test for the
// bug.
// ---------------------------------------------------------------------------

type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
) => void;

let server: http.Server;
let baseUrl: string;
let routeHandler: RouteHandler | null = null;
let lastRequestBody: Buffer | null = null;
let lastRequestHeaders: http.IncomingHttpHeaders | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      lastRequestBody = body;
      lastRequestHeaders = req.headers;
      if (routeHandler) {
        routeHandler(req, res, body);
      } else {
        res.statusCode = 500;
        res.end("no route handler installed");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  routeHandler = null;
  lastRequestBody = null;
  lastRequestHeaders = null;
});

afterEach(() => {
  routeHandler = null;
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

describe("postBufferRaw (issue #149 transport)", () => {
  it("preserves response headers from a real Node HTTP server (regression for #149)", async () => {
    routeHandler = (_req, res) => {
      res.statusCode = 200;
      res.setHeader("x-encrypted-param", "real-dl-param");
      res.setHeader("x-extra", "abc");
      res.end();
    };

    const result = await postBufferRaw(`${baseUrl}/upload`, Buffer.from([1, 2, 3, 4]));
    expect(result.status).toBe(200);
    // Regression assertion: `getHeader` MUST surface what the server sent.
    // Under the old `global fetch` path in the live message-tool context this
    // came back empty (see issue #149); the `node:https`/`node:http` transport
    // exposes the wire-level headers as Node sees them.
    expect(result.getHeader("x-encrypted-param")).toBe("real-dl-param");
    expect(result.getHeader("X-Encrypted-Param")).toBe("real-dl-param"); // case-insensitive
    expect(result.getHeader("x-extra")).toBe("abc");
  });

  it("sends the body bytes exactly as provided", async () => {
    routeHandler = (_req, res) => {
      res.statusCode = 200;
      res.setHeader("x-encrypted-param", "ok");
      res.end();
    };

    const payload = crypto.randomBytes(7919); // arbitrary prime-ish size
    await postBufferRaw(`${baseUrl}/upload`, payload);
    expect(lastRequestBody?.equals(payload)).toBe(true);
    expect(lastRequestHeaders?.["content-type"]).toBe("application/octet-stream");
    expect(lastRequestHeaders?.["content-length"]).toBe(String(payload.length));
  });

  it("rejects unsupported protocols", async () => {
    await expect(postBufferRaw("ftp://example.com", Buffer.from("x"))).rejects.toThrow(
      "unsupported protocol",
    );
  });
});

describe("uploadBufferToCdn — live message tool path (issue #149)", () => {
  const aeskey = crypto.randomBytes(16);

  it("live image send via message tool path: x-encrypted-param is readable", async () => {
    // Simulates the live message-tool path: CDN returns 200 with the required
    // header. Pre-fix this failed because `global fetch` exposed empty
    // `Headers`; with `node:https` the header is read correctly.
    routeHandler = (_req, res) => {
      res.statusCode = 200;
      res.setHeader("x-encrypted-param", "live-dl-param");
      res.end();
    };

    const result = await uploadBufferToCdn({
      buf: Buffer.from("hello live message tool"),
      uploadFullUrl: `${baseUrl}/c2c/upload?q=live`,
      filekey: "fk-live",
      cdnBaseUrl: "https://unused.example",
      label: "live-msg",
      aeskey,
    });
    expect(result.downloadParam).toBe("live-dl-param");
  });

  it("delivery-recovery image path: still works (no regression)", async () => {
    // Delivery recovery also funnels through `uploadBufferToCdn`. We mimic the
    // shape of that call (uploadParam-based CDN URL building) and verify it
    // still succeeds end-to-end with the new transport.
    routeHandler = (_req, res) => {
      res.statusCode = 200;
      res.setHeader("x-encrypted-param", "recovery-dl");
      res.end();
    };

    const result = await uploadBufferToCdn({
      buf: Buffer.from("recovered image bytes"),
      uploadFullUrl: `${baseUrl}/c2c/upload?q=recovery`,
      filekey: "fk-recovery",
      cdnBaseUrl: "https://unused.example",
      label: "recovery",
      aeskey,
    });
    expect(result.downloadParam).toBe("recovery-dl");
  });

  it("standalone CDN upload: OK", async () => {
    // Standalone path = direct invocation, no surrounding tool runtime.
    // Should behave the same as before.
    routeHandler = (_req, res) => {
      res.statusCode = 200;
      res.setHeader("x-encrypted-param", "standalone-dl");
      res.end();
    };

    const result = await uploadBufferToCdn({
      buf: Buffer.from("standalone bytes"),
      uploadFullUrl: `${baseUrl}/c2c/upload`,
      filekey: "fk-standalone",
      cdnBaseUrl: "https://unused.example",
      label: "standalone",
      aeskey,
    });
    expect(result.downloadParam).toBe("standalone-dl");
  });

  it("CDN returns error: surfaces a clear message, not 'headers empty'", async () => {
    // CDN returns 500 + x-error-message on every retry; we should propagate
    // the server-provided error message rather than the misleading
    // "x-encrypted-param missing" wording. This guards the user-facing UX
    // requested in issue #149.
    let calls = 0;
    routeHandler = (_req, res) => {
      calls++;
      res.statusCode = 500;
      res.setHeader("x-error-message", "cdn unavailable");
      res.end("backend down");
    };

    await expect(
      uploadBufferToCdn({
        buf: Buffer.from("data"),
        uploadFullUrl: `${baseUrl}/c2c/upload`,
        filekey: "fk-err",
        cdnBaseUrl: "https://unused.example",
        label: "err",
        aeskey,
      }),
    ).rejects.toThrow("cdn unavailable");
    expect(calls).toBe(3); // exhausted retries
  });

  it("large image > 1MB: upload still works", async () => {
    // Big payload to exercise chunked request transmission. The fix must not
    // regress large uploads.
    const big = crypto.randomBytes(1_500_000); // 1.5 MB
    let receivedSize = 0;
    routeHandler = (_req, res, body) => {
      receivedSize = body.length;
      res.statusCode = 200;
      res.setHeader("x-encrypted-param", "big-dl");
      res.end();
    };

    const result = await uploadBufferToCdn({
      buf: big,
      uploadFullUrl: `${baseUrl}/c2c/upload?big=1`,
      filekey: "fk-big",
      cdnBaseUrl: "https://unused.example",
      label: "big",
      aeskey,
    });
    expect(result.downloadParam).toBe("big-dl");
    // Sent ciphertext is at least as large as the plaintext (AES-ECB padded).
    expect(receivedSize).toBeGreaterThanOrEqual(big.length);
  });
});

describe("uploadBufferToCdn — additional behavior", () => {
  const aeskey = crypto.randomBytes(16);

  it("retries on server error then succeeds", async () => {
    let calls = 0;
    routeHandler = (_req, res) => {
      calls++;
      if (calls === 1) {
        res.statusCode = 500;
        res.setHeader("x-error-message", "busy");
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("x-encrypted-param", "dl-retry");
      res.end();
    };

    const result = await uploadBufferToCdn({
      buf: Buffer.from("data"),
      uploadFullUrl: `${baseUrl}/c2c/upload`,
      filekey: "fk",
      cdnBaseUrl: "https://cdn.com",
      label: "retry",
      aeskey,
    });
    expect(result.downloadParam).toBe("dl-retry");
    expect(calls).toBe(2);
  });

  it("throws immediately on 4xx client error (no retry)", async () => {
    let calls = 0;
    routeHandler = (_req, res) => {
      calls++;
      res.statusCode = 403;
      res.end("forbidden");
    };

    await expect(
      uploadBufferToCdn({
        buf: Buffer.from("data"),
        uploadFullUrl: `${baseUrl}/c2c/upload`,
        filekey: "fk",
        cdnBaseUrl: "https://cdn.com",
        label: "client-err",
        aeskey,
      }),
    ).rejects.toThrow("client error");
    expect(calls).toBe(1);
  });

  it("throws when x-encrypted-param header is missing after all retries", async () => {
    let calls = 0;
    routeHandler = (_req, res) => {
      calls++;
      // 200 OK but NO x-encrypted-param header.
      res.statusCode = 200;
      res.end();
    };

    await expect(
      uploadBufferToCdn({
        buf: Buffer.from("data"),
        uploadFullUrl: `${baseUrl}/c2c/upload`,
        filekey: "fk",
        cdnBaseUrl: "https://cdn.com",
        label: "missing-hdr",
        aeskey,
      }),
    ).rejects.toThrow("x-encrypted-param");
    expect(calls).toBe(3);
  });

  it("uses x-error-message header for 4xx when available", async () => {
    routeHandler = (_req, res) => {
      res.statusCode = 400;
      res.setHeader("x-error-message", "bad request detail");
      res.end("fallback text");
    };

    await expect(
      uploadBufferToCdn({
        buf: Buffer.from("data"),
        uploadFullUrl: `${baseUrl}/c2c/upload`,
        filekey: "fk",
        cdnBaseUrl: "https://cdn.com",
        label: "4xx",
        aeskey,
      }),
    ).rejects.toThrow("bad request detail");
  });

  it("throws when neither uploadFullUrl nor uploadParam is provided", async () => {
    await expect(
      uploadBufferToCdn({
        buf: Buffer.from("data"),
        filekey: "fk",
        cdnBaseUrl: "https://cdn.com",
        label: "no-url",
        aeskey,
      }),
    ).rejects.toThrow("CDN upload URL missing");
  });
});
