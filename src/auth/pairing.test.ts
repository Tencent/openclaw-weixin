import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-test-"));
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_OAUTH_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadModule() {
  vi.resetModules();
  return await import("./pairing.js");
}

describe("resolveFrameworkAllowFromPath", () => {
  it("returns correct path for a given accountId", async () => {
    const { resolveFrameworkAllowFromPath } = await loadModule();
    const result = resolveFrameworkAllowFromPath("test-account");
    expect(result).toBe(
      path.join(tmpDir, "credentials", "openclaw-weixin-test-account-allowFrom.json"),
    );
  });

  it("respects OPENCLAW_OAUTH_DIR override", async () => {
    const customDir = path.join(tmpDir, "custom-creds");
    process.env.OPENCLAW_OAUTH_DIR = customDir;
    const { resolveFrameworkAllowFromPath } = await loadModule();
    const result = resolveFrameworkAllowFromPath("my-bot");
    expect(result).toBe(path.join(customDir, "openclaw-weixin-my-bot-allowFrom.json"));
  });

  it("sanitizes special characters in accountId", async () => {
    const { resolveFrameworkAllowFromPath } = await loadModule();
    const result = resolveFrameworkAllowFromPath("abc@im.bot");
    // Only [\\/:*?"<>|] and ".." are replaced; @ and dots are preserved
    expect(result).toContain("openclaw-weixin-abc@im.bot-allowFrom.json");
  });
});

describe("readFrameworkAllowFromList", () => {
  it("reads existing paired IDs without rewriting the credentials file", async () => {
    const { readFrameworkAllowFromList, resolveFrameworkAllowFromPath } = await loadModule();
    const filePath = resolveFrameworkAllowFromPath("existing-account");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const saved = JSON.stringify({ version: 1, allowFrom: ["owner", "second-user", "", 42] });
    fs.writeFileSync(filePath, saved);

    expect(readFrameworkAllowFromList("existing-account")).toEqual(["owner", "second-user"]);
    expect(fs.readFileSync(filePath, "utf-8")).toBe(saved);
  });

  it("returns an empty list without creating a missing credentials file", async () => {
    const { readFrameworkAllowFromList, resolveFrameworkAllowFromPath } = await loadModule();
    expect(readFrameworkAllowFromList("missing-account")).toEqual([]);
    expect(fs.existsSync(resolveFrameworkAllowFromPath("missing-account"))).toBe(false);
  });

  it("leaves an unreadable credentials file untouched", async () => {
    const { readFrameworkAllowFromList, resolveFrameworkAllowFromPath } = await loadModule();
    const filePath = resolveFrameworkAllowFromPath("corrupt-account");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not valid json");
    expect(readFrameworkAllowFromList("corrupt-account")).toEqual([]);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("not valid json");
  });
});
