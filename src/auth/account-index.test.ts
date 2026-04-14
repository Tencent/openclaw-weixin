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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-index-test-"));
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadModule() {
  vi.resetModules();
  return await import("./accounts.js");
}

describe("listIndexedWeixinAccountIds", () => {
  it("returns empty array when file does not exist", async () => {
    const { listIndexedWeixinAccountIds } = await loadModule();
    expect(listIndexedWeixinAccountIds()).toEqual([]);
  });

  it("returns account ids from file", async () => {
    const { listIndexedWeixinAccountIds } = await loadModule();
    const dir = path.join(tmpDir, "openclaw-weixin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "accounts.json"), JSON.stringify(["acc1", "acc2"]));
    expect(listIndexedWeixinAccountIds()).toEqual(["acc1", "acc2"]);
  });

  it("filters out non-string and empty entries", async () => {
    const { listIndexedWeixinAccountIds } = await loadModule();
    const dir = path.join(tmpDir, "openclaw-weixin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "accounts.json"), JSON.stringify(["acc1", 42, "", "  ", "acc2"]));
    expect(listIndexedWeixinAccountIds()).toEqual(["acc1", "acc2"]);
  });

  it("returns empty on corrupted file", async () => {
    const { listIndexedWeixinAccountIds } = await loadModule();
    const dir = path.join(tmpDir, "openclaw-weixin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "accounts.json"), "bad json");
    expect(listIndexedWeixinAccountIds()).toEqual([]);
  });

  it("returns empty when file contains non-array", async () => {
    const { listIndexedWeixinAccountIds } = await loadModule();
    const dir = path.join(tmpDir, "openclaw-weixin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "accounts.json"), JSON.stringify({ foo: "bar" }));
    expect(listIndexedWeixinAccountIds()).toEqual([]);
  });
});

describe("registerWeixinAccountId", () => {
  it("creates index file with new account", async () => {
    const { registerWeixinAccountId, listIndexedWeixinAccountIds } = await loadModule();
    registerWeixinAccountId("new-acc");
    expect(listIndexedWeixinAccountIds()).toEqual(["new-acc"]);
  });

  it("does not duplicate existing account", async () => {
    const { registerWeixinAccountId, listIndexedWeixinAccountIds } = await loadModule();
    registerWeixinAccountId("acc1");
    registerWeixinAccountId("acc1");
    expect(listIndexedWeixinAccountIds()).toEqual(["acc1"]);
  });

  it("appends to existing list", async () => {
    const { registerWeixinAccountId, listIndexedWeixinAccountIds } = await loadModule();
    registerWeixinAccountId("acc1");
    registerWeixinAccountId("acc2");
    expect(listIndexedWeixinAccountIds()).toEqual(["acc1", "acc2"]);
  });
});
