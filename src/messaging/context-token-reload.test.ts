import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// A fresh module instance stands in for a process that never ran startAccount
// (e.g. `openclaw message send` or cron delivery outside the gateway).
async function freshInbound() {
  vi.resetModules();
  return import("./inbound.js");
}

function writeTokens(stateDir: string, accountId: string, tokens: Record<string, unknown>) {
  const dir = path.join(stateDir, "openclaw-weixin", "accounts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${accountId}.context-tokens.json`), JSON.stringify(tokens));
}

describe("context token reload on miss", () => {
  let stateDir: string;
  let prevStateDir: string | undefined;

  beforeEach(() => {
    prevStateDir = process.env.OPENCLAW_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-ctx-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = prevStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("getContextToken reads a persisted token without restoreContextTokens", async () => {
    writeTokens(stateDir, "bot", { "User@im.wechat": "tok-1" });
    const inbound = await freshInbound();
    expect(inbound.getContextToken("bot", "User@im.wechat")).toBe("tok-1");
  });

  it("findAccountIdsByContextToken sees persisted tokens", async () => {
    writeTokens(stateDir, "bot", { "User@im.wechat": "tok-1" });
    const inbound = await freshInbound();
    expect(inbound.findAccountIdsByContextToken(["bot", "other"], "User@im.wechat")).toEqual([
      "bot",
    ]);
  });

  it("does not overwrite a token already held in memory", async () => {
    const inbound = await freshInbound();
    inbound.setContextToken("bot", "User@im.wechat", "fresh");
    writeTokens(stateDir, "bot", { "User@im.wechat": "stale", "Other@im.wechat": "tok-2" });
    expect(inbound.getContextToken("bot", "Other@im.wechat")).toBe("tok-2");
    expect(inbound.getContextToken("bot", "User@im.wechat")).toBe("fresh");
  });

  it("returns undefined when no file exists or the file is invalid", async () => {
    const inbound = await freshInbound();
    expect(inbound.getContextToken("bot", "User@im.wechat")).toBeUndefined();
    const dir = path.join(stateDir, "openclaw-weixin", "accounts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bad.context-tokens.json"), "{not json");
    expect(inbound.getContextToken("bad", "User@im.wechat")).toBeUndefined();
  });
});
