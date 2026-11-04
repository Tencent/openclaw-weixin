import { it, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cdn from "./pic-decrypt.js";
import * as media from "../media/media-download.js";
import * as outbound from "./upload.js";
vi.mock("../util/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../media/silk-transcode.js", () => ({ silkToWav: async () => undefined }));
const f = { cdn, media, outbound };
const never = () => new Promise<never>(() => {});
const runPlain = (options?: import("./download-timeout.js").DownloadOptions) =>
  f.cdn.downloadPlainCdnBuffer(
    "",
    "https://offline.invalid",
    "test",
    "https://offline.invalid/media",
    options,
  );
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
it("headers that never settle are bounded and transport is aborted", async () => {
  let signal: AbortSignal;
  (globalThis as any).fetch = async (_url: unknown, opts: any) => {
    signal = opts.signal;
    return never();
  };
  await assert.rejects(runPlain({ timeoutMs: 15 }), { name: "TimeoutError" });
  assert.equal(signal.aborted, true);
});
it("successful response body that never settles is bounded", async () => {
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, arrayBuffer: never });
  await assert.rejects(runPlain({ timeoutMs: 15 }), { name: "TimeoutError" });
});
it("error response body that never settles is bounded", async () => {
  (globalThis as any).fetch = async () => ({
    ok: false,
    status: 503,
    statusText: "unavailable",
    text: never,
  });
  await assert.rejects(runPlain({ timeoutMs: 15 }), { name: "TimeoutError" });
});
it("channel cancellation interrupts stalled fetch with exact reason", async () => {
  const controller = new AbortController();
  const reason = new Error("channel closed");
  let signal: AbortSignal;
  (globalThis as any).fetch = async (_url: unknown, opts: any) => {
    signal = opts.signal;
    return never();
  };
  const pending = runPlain({ abortSignal: controller.signal, timeoutMs: 1000 });
  controller.abort(reason);
  await assert.rejects(pending, (err: unknown) => err === reason);
  assert.equal(signal.aborted, true);
});
it("channel cancellation interrupts stalled body", async () => {
  const controller = new AbortController();
  let bodyStarted: () => void;
  const entered = new Promise((resolve) => {
    bodyStarted = resolve;
  });
  (globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: () => {
      bodyStarted();
      return never();
    },
  });
  const pending = runPlain({ abortSignal: controller.signal, timeoutMs: 1000 });
  await entered;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
it("already cancelled request does not start fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  (globalThis as any).fetch = async () => {
    calls++;
  };
  await assert.rejects(runPlain({ abortSignal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
});
it("plain bytes and real AES decryption are unchanged", async () => {
  const plain = Buffer.from("media test bytes");
  const key = Buffer.alloc(16, 42);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  (globalThis as any).fetch = async () => new Response(ciphertext);
  assert.deepEqual(
    await f.cdn.downloadAndDecryptBuffer(
      "",
      key.toString("base64"),
      "https://offline.invalid",
      "test",
      "https://offline.invalid/media",
      { timeoutMs: 1000 },
    ),
    plain,
  );
  assert.deepEqual(
    await f.cdn.downloadAndDecryptBuffer(
      "",
      Buffer.from(key.toString("hex")).toString("base64"),
      "https://offline.invalid",
      "test",
      "https://offline.invalid/media",
    ),
    plain,
  );
  (globalThis as any).fetch = async () => new Response(plain);
  assert.deepEqual(await runPlain(), plain);
});
it("strict inbound failure rejects but legacy failure remains empty", async () => {
  (globalThis as any).fetch = async () => {
    throw new Error("network unavailable");
  };
  let saves = 0;
  const deps = {
    cdnBaseUrl: "https://offline.invalid",
    saveMedia: async () => {
      saves++;
      return { path: "/fake" };
    },
    log() {},
    errLog() {},
    label: "inbound",
  };
  const item = { type: 2, image_item: { media: { full_url: "https://offline.invalid/media" } } };
  assert.deepEqual(await f.media.downloadMediaFromItem(item, deps), {});
  await assert.rejects(
    f.media.downloadMediaFromItem(item, { ...deps, throwOnError: true }),
    /network unavailable/,
  );
  assert.equal(saves, 0);
});
it("strict media timeout reaches caller without saving incomplete content", async () => {
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, arrayBuffer: never });
  let saves = 0;
  const item = { type: 2, image_item: { media: { full_url: "https://offline.invalid/media" } } };
  await assert.rejects(
    f.media.downloadMediaFromItem(item, {
      cdnBaseUrl: "https://offline.invalid",
      saveMedia: async () => {
        saves++;
      },
      log() {},
      errLog() {},
      label: "inbound",
      throwOnError: true,
      timeoutMs: 15,
    }),
    { name: "TimeoutError" },
  );
  assert.equal(saves, 0);
});
it("plain media succeeds and is saved once", async () => {
  (globalThis as any).fetch = async () => new Response("image");
  let saves = 0;
  const item = { type: 2, image_item: { media: { full_url: "https://offline.invalid/media" } } };
  const result = await f.media.downloadMediaFromItem(item, {
    cdnBaseUrl: "https://offline.invalid",
    saveMedia: async (data) => {
      assert.equal(data.toString(), "image");
      saves++;
      return { path: "/fake/image" };
    },
    log() {},
    errLog() {},
    label: "inbound",
    throwOnError: true,
  });
  assert.deepEqual(result, { decryptedPicPath: "/fake/image" });
  assert.equal(saves, 1);
});

it("outbound media hanging body times out before any temporary file is written", async () => {
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, arrayBuffer: never });
  await assert.rejects(
    f.outbound.downloadRemoteImageToTemp(
      "https://offline.invalid/media",
      "/does-not-exist/offline-test",
      { timeoutMs: 15 },
    ),
    { name: "TimeoutError" },
  );
});
it("outbound media succeeds with content-based extension", async () => {
  const dir = await fs.mkdtemp("/tmp/weixin-media-deadline-");
  try {
    (globalThis as any).fetch = async () =>
      new Response("remote-bytes", { headers: { "content-type": "image/png" } });
    const file = await f.outbound.downloadRemoteImageToTemp("https://offline.invalid/media", dir);
    assert.equal(path.extname(file), ".png");
    assert.equal(await fs.readFile(file, "utf8"), "remote-bytes");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
