import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QuoteCachePolicy } from "./quote-store.js";
import {
  QuoteStore,
  closeQuoteStore,
  deactivateQuoteStoreAccount,
  deleteQuoteCacheForAccount,
  getActiveQuoteMediaSubdir,
  getQuoteStore,
  initializeQuoteStore,
  resolveQuoteMediaSubdir,
  resolveQuoteCachePolicy,
} from "./quote-store.js";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

let rootDir: string;
let mediaRoot: string;
let stores: QuoteStore[];

function policy(overrides: Partial<QuoteCachePolicy> = {}): QuoteCachePolicy {
  return {
    enabled: true,
    retentionMs: 30 * 24 * 60 * 60 * 1000,
    maxMessagesPerAccount: 10_000,
    mediaRetentionMs: 7 * 24 * 60 * 60 * 1000,
    maxMediaBytesPerAccount: 256 * 1024 * 1024,
    maxSingleMediaBytes: 25 * 1024 * 1024,
    ...overrides,
  };
}

async function open(overrides: Partial<QuoteCachePolicy> = {}): Promise<QuoteStore> {
  const store = await QuoteStore.open({ rootDir, mediaRoot, policy: policy(overrides) });
  expect(store).not.toBeNull();
  stores.push(store!);
  return store!;
}

function managedMediaPath(accountId: string, fileName: string): string {
  const accountDir = path.join(mediaRoot, path.basename(resolveQuoteMediaSubdir(accountId)));
  fs.mkdirSync(accountDir, { recursive: true });
  return path.join(accountDir, fileName);
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-quote-store-"));
  mediaRoot = path.join(rootDir, "managed-media");
  stores = [];
});

afterEach(() => {
  closeQuoteStore();
  delete process.env.OPENCLAW_STATE_DIR;
  for (const store of stores) store.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe("QuoteStore", () => {
  it("persists lossless IDs and scopes records by account and conversation", async () => {
    const store = await open();
    const createdAt = Date.now();
    await store.put({
      accountId: "account-a",
      conversationId: "user-a",
      messageId: "18446744073709551615",
      direction: "inbound",
      body: "hello",
      createdAt,
    });

    expect(store.find("account-a", "user-a", "18446744073709551615")?.body).toBe("hello");
    expect(store.find("account-b", "user-a", "18446744073709551615")).toBeNull();
    expect(store.find("account-a", "user-b", "18446744073709551615")).toBeNull();

    store.close();
    const reopened = await open();
    expect(reopened.find("account-a", "user-a", "18446744073709551615")).toMatchObject({
      messageId: "18446744073709551615",
      body: "hello",
      createdAt,
    });
  });

  it("evicts expired and over-count messages during GC", async () => {
    const now = Date.now();
    const store = await open({ retentionMs: 100, maxMessagesPerAccount: 2 });
    for (let index = 0; index < 3; index++) {
      await store.put({
        accountId: "account",
        conversationId: "user",
        messageId: String(index),
        direction: "inbound",
        body: `message-${index}`,
        createdAt: now + index,
      });
    }
    store.runGc(now + 3);
    expect(store.find("account", "user", "0")).toBeNull();
    expect(store.find("account", "user", "1")?.body).toBe("message-1");
    expect(store.find("account", "user", "2")?.body).toBe("message-2");

    store.runGc(now + 1000);
    expect(store.find("account", "user", "1")).toBeNull();
    expect(store.find("account", "user", "2")).toBeNull();
  });

  it("registers one managed media copy and deletes it with the account", async () => {
    const store = await open();
    const source = managedMediaPath("account", "source.png");
    fs.writeFileSync(source, "same-content");
    for (const messageId of ["1", "2"]) {
      await store.put({
        accountId: "account",
        conversationId: "user",
        messageId,
        direction: "inbound",
        body: "[图片]",
        sourceMediaPath: source,
        mediaMime: "image/png",
        createdAt: Date.now(),
      });
    }
    const first = store.find("account", "user", "1");
    const second = store.find("account", "user", "2");
    expect(first?.mediaPath).toBe(second?.mediaPath);
    expect(first?.mediaPath).toBe(source);
    expect(fs.readFileSync(first!.mediaPath!, "utf8")).toBe("same-content");

    const managedPath = first!.mediaPath!;
    store.deleteAccount("account");
    expect(store.find("account", "user", "1")).toBeNull();
    expect(fs.existsSync(managedPath)).toBe(false);
  });

  it("does not let sanitized account names share a media directory", async () => {
    const store = await open();
    for (const accountId of ["a/b", "a_b"]) {
      const source = managedMediaPath(accountId, "source.png");
      fs.writeFileSync(source, "same-content");
      await store.put({
        accountId,
        conversationId: "user",
        messageId: "1",
        direction: "inbound",
        body: "[图片]",
        sourceMediaPath: source,
        createdAt: Date.now(),
      });
    }
    const firstPath = store.find("a/b", "user", "1")!.mediaPath!;
    const secondPath = store.find("a_b", "user", "1")!.mediaPath!;
    expect(path.dirname(firstPath)).not.toBe(path.dirname(secondPath));
    store.deleteAccount("a/b");
    expect(fs.existsSync(firstPath)).toBe(false);
    expect(fs.existsSync(secondPath)).toBe(true);
  });

  it("keeps message metadata but skips oversized media", async () => {
    const store = await open({ maxSingleMediaBytes: 4 });
    const source = managedMediaPath("account", "large.bin");
    fs.writeFileSync(source, "12345");
    await store.put({
      accountId: "account",
      conversationId: "user",
      messageId: "large",
      direction: "inbound",
      body: "[文件]",
      sourceMediaPath: source,
      mediaMime: "application/octet-stream",
      mediaName: "large.bin",
      createdAt: Date.now(),
    });
    expect(store.find("account", "user", "large")).toMatchObject({
      body: "[文件]",
      mediaMime: "application/octet-stream",
      mediaName: "large.bin",
    });
    expect(store.find("account", "user", "large")?.mediaPath).toBeUndefined();
  });

  it("enforces the per-account media byte budget oldest-first", async () => {
    const store = await open({ maxMediaBytesPerAccount: 4 });
    const firstSource = managedMediaPath("account", "first.bin");
    const secondSource = managedMediaPath("account", "second.bin");
    fs.writeFileSync(firstSource, "1111");
    fs.writeFileSync(secondSource, "2222");
    const now = Date.now();
    await store.put({
      accountId: "account",
      conversationId: "user",
      messageId: "1",
      direction: "inbound",
      body: "[文件]",
      sourceMediaPath: firstSource,
      createdAt: now,
    });
    await store.put({
      accountId: "account",
      conversationId: "user",
      messageId: "2",
      direction: "inbound",
      body: "[文件]",
      sourceMediaPath: secondSource,
      createdAt: now + 1,
    });
    expect(store.find("account", "user", "1")?.mediaPath).toBeUndefined();
    expect(store.find("account", "user", "2")?.mediaPath).toBeDefined();
  });

  it("expires managed media without discarding the message body", async () => {
    const store = await open({ mediaRetentionMs: 10 });
    const source = managedMediaPath("account", "old.mp3");
    fs.writeFileSync(source, "voice");
    const now = Date.now();
    await store.put({
      accountId: "account",
      conversationId: "user",
      messageId: "old-media",
      direction: "inbound",
      body: "[语音]",
      sourceMediaPath: source,
      mediaMime: "audio/mpeg",
      createdAt: now,
    });
    const managedPath = store.find("account", "user", "old-media")!.mediaPath!;
    store.runGc(now + 20);
    expect(store.find("account", "user", "old-media")).toMatchObject({
      body: "[语音]",
      mediaMime: "audio/mpeg",
    });
    expect(store.find("account", "user", "old-media")?.mediaPath).toBeUndefined();
    expect(fs.existsSync(managedPath)).toBe(false);
  });

  it("removes an expired message but preserves media shared by a newer record", async () => {
    const store = await open({ retentionMs: 100 });
    const source = managedMediaPath("account", "shared.png");
    fs.writeFileSync(source, "shared");
    const now = Date.now();
    await store.put({
      accountId: "account",
      conversationId: "user",
      messageId: "old",
      direction: "inbound",
      body: "old",
      sourceMediaPath: source,
      createdAt: now - 1000,
    });
    await store.put({
      accountId: "account",
      conversationId: "user",
      messageId: "new",
      direction: "inbound",
      body: "new",
      sourceMediaPath: source,
      createdAt: now,
    });
    const managedPath = store.find("account", "user", "new")!.mediaPath!;
    expect(store.find("account", "user", "old")).toBeNull();
    expect(fs.existsSync(managedPath)).toBe(true);
  });

  it("prunes orphan files and tolerates a missing media source", async () => {
    const store = await open();
    await store.put({
      accountId: "account",
      conversationId: "user",
      messageId: "missing",
      direction: "inbound",
      body: "[文件]",
      sourceMediaPath: path.join(rootDir, "does-not-exist.bin"),
      createdAt: Date.now(),
    });
    expect(store.find("account", "user", "missing")?.mediaPath).toBeUndefined();

    const orphanDir = path.join(mediaRoot, "nested");
    fs.mkdirSync(orphanDir, { recursive: true });
    const orphan = path.join(orphanDir, "orphan.bin");
    fs.writeFileSync(orphan, "orphan");
    store.runGc();
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("applies policy updates asynchronously", async () => {
    const store = await open();
    const now = Date.now();
    for (const messageId of ["1", "2"]) {
      await store.put({
        accountId: "account",
        conversationId: "user",
        messageId,
        direction: "inbound",
        body: messageId,
        createdAt: now,
      });
    }
    store.updatePolicy(policy({ maxMessagesPerAccount: 1 }));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const remaining = ["1", "2"].filter((id) => store.find("account", "user", id));
    expect(remaining).toHaveLength(1);
  });

  it("does not open when explicitly disabled", async () => {
    await expect(
      QuoteStore.open({ rootDir, policy: policy({ enabled: false }) }),
    ).resolves.toBeNull();
  });

  it("returns null when the database directory cannot be created", async () => {
    const fileInsteadOfDirectory = path.join(rootDir, "plain-file");
    fs.writeFileSync(fileInsteadOfDirectory, "not a directory");
    await expect(
      QuoteStore.open({
        rootDir: path.join(fileInsteadOfDirectory, "child"),
        policy: policy(),
      }),
    ).resolves.toBeNull();
  });

  it("ignores invalid writes, isolates unsafe account names, and substitutes invalid timestamps", async () => {
    const store = await open();
    const source = managedMediaPath("   ", "media");
    fs.writeFileSync(source, "content");
    await store.put({
      accountId: "   ",
      conversationId: "user",
      messageId: "media",
      direction: "inbound",
      body: "[文件]",
      sourceMediaPath: source,
      createdAt: Number.NaN,
    });
    const record = store.find("   ", "user", "media");
    expect(record?.createdAt).toBeGreaterThan(0);
    expect(record?.mediaPath).toContain(`${path.sep}default-`);
    expect(path.extname(record!.mediaPath!)).toBe("");

    await store.put({
      accountId: "account",
      conversationId: "user",
      messageId: "",
      direction: "inbound",
      body: "ignored",
      createdAt: Date.now(),
    });
    await store.put({
      accountId: "account",
      conversationId: "user",
      messageId: "empty",
      direction: "inbound",
      body: "",
      createdAt: Date.now(),
    });
    expect(store.find("account", "user", "")).toBeNull();
    expect(store.find("account", "user", "empty")).toBeNull();

    store.close();
    await store.put({
      accountId: "account",
      conversationId: "user",
      messageId: "closed",
      direction: "inbound",
      body: "ignored",
      createdAt: Date.now(),
    });
    expect(store.find("account", "user", "closed")).toBeNull();
    store.deleteAccount("account");
    store.runGc();
  });

  it("refuses to claim media outside its account-owned directory", async () => {
    const source = path.join(rootDir, "outside.bin");
    fs.writeFileSync(source, "content");
    const store = await open();
    await store.put({
      accountId: "account",
      conversationId: "user",
      messageId: "outside",
      direction: "inbound",
      body: "[文件]",
      sourceMediaPath: source,
      createdAt: Date.now(),
    });
    expect(store.find("account", "user", "outside")?.mediaPath).toBeUndefined();
    expect(fs.existsSync(source)).toBe(true);
  });

  it("moves legacy media into the OpenClaw-managed cache and rewrites its database path", async () => {
    const legacyRoot = path.join(rootDir, "ref-media");
    const legacyStore = await QuoteStore.open({
      rootDir,
      mediaRoot: legacyRoot,
      policy: policy(),
    });
    expect(legacyStore).not.toBeNull();
    stores.push(legacyStore!);
    const legacyPath = path.join(
      legacyRoot,
      path.basename(resolveQuoteMediaSubdir("account")),
      "legacy.pdf",
    );
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, "pdf");
    await legacyStore!.put({
      accountId: "account",
      conversationId: "user",
      messageId: "legacy",
      direction: "inbound",
      body: "[文件]",
      sourceMediaPath: legacyPath,
      mediaName: "report.pdf",
      createdAt: Date.now(),
    });
    await legacyStore!.put({
      accountId: "account",
      conversationId: "user",
      messageId: "legacy-shared",
      direction: "inbound",
      body: "[文件]",
      sourceMediaPath: legacyPath,
      mediaName: "report.pdf",
      createdAt: Date.now(),
    });

    const existingLegacyPath = path.join(path.dirname(legacyPath), "existing.pdf");
    fs.writeFileSync(existingLegacyPath, "existing");
    await legacyStore!.put({
      accountId: "account",
      conversationId: "user",
      messageId: "existing",
      direction: "inbound",
      body: "[文件]",
      sourceMediaPath: existingLegacyPath,
      createdAt: Date.now(),
    });
    const existingManagedPath = managedMediaPath("account", "existing.pdf");
    fs.writeFileSync(existingManagedPath, "existing");

    const missingLegacyPath = path.join(path.dirname(legacyPath), "missing.pdf");
    fs.writeFileSync(missingLegacyPath, "missing");
    await legacyStore!.put({
      accountId: "account",
      conversationId: "user",
      messageId: "missing-legacy",
      direction: "inbound",
      body: "[文件]",
      sourceMediaPath: missingLegacyPath,
      createdAt: Date.now(),
    });
    fs.unlinkSync(missingLegacyPath);
    legacyStore!.close();

    const migratedStore = await open();
    const migrated = migratedStore.find("account", "user", "legacy");
    expect(migrated?.mediaPath).toBe(managedMediaPath("account", "legacy.pdf"));
    expect(migrated?.mediaName).toBe("report.pdf");
    expect(fs.existsSync(migrated!.mediaPath!)).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(migratedStore.find("account", "user", "legacy-shared")?.mediaPath).toBe(
      migrated?.mediaPath,
    );
    expect(migratedStore.find("account", "user", "existing")?.mediaPath).toBe(existingManagedPath);
    expect(fs.existsSync(existingLegacyPath)).toBe(false);
  });
});

describe("global quote store lifecycle", () => {
  it("shares one store across active accounts and closes after the last account stops", async () => {
    process.env.OPENCLAW_STATE_DIR = rootDir;
    expect(getActiveQuoteMediaSubdir("account-a")).toBeUndefined();
    const first = await initializeQuoteStore({}, "account-a");
    const second = await initializeQuoteStore({}, "account-b");
    expect(first).toBe(second);
    expect(getQuoteStore()).toBe(first);
    expect(getActiveQuoteMediaSubdir("account-a")).toBe(resolveQuoteMediaSubdir("account-a"));

    deactivateQuoteStoreAccount("account-a");
    expect(getQuoteStore()).toBe(first);
    deactivateQuoteStoreAccount("account-b");
    expect(getQuoteStore()).toBeNull();
  });

  it("honors explicit disablement", async () => {
    process.env.OPENCLAW_STATE_DIR = rootDir;
    await expect(
      initializeQuoteStore(
        {
          channels: { "openclaw-weixin": { quoteCache: { enabled: false } } },
        },
        "account",
      ),
    ).resolves.toBeNull();
    expect(getQuoteStore()).toBeNull();
  });

  it("closes an already-active store when the feature is disabled", async () => {
    process.env.OPENCLAW_STATE_DIR = rootDir;
    expect(await initializeQuoteStore({}, "account")).not.toBeNull();
    await expect(
      initializeQuoteStore(
        {
          channels: { "openclaw-weixin": { quoteCache: { enabled: false } } },
        },
        "account",
      ),
    ).resolves.toBeNull();
    expect(getQuoteStore()).toBeNull();
  });

  it("deletes an account through the active singleton", async () => {
    process.env.OPENCLAW_STATE_DIR = rootDir;
    const store = await initializeQuoteStore({}, "account");
    await store!.put({
      accountId: "account",
      conversationId: "user",
      messageId: "1",
      direction: "inbound",
      body: "hello",
      createdAt: Date.now(),
    });
    deleteQuoteCacheForAccount("account");
    expect(store!.find("account", "user", "1")).toBeNull();
  });

  it("deletes an account from a closed on-disk database", async () => {
    process.env.OPENCLAW_STATE_DIR = rootDir;
    const managedRoot = path.join(rootDir, "openclaw-weixin");
    const store = await QuoteStore.open({ rootDir: managedRoot, policy: policy() });
    expect(store).not.toBeNull();
    await store!.put({
      accountId: "account",
      conversationId: "user",
      messageId: "1",
      direction: "inbound",
      body: "hello",
      createdAt: Date.now(),
    });
    store!.close();

    deleteQuoteCacheForAccount("account");
    const reopened = await QuoteStore.open({ rootDir: managedRoot, policy: policy() });
    expect(reopened?.find("account", "user", "1")).toBeNull();
    reopened?.close();
  });
});

describe("resolveQuoteCachePolicy", () => {
  it("uses safe defaults and honors explicit disablement", () => {
    expect(resolveQuoteCachePolicy({})).toMatchObject({
      enabled: true,
      maxMessagesPerAccount: 10_000,
      maxMediaBytesPerAccount: 256 * 1024 * 1024,
    });
    expect(
      resolveQuoteCachePolicy({
        channels: { "openclaw-weixin": { quoteCache: { enabled: false } } },
      }),
    ).toMatchObject({ enabled: false });
  });

  it("accepts positive limits and replaces invalid values with defaults", () => {
    expect(
      resolveQuoteCachePolicy({
        channels: {
          "openclaw-weixin": {
            quoteCache: {
              retentionDays: 2,
              maxMessagesPerAccount: 3.9,
              mediaRetentionDays: 4,
              maxMediaBytesPerAccount: 5,
              maxSingleMediaBytes: 6,
            },
          },
        },
      }),
    ).toMatchObject({
      retentionMs: 2 * 24 * 60 * 60 * 1000,
      maxMessagesPerAccount: 3,
      mediaRetentionMs: 4 * 24 * 60 * 60 * 1000,
      maxMediaBytesPerAccount: 5,
      maxSingleMediaBytes: 6,
    });
    expect(
      resolveQuoteCachePolicy({
        channels: {
          "openclaw-weixin": {
            quoteCache: {
              retentionDays: Number.NaN,
              maxMessagesPerAccount: 0,
              mediaRetentionDays: -1,
              maxMediaBytesPerAccount: Number.POSITIVE_INFINITY,
              maxSingleMediaBytes: 0,
            },
          },
        },
      }),
    ).toMatchObject({
      maxMessagesPerAccount: 10_000,
      maxMediaBytesPerAccount: 256 * 1024 * 1024,
      maxSingleMediaBytes: 25 * 1024 * 1024,
    });
  });
});
