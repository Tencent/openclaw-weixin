import http from "node:http";
import https from "node:https";

/**
 * Response shape returned by `postBufferRaw` — a minimal subset of what we
 * need from the CDN response: numeric status, case-insensitive header lookup,
 * and a text body. We intentionally do NOT return a `fetch` `Response` here
 * because the whole point of this transport is to avoid `global fetch` for
 * CDN uploads (see issue #149).
 */
export type CdnUploadResponse = {
  status: number;
  /** Case-insensitive header lookup; returns `undefined` if absent. */
  getHeader: (name: string) => string | undefined;
  text: () => Promise<string>;
};

/**
 * POST a binary buffer to a URL using Node's built-in `node:https` / `node:http`
 * transport, bypassing `global fetch`.
 *
 * Why not `fetch`? In some live execution contexts (notably the OpenClaw
 * `message` tool path) the global `fetch` implementation exposes an empty
 * `Headers` object on otherwise successful CDN responses, even though the same
 * request succeeds in a standalone Node script and in the delivery-recovery
 * path. The Weixin CDN signals success by returning `x-encrypted-param` in the
 * response headers, so an empty `Headers` object breaks image/file/video send.
 *
 * Using `node:https` directly preserves the raw response headers as Node sees
 * them on the wire, sidestepping whatever interceptor/dispatcher in the live
 * path mangles the `fetch` headers view. See: issue #149.
 *
 * Kept as its own module so tests can mock the transport without touching the
 * retry / status / header-parsing logic in `cdn-upload.ts`.
 */
export async function postBufferRaw(
  rawUrl: string,
  body: Buffer,
): Promise<CdnUploadResponse> {
  const url = new URL(rawUrl);
  const isHttps = url.protocol === "https:";
  if (!isHttps && url.protocol !== "http:") {
    throw new Error(`unsupported protocol for CDN upload: ${url.protocol}`);
  }
  const transport = isHttps ? https : http;

  return await new Promise<CdnUploadResponse>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(body.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const rawHeaders = res.headers;
          resolve({
            status: res.statusCode ?? 0,
            getHeader: (name: string) => {
              const v = rawHeaders[name.toLowerCase()];
              if (Array.isArray(v)) return v[0];
              return v;
            },
            text: async () => Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
