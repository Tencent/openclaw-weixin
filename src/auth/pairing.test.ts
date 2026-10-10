import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  it("returns the account-scoped path", async () => {
    const { resolveFrameworkAllowFromPath } = await loadModule();
    expect(resolveFrameworkAllowFromPath("test-account")).toBe(
      path.join(tmpDir, "credentials", "openclaw-weixin-test-account-allowFrom.json"),
    );
  });

  it("respects OPENCLAW_OAUTH_DIR", async () => {
    process.env.OPENCLAW_OAUTH_DIR = path.join(tmpDir, "custom-creds");
    const { resolveFrameworkAllowFromPath } = await loadModule();
    expect(resolveFrameworkAllowFromPath("my-bot")).toBe(
      path.join(tmpDir, "custom-creds", "openclaw-weixin-my-bot-allowFrom.json"),
    );
  });

  it("sanitizes account identifiers", async () => {
    const { resolveFrameworkAllowFromPath } = await loadModule();
    expect(resolveFrameworkAllowFromPath("abc@im.bot")).toContain(
      "openclaw-weixin-abc@im.bot-allowFrom.json",
    );
    expect(() => resolveFrameworkAllowFromPath("/")).toThrow("invalid key");
  });
});

describe("readFrameworkAllowFromList", () => {
  it("reads existing pairing entries without modifying the file", async () => {
    const { readFrameworkAllowFromList, resolveFrameworkAllowFromPath } = await loadModule();
    const filePath = resolveFrameworkAllowFromPath("account");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = JSON.stringify({ version: 1, allowFrom: ["owner", "", 42, "peer"] });
    fs.writeFileSync(filePath, content);

    expect(readFrameworkAllowFromList("account")).toEqual(["owner", "peer"]);
    expect(fs.readFileSync(filePath, "utf8")).toBe(content);
  });

  it("returns an empty list when pairing data is missing or malformed", async () => {
    const { readFrameworkAllowFromList, resolveFrameworkAllowFromPath } = await loadModule();
    expect(readFrameworkAllowFromList("account")).toEqual([]);

    const filePath = resolveFrameworkAllowFromPath("account");
    expect(fs.existsSync(filePath)).toBe(false);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not-json");
    expect(readFrameworkAllowFromList("account")).toEqual([]);
    expect(fs.readFileSync(filePath, "utf8")).toBe("not-json");
  });
});
