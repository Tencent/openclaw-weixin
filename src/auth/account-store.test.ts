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

describe("clearStaleAccountsForUserId", () => {
  it("removes only older accounts linked to the same user", async () => {
    const {
      saveWeixinAccount,
      loadWeixinAccount,
      registerWeixinAccountId,
      listIndexedWeixinAccountIds,
      clearStaleAccountsForUserId,
    } = await loadModule();
    saveWeixinAccount("account-current", {
      token: "token-current",
      userId: "user-shared",
    });
    saveWeixinAccount("account-stale", {
      token: "token-stale",
      userId: "user-shared",
    });
    saveWeixinAccount("account-other", {
      token: "token-other",
      userId: "user-other",
    });
    registerWeixinAccountId("account-current");
    registerWeixinAccountId("account-stale");
    registerWeixinAccountId("account-other");
    const clearContextTokens = vi.fn();

    clearStaleAccountsForUserId("account-current", "user-shared", clearContextTokens);

    expect(listIndexedWeixinAccountIds()).toEqual(["account-current", "account-other"]);
    expect(loadWeixinAccount("account-stale")).toBeNull();
    expect(loadWeixinAccount("account-current")).not.toBeNull();
    expect(clearContextTokens).toHaveBeenCalledOnce();
    expect(clearContextTokens).toHaveBeenCalledWith("account-stale");
  });

  it("keeps both primary and alias when keepAccountIds lists both", async () => {
    const {
      saveWeixinAccount,
      loadWeixinAccount,
      registerWeixinAccountId,
      listIndexedWeixinAccountIds,
      clearStaleAccountsForUserId,
    } = await loadModule();
    saveWeixinAccount("bot-im-bot", { token: "tok", userId: "user-a" });
    saveWeixinAccount("staff", { token: "tok", userId: "user-a" });
    saveWeixinAccount("stale-im-bot", { token: "old", userId: "user-a" });
    registerWeixinAccountId("bot-im-bot");
    registerWeixinAccountId("staff");
    registerWeixinAccountId("stale-im-bot");

    clearStaleAccountsForUserId(["bot-im-bot", "staff"], "user-a");

    expect(listIndexedWeixinAccountIds()).toEqual(["bot-im-bot", "staff"]);
    expect(loadWeixinAccount("stale-im-bot")).toBeNull();
    expect(loadWeixinAccount("staff")?.token).toBe("tok");
  });
});

describe("resolveLoginAccountAlias", () => {
  it("returns a stable human alias distinct from the bot id", async () => {
    const { resolveLoginAccountAlias } = await loadModule();
    expect(resolveLoginAccountAlias("collin", "9ff4830b870e-im-bot")).toBe("collin");
  });

  it("returns null when alias matches the primary bot id", async () => {
    const { resolveLoginAccountAlias } = await loadModule();
    expect(resolveLoginAccountAlias("9ff4830b870e-im-bot", "9ff4830b870e-im-bot")).toBeNull();
    expect(resolveLoginAccountAlias("9ff4830b870e@im.bot", "9ff4830b870e-im-bot")).toBeNull();
  });

  it("returns null for ephemeral UUID session keys", async () => {
    const { resolveLoginAccountAlias } = await loadModule();
    expect(resolveLoginAccountAlias("550e8400-e29b-41d4-a716-446655440000", "bot-im-bot")).toBeNull();
  });
});

describe("persistWeixinLoginAccounts", () => {
  it("writes only the bot id when no stable alias is requested", async () => {
    const {
      persistWeixinLoginAccounts,
      listIndexedWeixinAccountIds,
      loadWeixinAccount,
    } = await loadModule();
    const result = persistWeixinLoginAccounts({
      botAccountId: "abc@im.bot",
      token: "tok-1",
      baseUrl: "https://ilink.example.test",
      userId: "user-1@im.wechat",
    });

    expect(result).toEqual({ primaryId: "abc-im-bot", aliasId: null });
    expect(listIndexedWeixinAccountIds()).toEqual(["abc-im-bot"]);
    expect(loadWeixinAccount("abc-im-bot")).toMatchObject({
      token: "tok-1",
      userId: "user-1@im.wechat",
    });
    expect(loadWeixinAccount("collin")).toBeNull();
  });

  it("writes alias credentials alongside the bot id for multi-account login", async () => {
    const {
      persistWeixinLoginAccounts,
      listIndexedWeixinAccountIds,
      loadWeixinAccount,
    } = await loadModule();
    const result = persistWeixinLoginAccounts({
      botAccountId: "9ff4830b870e@im.bot",
      token: "tok-alias",
      baseUrl: "https://ilink.example.test",
      userId: "o9cq80zLSSEWjtr2UODlOgvt3pO4@im.wechat",
      requestedAccountId: "collin",
    });

    expect(result).toEqual({ primaryId: "9ff4830b870e-im-bot", aliasId: "collin" });
    expect(listIndexedWeixinAccountIds()).toEqual(["9ff4830b870e-im-bot", "collin"]);
    expect(loadWeixinAccount("collin")).toMatchObject({
      token: "tok-alias",
      userId: "o9cq80zLSSEWjtr2UODlOgvt3pO4@im.wechat",
    });
    expect(loadWeixinAccount("9ff4830b870e-im-bot")?.token).toBe("tok-alias");
  });

  it("does not delete the alias when clearing stale accounts for the same user", async () => {
    const {
      saveWeixinAccount,
      registerWeixinAccountId,
      persistWeixinLoginAccounts,
      loadWeixinAccount,
      listIndexedWeixinAccountIds,
    } = await loadModule();
    saveWeixinAccount("old-im-bot", { token: "old", userId: "user-shared@im.wechat" });
    registerWeixinAccountId("old-im-bot");

    persistWeixinLoginAccounts({
      botAccountId: "new@im.bot",
      token: "fresh",
      userId: "user-shared@im.wechat",
      requestedAccountId: "staff",
    });

    expect(loadWeixinAccount("old-im-bot")).toBeNull();
    expect(loadWeixinAccount("staff")?.token).toBe("fresh");
    expect(loadWeixinAccount("new-im-bot")?.token).toBe("fresh");
    expect(listIndexedWeixinAccountIds()).toEqual(["new-im-bot", "staff"]);
  });
});
