import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-buf-test-"));
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadModule() {
  vi.resetModules();
  return await import("./sync-buf.js");
}

describe("getSyncBufFilePath", () => {
  it("returns path under accounts dir", async () => {
    const { getSyncBufFilePath } = await loadModule();
    const result = getSyncBufFilePath("myacc");
    expect(result).toBe(path.join(tmpDir, "openclaw-weixin", "accounts", "myacc.sync.json"));
  });
});

describe("loadGetUpdatesBuf", () => {
  it("returns undefined when file does not exist", async () => {
    const { loadGetUpdatesBuf, getSyncBufFilePath } = await loadModule();
    const fp = getSyncBufFilePath("nonexistent");
    expect(loadGetUpdatesBuf(fp)).toBeUndefined();
  });

  it("reads get_updates_buf from file", async () => {
    const { loadGetUpdatesBuf, getSyncBufFilePath } = await loadModule();
    const fp = getSyncBufFilePath("acc1");
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify({ get_updates_buf: "buf-data" }));
    expect(loadGetUpdatesBuf(fp)).toBe("buf-data");
  });

  it("falls back to compat path for -im-bot suffix", async () => {
    const { loadGetUpdatesBuf, getSyncBufFilePath } = await loadModule();
    const fp = getSyncBufFilePath("abc-im-bot");
    // Write at old raw-ID filename
    const dir = path.join(tmpDir, "openclaw-weixin", "accounts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "abc@im.bot.sync.json"), JSON.stringify({ get_updates_buf: "compat-buf" }));
    expect(loadGetUpdatesBuf(fp)).toBe("compat-buf");
  });

  it("falls back to legacy sync buf path", async () => {
    const { loadGetUpdatesBuf, getSyncBufFilePath } = await loadModule();
    const fp = getSyncBufFilePath("someacc");
    // Write at legacy path
    const legacyDir = path.join(tmpDir, "agents", "default", "sessions", ".openclaw-weixin-sync");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "default.json"), JSON.stringify({ get_updates_buf: "legacy-buf" }));
    expect(loadGetUpdatesBuf(fp)).toBe("legacy-buf");
  });

  it("returns undefined on corrupted file", async () => {
    const { loadGetUpdatesBuf, getSyncBufFilePath } = await loadModule();
    const fp = getSyncBufFilePath("bad");
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, "not json");
    expect(loadGetUpdatesBuf(fp)).toBeUndefined();
  });
});

describe("saveGetUpdatesBuf", () => {
  it("persists get_updates_buf to file", async () => {
    const { saveGetUpdatesBuf, loadGetUpdatesBuf, getSyncBufFilePath } = await loadModule();
    const fp = getSyncBufFilePath("acc-save");
    saveGetUpdatesBuf(fp, "saved-buf");
    expect(loadGetUpdatesBuf(fp)).toBe("saved-buf");
  });

  it("creates parent directory if needed", async () => {
    const { saveGetUpdatesBuf, getSyncBufFilePath } = await loadModule();
    const fp = getSyncBufFilePath("new-acc");
    expect(fs.existsSync(path.dirname(fp))).toBe(false);
    saveGetUpdatesBuf(fp, "buf");
    expect(fs.existsSync(path.dirname(fp))).toBe(true);
  });
});
