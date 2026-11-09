import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadPlainCdnBuffer } from "./pic-decrypt.js";
import { downloadRemoteImageToTemp } from "./upload.js";

vi.mock("../util/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const url = "https://offline.invalid/media";
const temporaryDirectories: string[] = [];

function controlledResponse() {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
      },
      cancel: cancelled,
    }),
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  return { body, cancelled };
}

function download(options = {}) {
  return downloadPlainCdnBuffer("", "https://offline.invalid", "test", url, options);
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

describe("media download policy", () => {
  it.each([-1, 0.5, Number.NaN, 2_147_483_648])(
    "rejects an invalid total timeout before fetching: %s",
    async (timeoutMs) => {
      const fetchImpl = vi.fn();
      vi.stubGlobal("fetch", fetchImpl);
      await expect(download({ timeoutMs })).rejects.toBeInstanceOf(RangeError);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 0.5, 2_147_483_648])(
    "rejects an invalid inactivity timeout before fetching: %s",
    async (idleTimeoutMs) => {
      const fetchImpl = vi.fn();
      vi.stubGlobal("fetch", fetchImpl);
      await expect(download({ idleTimeoutMs })).rejects.toBeInstanceOf(RangeError);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("does not treat empty body chunks as download progress", async () => {
    const { body, cancelled } = controlledResponse();
    const pending = download({ idleTimeoutMs: 1000 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(800);
    body.enqueue(new Uint8Array());
    await vi.advanceTimersByTimeAsync(201);
    expect(await pending).toMatchObject({ name: "TimeoutError" });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each(["inbound", "outbound"])(
    "allows a progressing %s download to take longer than 30 seconds by default",
    async (direction) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-download-policy-"));
      temporaryDirectories.push(dir);
      const { body } = controlledResponse();
      const pending = (
        direction === "inbound" ? download() : downloadRemoteImageToTemp(url, dir)
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      for (let index = 0; index < 4; index++) {
        await vi.advanceTimersByTimeAsync(20_000);
        body.enqueue(new TextEncoder().encode("part"));
        await vi.advanceTimersByTimeAsync(0);
      }
      body.close();
      const result = await pending;
      expect(result).not.toHaveProperty("error");
      if ("value" in result) {
        const content = Buffer.isBuffer(result.value)
          ? result.value
          : await fs.readFile(result.value);
        expect(content.toString()).toBe("partpartpartpart");
      }
    },
  );

  it("bounds a stalled response header wait without a total deadline", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    let failure: unknown;
    const pending = download({ idleTimeoutMs: 1000, abortSignal: controller.signal }).catch(
      (error: unknown) => {
        failure = error;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(1001);
      expect(failure).toMatchObject({ name: "TimeoutError" });
    } finally {
      controller.abort();
      await pending;
    }
  });

  it("resets the idle deadline when bytes arrive and cancels a stalled reader", async () => {
    const { body, cancelled } = controlledResponse();
    const controller = new AbortController();
    let failure: unknown;
    const pending = download({ idleTimeoutMs: 1000, abortSignal: controller.signal }).catch(
      (error: unknown) => {
        failure = error;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(900);
      body.enqueue(new TextEncoder().encode("part"));
      await vi.advanceTimersByTimeAsync(900);
      expect(failure).toBeUndefined();
      await vi.advanceTimersByTimeAsync(101);
      expect(failure).toMatchObject({ name: "TimeoutError" });
      expect(cancelled).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await pending;
    }
  });

  it("enforces an explicitly configured total deadline despite continued progress", async () => {
    const { body } = controlledResponse();
    const pending = download({ timeoutMs: 2500, idleTimeoutMs: 1500 }).catch(
      (error: unknown) => error,
    );
    for (let index = 0; index < 2; index++) {
      await vi.advanceTimersByTimeAsync(1000);
      body.enqueue(new TextEncoder().encode("part"));
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(501);
    expect(await pending).toMatchObject({ name: "TimeoutError" });
  });

  it("allows an explicit zero total deadline while retaining progress checks", async () => {
    const { body } = controlledResponse();
    const pending = download({ timeoutMs: 0, idleTimeoutMs: 1000 }).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(500);
    body.enqueue(new TextEncoder().encode("done"));
    body.close();
    expect(await pending).toEqual(Buffer.from("done"));
  });

  it("cancels an active reader immediately with the caller's exact reason", async () => {
    const { body, cancelled } = controlledResponse();
    const controller = new AbortController();
    const reason = new Error("channel stopped");
    const pending = download({ abortSignal: controller.signal }).catch((error: unknown) => error);
    body.enqueue(new TextEncoder().encode("part"));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
