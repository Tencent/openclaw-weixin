import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock dependencies before importing module under test
vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Use a temp directory for all fs operations
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-store-test-"));
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Dynamic import so mocks are applied and env is set before module init
async function loadModule() {
  // Clear module cache to pick up new env
  vi.resetModules();
  return await import("./accounts.js");
}

describe("loadWeixinAccount", () => {
  it("returns null when no account file exists", async () => {
    const { loadWeixinAccount } = await loadModule();
    expect(loadWeixinAccount("nonexistent")).toBeNull();
  });

  it("loads account data from primary path", async () => {
    const { loadWeixinAccount } = await loadModule();
    const dir = path.join(tmpDir, "openclaw-weixin", "accounts");
    fs.mkdirSync(dir, { recursive: true });
    const data = { token: "tk", savedAt: "2024-01-01", baseUrl: "https://example.com" };
    fs.writeFileSync(path.join(dir, "myacc.json"), JSON.stringify(data));
    const result = loadWeixinAccount("myacc");
    expect(result).toEqual(data);
  });

  it("falls back to raw accountId (compat path) for -im-bot suffix", async () => {
    const { loadWeixinAccount } = await loadModule();
    const dir = path.join(tmpDir, "openclaw-weixin", "accounts");
    fs.mkdirSync(dir, { recursive: true });
    const data = { token: "old-token" };
    // Write at old raw ID path
    fs.writeFileSync(path.join(dir, "abc@im.bot.json"), JSON.stringify(data));
    const result = loadWeixinAccount("abc-im-bot");
    expect(result).toEqual(data);
  });

  it("falls back to legacy credentials path", async () => {
    const { loadWeixinAccount } = await loadModule();
    const legacyDir = path.join(tmpDir, "credentials", "openclaw-weixin");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "credentials.json"), JSON.stringify({ token: "legacy-tk" }));
    const result = loadWeixinAccount("some-acc");
    expect(result).toEqual({ token: "legacy-tk" });
  });

  it("returns null on corrupted file", async () => {
    const { loadWeixinAccount } = await loadModule();
    const dir = path.join(tmpDir, "openclaw-weixin", "accounts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bad.json"), "not json");
    expect(loadWeixinAccount("bad")).toBeNull();
  });
});

describe("saveWeixinAccount", () => {
  it("saves token and baseUrl", async () => {
    const { saveWeixinAccount, loadWeixinAccount } = await loadModule();
    saveWeixinAccount("acc1", { token: "tok", baseUrl: "https://api.example.com" });
    const data = loadWeixinAccount("acc1");
    expect(data?.token).toBe("tok");
    expect(data?.baseUrl).toBe("https://api.example.com");
    expect(data?.savedAt).toBeDefined();
  });

  it("merges with existing data", async () => {
    const { saveWeixinAccount, loadWeixinAccount } = await loadModule();
    saveWeixinAccount("acc3", { token: "tok1", baseUrl: "https://a.com" });
    saveWeixinAccount("acc3", { baseUrl: "https://b.com" });
    const data = loadWeixinAccount("acc3");
    expect(data?.token).toBe("tok1");
    expect(data?.baseUrl).toBe("https://b.com");
  });

  it("creates directory if it does not exist", async () => {
    const { saveWeixinAccount } = await loadModule();
    const accountsDir = path.join(tmpDir, "openclaw-weixin", "accounts");
    expect(fs.existsSync(accountsDir)).toBe(false);
    saveWeixinAccount("new-acc", { token: "tok" });
    expect(fs.existsSync(accountsDir)).toBe(true);
  });
});

describe("clearWeixinAccount", () => {
  it("removes account file", async () => {
    const { saveWeixinAccount, clearWeixinAccount, loadWeixinAccount } = await loadModule();
    saveWeixinAccount("acc-del", { token: "tok" });
    expect(loadWeixinAccount("acc-del")).not.toBeNull();
    clearWeixinAccount("acc-del");
    expect(loadWeixinAccount("acc-del")).toBeNull();
  });

  it("does not throw when file does not exist", async () => {
    const { clearWeixinAccount } = await loadModule();
    expect(() => clearWeixinAccount("nonexistent")).not.toThrow();
  });
});
