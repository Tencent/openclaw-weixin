import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sendWeixinMediaFile } from "../messaging/send-media.js";
vi.mock("../util/logger.js", () => ({ logger: { info() {}, debug() {}, warn() {}, error() {} } }));
afterEach(() => vi.unstubAllGlobals());
it.each(["getuploadurl", "cdn"])(
  "cancels a media upload during %s without retrying",
  async (stage) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-upload-cancel-"));
    const file = path.join(root, "image.png");
    fs.writeFileSync(file, Buffer.from("image"));
    const controller = new AbortController();
    let started = false;
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        requests.push(url);
        if (stage === "cdn" && url.includes("getuploadurl"))
          return Response.json({ upload_full_url: "https://offline.invalid/cdn" });
        started = true;
        return new Promise<Response>((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal!.reason), {
            once: true,
          });
        });
      }),
    );
    const done = sendWeixinMediaFile({
      filePath: file,
      to: "user",
      text: "",
      cdnBaseUrl: "https://offline.invalid",
      opts: { baseUrl: "https://offline.invalid", abortSignal: controller.signal },
    });
    const stopped = expect(done).rejects.toThrow();
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      controller.abort();
      await stopped;
      expect(requests).toHaveLength(stage === "cdn" ? 2 : 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
