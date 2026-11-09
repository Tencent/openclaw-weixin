import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import { resolveStateDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_MESSAGES_PER_ACCOUNT = 10_000;
const DEFAULT_MEDIA_RETENTION_DAYS = 7;
const DEFAULT_MAX_MEDIA_BYTES_PER_ACCOUNT = 256 * 1024 * 1024;
const DEFAULT_MAX_SINGLE_MEDIA_BYTES = 25 * 1024 * 1024;
const GC_WRITE_INTERVAL = 100;
const GC_TIMER_MS = 60 * 60 * 1000;
const QUOTE_MEDIA_SUBDIR = "inbound/openclaw-weixin-quotes";

export type QuoteMediaStorage =
  | { mode: "inbound" }
  | { mode: "managed" }
  | { mode: "custom"; directory: string };

type SqliteStatement = {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
};

type DatabaseSyncConstructor = new (
  filePath: string,
  options?: { readOnly?: boolean },
) => SqliteDatabase;

export type QuoteCachePolicy = {
  enabled: boolean;
  mediaStorage: QuoteMediaStorage;
  retentionMs: number;
  maxMessagesPerAccount: number;
  mediaRetentionMs: number;
  maxMediaBytesPerAccount: number;
  maxSingleMediaBytes: number;
};

export type QuoteMediaRecord = {
  mediaPath?: string;
  mediaMime?: string;
  mediaName?: string;
  mediaSize?: number;
};

export type QuoteMediaInput = {
  sourceMediaPath: string;
  mediaMime?: string;
  mediaName?: string;
};

export type QuoteMessageRecord = {
  accountId: string;
  conversationId: string;
  messageId: string;
  direction: "inbound" | "outbound";
  body: string;
  mediaPath?: string;
  mediaMime?: string;
  mediaName?: string;
  mediaSize?: number;
  media?: QuoteMediaRecord[];
  createdAt: number;
};

export type QuoteMessageInput = Omit<QuoteMessageRecord, "mediaPath" | "mediaSize" | "media"> & {
  sourceMediaPath?: string;
  media?: QuoteMediaInput[];
};

type StoredMedia = { path?: string; owned: boolean; mime?: string; name?: string; size?: number };

function mediaRecord(media: StoredMedia): QuoteMediaRecord {
  return {
    ...(media.path ? { mediaPath: media.path } : {}),
    ...(media.mime ? { mediaMime: media.mime } : {}),
    ...(media.name ? { mediaName: media.name } : {}),
    ...(media.size !== undefined ? { mediaSize: media.size } : {}),
  };
}

// Shared across store replacement so an old in-flight turn survives channel reload.
const activeMediaPaths = new Map<string, number>();
// Only files created in, or verified as owned by, a managed media directory enter here.
const pendingOwnedMediaPaths = new Map<string, string>();

/** Old on-disk databases can be deleted before the additive migration has run. */
function mediaReferenceTable(db: SqliteDatabase): string {
  return db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'quote_media_refs'")
    .get()
    ? "quote_media_refs"
    : "quote_messages";
}

type QuoteCacheConfig = {
  enabled?: boolean;
  mediaStorage?: QuoteMediaStorage;
  retentionDays?: number;
  maxMessagesPerAccount?: number;
  mediaRetentionDays?: number;
  maxMediaBytesPerAccount?: number;
  maxSingleMediaBytes?: number;
};

type WeixinChannelConfig = {
  quoteCache?: QuoteCacheConfig;
};

type StoredRow = {
  account_id: string;
  conversation_id: string;
  message_id: string;
  direction: "inbound" | "outbound";
  body: string;
  media_path: string | null;
  media_owned?: number;
  media_mime: string | null;
  media_name: string | null;
  media_size: number | null;
  media_items: string;
  created_at: number;
};

type MediaRow = {
  media_path: string;
  media_size: number;
  newest_at: number;
};

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return Math.max(1, Math.floor(positiveNumber(value, fallback)));
}

export function resolveQuoteCachePolicy(cfg: OpenClawConfig): QuoteCachePolicy {
  const section = cfg.channels?.["openclaw-weixin"] as WeixinChannelConfig | undefined;
  const quote = section?.quoteCache;
  return {
    enabled: quote?.enabled !== false,
    mediaStorage: quote?.mediaStorage ?? { mode: "managed" },
    retentionMs: positiveNumber(quote?.retentionDays, DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000,
    maxMessagesPerAccount: positiveInteger(
      quote?.maxMessagesPerAccount,
      DEFAULT_MAX_MESSAGES_PER_ACCOUNT,
    ),
    mediaRetentionMs:
      positiveNumber(quote?.mediaRetentionDays, DEFAULT_MEDIA_RETENTION_DAYS) * 24 * 60 * 60 * 1000,
    maxMediaBytesPerAccount: positiveInteger(
      quote?.maxMediaBytesPerAccount,
      DEFAULT_MAX_MEDIA_BYTES_PER_ACCOUNT,
    ),
    maxSingleMediaBytes: positiveInteger(
      quote?.maxSingleMediaBytes,
      DEFAULT_MAX_SINGLE_MEDIA_BYTES,
    ),
  };
}

function safePathSegment(raw: string): string {
  const safe = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/\.\.+/g, "_");
  return safe && safe !== "." && safe !== ".." ? safe : "default";
}

function accountMediaDirName(accountId: string): string {
  const readable = safePathSegment(accountId).slice(0, 48);
  const digest = crypto.createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 16);
  return `${readable}-${digest}`;
}

/** OpenClaw media-store subdirectory owned and garbage-collected by this plugin. */
export function resolveQuoteMediaSubdir(accountId: string): string {
  return path.posix.join(QUOTE_MEDIA_SUBDIR, accountMediaDirName(accountId));
}

function resolveQuoteMediaRoot(storage: QuoteMediaStorage): string {
  if (storage.mode === "custom") {
    if (!path.isAbsolute(storage.directory)) {
      throw new Error("quoteCache.mediaStorage.directory must be an absolute path");
    }
    return path.resolve(storage.directory);
  }
  if (storage.mode === "inbound") {
    return path.join(resolveStateDir(), "media", "inbound");
  }
  return path.join(resolveStateDir(), "media", ...QUOTE_MEDIA_SUBDIR.split("/"));
}

function assertDirectoryWritable(directory: string): void {
  const probePath = path.join(directory, `.openclaw-weixin-write-check-${crypto.randomUUID()}`);
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(probePath, "wx", 0o600);
    created = true;
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } finally {
      if (created) {
        try {
          fs.unlinkSync(probePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    }
  }
}

function removeUnreferencedMediaFiles(
  db: SqliteDatabase,
  directory: string,
  mediaRoot = path.dirname(directory),
): void {
  try {
    const mediaRootStat = fs.lstatSync(mediaRoot);
    if (!mediaRootStat.isDirectory() || mediaRootStat.isSymbolicLink()) return;
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    logger.warn(`quote cache: failed to inspect media directory=${directory}: ${String(err)}`);
    return;
  }
  const isReferenced = db.prepare(
    `SELECT 1 AS found FROM ${mediaReferenceTable(db)} WHERE media_path = ? LIMIT 1`,
  );
  const visit = (currentDirectory: string) => {
    for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
      const fullPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && !activeMediaPaths.has(fullPath) && !isReferenced.get(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.warn(
              `quote cache: failed to remove unreferenced media path=${fullPath}: ${String(err)}`,
            );
          }
        }
      }
    }
  };
  try {
    visit(directory);
    try {
      fs.rmdirSync(directory);
    } catch (err) {
      if (!["ENOENT", "ENOTEMPTY"].includes((err as NodeJS.ErrnoException).code ?? "")) {
        throw err;
      }
    }
  } catch (err) {
    logger.warn(`quote cache: failed to prune media directory=${directory}: ${String(err)}`);
  }
}

function resolveConfiguredCustomMediaRoot(): string | null {
  const configPath =
    process.env.OPENCLAW_CONFIG?.trim() || path.join(resolveStateDir(), "openclaw.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      channels?: Record<string, { quoteCache?: { mediaStorage?: QuoteMediaStorage } }>;
    };
    const storage = config.channels?.["openclaw-weixin"]?.quoteCache?.mediaStorage;
    return storage?.mode === "custom" && path.isAbsolute(storage.directory)
      ? path.resolve(storage.directory)
      : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(
        `quote cache: failed to read media storage config path=${configPath}: ${String(err)}`,
      );
    }
    return null;
  }
}

function mediaFileExtension(buffer: Buffer, contentType?: string): string {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mime) {
    const known: Record<string, string> = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "video/mp4": ".mp4",
      "audio/wav": ".wav",
      "audio/silk": ".silk",
      "application/pdf": ".pdf",
    };
    if (known[mime]) return known[mime];
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return ".jpg";
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ".png";
  if (buffer.subarray(0, 4).toString("ascii") === "GIF8") return ".gif";
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return ".webp";
  }
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") return ".mp4";
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return ".pdf";
  return ".bin";
}

function asStoredRow(value: unknown): StoredRow | null {
  if (!value || typeof value !== "object") return null;
  return value as StoredRow;
}

export class QuoteStore {
  private readonly db: SqliteDatabase;
  private readonly mediaRoot: string;
  private readonly mediaStorage: QuoteMediaStorage;
  private readonly databasePath: string;
  private policy: QuoteCachePolicy;
  private writesSinceGc = 0;
  private gcRunning = false;
  private gcRequested = false;
  private gcScheduled = false;
  private closed = false;
  private gcDeferred = false;
  private readonly gcTimer: ReturnType<typeof setInterval>;

  private constructor(
    db: SqliteDatabase,
    mediaRoot: string,
    policy: QuoteCachePolicy,
    databasePath: string,
  ) {
    this.db = db;
    this.mediaRoot = mediaRoot;
    this.mediaStorage = policy.mediaStorage;
    this.policy = policy;
    this.databasePath = databasePath;
    this.initializeSchema();
    this.gcTimer = setInterval(() => this.requestGc(), GC_TIMER_MS);
    this.gcTimer.unref();
    this.runGc();
  }

  static async open(params: {
    policy: QuoteCachePolicy;
    rootDir?: string;
    mediaRoot?: string;
  }): Promise<QuoteStore | null> {
    if (!params.policy.enabled) return null;
    let initializationStep = "loading node:sqlite";
    let db: SqliteDatabase | undefined;
    try {
      const sqlite = (await import("node:sqlite")) as unknown as {
        DatabaseSync: DatabaseSyncConstructor;
      };
      const rootDir = params.rootDir ?? path.join(resolveStateDir(), "openclaw-weixin");
      initializationStep = "resolving Quote Cache media storage";
      const mediaRoot = params.mediaRoot ?? resolveQuoteMediaRoot(params.policy.mediaStorage);
      initializationStep = "creating Quote Cache storage directories";
      fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(rootDir, 0o700);
      } catch {
        // best-effort on filesystems without POSIX permissions
      }
      if (params.policy.mediaStorage.mode !== "inbound") {
        fs.mkdirSync(mediaRoot, { recursive: true, mode: 0o700 });
        if (params.policy.mediaStorage.mode === "managed") {
          try {
            fs.chmodSync(mediaRoot, 0o700);
          } catch {
            // best-effort on filesystems without POSIX permissions
          }
        }
        if (params.policy.mediaStorage.mode === "custom") {
          initializationStep = "checking custom media directory write access";
          const mediaRootStat = fs.lstatSync(mediaRoot);
          if (!mediaRootStat.isDirectory() || mediaRootStat.isSymbolicLink()) {
            throw new Error("custom media directory must be a real directory, not a symlink");
          }
          assertDirectoryWritable(mediaRoot);
        }
      }
      initializationStep = "opening Quote Cache SQLite database";
      const dbPath = path.join(rootDir, "ref-messages.sqlite");
      const openedDb = new sqlite.DatabaseSync(dbPath);
      db = openedDb;
      try {
        fs.chmodSync(dbPath, 0o600);
      } catch {
        // best-effort
      }
      return new QuoteStore(openedDb, mediaRoot, params.policy, dbPath);
    } catch (err) {
      try {
        db?.close();
      } catch (closeErr) {
        logger.warn(
          `quote cache: failed to close SQLite database after initialization error: ${String(closeErr)}`,
        );
      }
      const message = `Quote Cache initialization failed while ${initializationStep}: ${String(err)}`;
      logger.error(message);
      throw new Error(message, { cause: err });
    }
  }

  updatePolicy(policy: QuoteCachePolicy): void {
    if (JSON.stringify(policy.mediaStorage) !== JSON.stringify(this.mediaStorage)) {
      logger.warn("quote cache media storage changes require a Gateway restart");
    }
    this.policy = { ...policy, mediaStorage: this.mediaStorage };
    this.requestGc();
  }

  usesInboundMediaStorage(): boolean {
    return this.mediaStorage.mode === "inbound";
  }

  usesCustomMediaStorage(): boolean {
    return this.mediaStorage.mode === "custom";
  }

  async saveMediaBuffer(
    accountId: string,
    buffer: Buffer,
    _contentType: string | undefined,
    maxBytes: number | undefined,
    originalFilename: string | undefined,
    retain?: (filePath: string) => void,
  ): Promise<{ path: string }> {
    if (maxBytes !== undefined && buffer.length > maxBytes) {
      throw new Error(`media exceeds maximum size of ${maxBytes} bytes`);
    }
    const accountDir = path.join(this.mediaRoot, accountMediaDirName(accountId));
    await fs.promises.mkdir(accountDir, { recursive: true, mode: 0o700 });
    if (this.mediaStorage.mode === "managed") {
      try {
        await fs.promises.chmod(accountDir, 0o700);
      } catch {
        // best-effort on filesystems without POSIX permissions
      }
    }
    const safeName = originalFilename
      ? path.basename(originalFilename).replace(/[^a-zA-Z0-9._-]+/g, "_")
      : "media";
    const ext = path.extname(safeName).slice(0, 16) || mediaFileExtension(buffer, _contentType);
    const filePath = path.join(accountDir, `${crypto.randomUUID()}${ext}`);
    retain?.(filePath);
    await fs.promises.writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });
    return { path: filePath };
  }

  /** Protect paths from write start until the caller releases this entire turn. */
  createMediaLease(accountId: string) {
    const paths = new Set<string>();
    let released = false;
    const retain = (filePath: string) => {
      if (released) throw new Error("media lease has been released");
      const absolutePath = path.resolve(filePath);
      if (paths.has(absolutePath)) return;
      paths.add(absolutePath);
      activeMediaPaths.set(absolutePath, (activeMediaPaths.get(absolutePath) ?? 0) + 1);
    };
    return {
      retain,
      saveMediaBuffer: (
        buffer: Buffer,
        type: string | undefined,
        maxBytes: number | undefined,
        name: string | undefined,
      ) =>
        this.saveMediaBuffer(accountId, buffer, type, maxBytes, name, (filePath) => {
          retain(filePath);
          if (this.mediaStorage.mode !== "inbound")
            pendingOwnedMediaPaths.set(filePath, this.databasePath);
        }),
      release: () => {
        if (released) return;
        released = true;
        for (const filePath of paths) {
          const count = activeMediaPaths.get(filePath)!;
          if (count === 1) activeMediaPaths.delete(filePath);
          else activeMediaPaths.set(filePath, count - 1);
        }
        this.cleanupReleasedMedia();
        if (this.gcDeferred) {
          this.gcDeferred = false;
          this.requestGc();
        }
      },
    };
  }

  private isMediaActive(filePath: string): boolean {
    if (!activeMediaPaths.has(filePath)) return false;
    this.gcDeferred = true;
    return true;
  }

  /** Finish postponed owned-file deletion even after account removal or store close. */
  private cleanupReleasedMedia(): void {
    const candidates = [...pendingOwnedMediaPaths].filter(
      ([filePath, databasePath]) =>
        databasePath === this.databasePath && !activeMediaPaths.has(filePath),
    );
    if (!candidates.length) return;
    let reopened: SqliteDatabase | undefined;
    try {
      if (this.closed) {
        const require = createRequire(import.meta.url);
        const { DatabaseSync } = require("node:sqlite") as {
          DatabaseSync: DatabaseSyncConstructor;
        };
        reopened = new DatabaseSync(this.databasePath, { readOnly: true });
      }
      const db = reopened ?? this.db;
      const referenced = db.prepare(
        `SELECT 1 FROM ${mediaReferenceTable(db)} WHERE media_path = ? LIMIT 1`,
      );
      for (const [filePath] of candidates) {
        if (!referenced.get(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        pendingOwnedMediaPaths.delete(filePath);
      }
    } catch (error) {
      logger.warn(`quote cache: deferred media cleanup failed: ${String(error)}`);
    } finally {
      reopened?.close();
    }
  }

  private initializeSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS quote_messages (
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        media_path TEXT,
        media_owned INTEGER NOT NULL DEFAULT 1,
        media_mime TEXT,
        media_name TEXT,
        media_size INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, conversation_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS quote_messages_account_created
        ON quote_messages (account_id, created_at);
      CREATE INDEX IF NOT EXISTS quote_messages_media_path
        ON quote_messages (media_path);
    `);
    const columns = this.db.prepare("PRAGMA table_info(quote_messages)").all() as Array<{
      name?: string;
    }>;
    if (!columns.some((column) => column.name === "media_owned")) {
      this.db.exec("ALTER TABLE quote_messages ADD COLUMN media_owned INTEGER NOT NULL DEFAULT 1");
    }
    if (!columns.some((column) => column.name === "media_items")) {
      this.db.exec("ALTER TABLE quote_messages ADD COLUMN media_items TEXT NOT NULL DEFAULT '[]'");
    }
    this.db.exec(`
      CREATE VIEW IF NOT EXISTS quote_media_refs AS
        SELECT account_id, conversation_id, message_id, media_path, media_owned, media_size, created_at
          FROM quote_messages WHERE media_path IS NOT NULL
        UNION ALL
        SELECT q.account_id, q.conversation_id, q.message_id,
               json_extract(m.value, '$.path'), json_extract(m.value, '$.owned'),
               json_extract(m.value, '$.size'), q.created_at
          FROM quote_messages q, json_each(q.media_items) m
          WHERE json_extract(m.value, '$.path') IS NOT NULL;
    `);
  }

  find(accountId: string, conversationId: string, messageId: string): QuoteMessageRecord | null {
    if (this.closed || !messageId) return null;
    const row = asStoredRow(
      this.db
        .prepare(`
          SELECT account_id, conversation_id, message_id, direction, body,
                 media_path, media_owned, media_mime, media_name, media_size, media_items, created_at
          FROM quote_messages
          WHERE account_id = ? AND conversation_id = ? AND message_id = ?
        `)
        .get(accountId, conversationId, messageId),
    );
    if (!row) return null;
    if (Date.now() - row.created_at > this.policy.retentionMs) {
      this.deleteMessage(accountId, conversationId, messageId);
      return null;
    }
    const extraMedia = (JSON.parse(row.media_items) as StoredMedia[]).map(mediaRecord);
    const firstMedia: QuoteMediaRecord = {
      ...(row.media_path ? { mediaPath: row.media_path } : {}),
      ...(row.media_mime ? { mediaMime: row.media_mime } : {}),
      ...(row.media_name ? { mediaName: row.media_name } : {}),
      ...(typeof row.media_size === "number" ? { mediaSize: row.media_size } : {}),
    };
    return {
      accountId: row.account_id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      direction: row.direction,
      body: row.body,
      ...(row.media_path ? { mediaPath: row.media_path } : {}),
      ...(row.media_mime ? { mediaMime: row.media_mime } : {}),
      ...(row.media_name ? { mediaName: row.media_name } : {}),
      ...(typeof row.media_size === "number" ? { mediaSize: row.media_size } : {}),
      ...(extraMedia.length ? { media: [firstMedia, ...extraMedia] } : {}),
      createdAt: row.created_at,
    };
  }

  async put(input: QuoteMessageInput): Promise<void> {
    if (
      this.closed ||
      !input.messageId ||
      (!input.body && !input.sourceMediaPath && !input.media?.length)
    )
      return;
    const inputs =
      input.media ??
      (input.sourceMediaPath
        ? [
            {
              sourceMediaPath: input.sourceMediaPath,
              mediaMime: input.mediaMime,
              mediaName: input.mediaName,
            },
          ]
        : []);
    const registered: StoredMedia[] = [];
    for (const item of inputs) {
      const result = await this.registerMedia(
        input.accountId,
        item.sourceMediaPath,
        item.mediaMime,
      );
      registered.push({
        ...(result ?? { owned: false }),
        ...(item.mediaMime ? { mime: item.mediaMime } : {}),
        ...(item.mediaName ? { name: item.mediaName } : {}),
      });
    }
    // A channel can stop while file metadata is being read.
    if (this.closed) return;
    const media = registered[0];
    this.db
      .prepare(`
        INSERT INTO quote_messages (
          account_id, conversation_id, message_id, direction, body,
          media_path, media_owned, media_mime, media_name, media_size, created_at, media_items
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, conversation_id, message_id) DO UPDATE SET
          direction = excluded.direction,
          body = excluded.body,
          media_path = COALESCE(excluded.media_path, quote_messages.media_path),
          media_owned = CASE WHEN excluded.media_path IS NOT NULL
            THEN excluded.media_owned ELSE quote_messages.media_owned END,
          media_mime = COALESCE(excluded.media_mime, quote_messages.media_mime),
          media_name = COALESCE(excluded.media_name, quote_messages.media_name),
          media_size = COALESCE(excluded.media_size, quote_messages.media_size),
          created_at = excluded.created_at,
          media_items = CASE WHEN ? THEN excluded.media_items ELSE quote_messages.media_items END
      `)
      .run(
        input.accountId,
        input.conversationId,
        input.messageId,
        input.direction,
        input.body,
        media?.path ?? null,
        media ? Number(media.owned) : 1,
        media?.mime ?? input.mediaMime ?? null,
        media?.name ?? input.mediaName ?? null,
        media?.size ?? null,
        Number.isFinite(input.createdAt) && input.createdAt > 0 ? input.createdAt : Date.now(),
        JSON.stringify(registered.slice(1)),
        inputs.length > 0 ? 1 : 0,
      );

    this.writesSinceGc += 1;
    if (media) {
      this.enforceMediaBudget(input.accountId);
    }
    if (this.writesSinceGc >= GC_WRITE_INTERVAL) {
      this.writesSinceGc = 0;
      this.requestGc();
    }
  }

  deleteAccount(accountId: string): void {
    if (this.closed) return;
    const ownedPaths = this.db
      .prepare(`
        SELECT DISTINCT media_path FROM quote_media_refs
        WHERE account_id = ? AND media_owned = 1 AND media_path IS NOT NULL
      `)
      .all(accountId) as Array<{ media_path: string }>;
    this.db.prepare("DELETE FROM quote_messages WHERE account_id = ?").run(accountId);
    for (const { media_path: mediaPath } of ownedPaths) this.removeMediaIfOrphaned(mediaPath);
    if (this.mediaStorage.mode !== "inbound") {
      removeUnreferencedMediaFiles(
        this.db,
        path.join(this.mediaRoot, accountMediaDirName(accountId)),
        this.mediaRoot,
      );
    }
  }

  private deleteMessage(accountId: string, conversationId: string, messageId: string): void {
    this.db
      .prepare(
        "DELETE FROM quote_messages WHERE account_id = ? AND conversation_id = ? AND message_id = ?",
      )
      .run(accountId, conversationId, messageId);
  }

  private async registerMedia(
    accountId: string,
    sourcePath: string,
    mime?: string,
  ): Promise<{ path: string; owned: boolean; mime?: string; name?: string; size?: number } | null> {
    if (this.mediaStorage.mode === "inbound") {
      let stat: fs.Stats | undefined;
      try {
        stat = await fs.promises.stat(sourcePath);
      } catch {
        // Preserve the reference even when the file is already unavailable.
      }
      return {
        path: path.resolve(sourcePath),
        owned: false,
        ...(mime ? { mime } : {}),
        ...(stat?.isFile() ? { name: path.basename(sourcePath), size: stat.size } : {}),
      };
    }
    const resolvedSourcePath = path.resolve(sourcePath);
    try {
      const accountDir = path.join(this.mediaRoot, accountMediaDirName(accountId));
      const canonicalRoot = await fs.promises
        .realpath(accountDir)
        .catch(() => path.resolve(accountDir));
      const canonicalSource = await fs.promises.realpath(sourcePath);
      const stat = await fs.promises.stat(canonicalSource);
      if (!stat.isFile()) {
        return { path: resolvedSourcePath, owned: false, ...(mime ? { mime } : {}) };
      }
      const relative = path.relative(canonicalRoot, canonicalSource);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        // Keep the reference, but never let cache cleanup own files outside its managed directory.
        return {
          path: resolvedSourcePath,
          owned: false,
          ...(mime ? { mime } : {}),
          name: path.basename(canonicalSource),
          size: stat.size,
        };
      }
      if (stat.size > this.policy.maxSingleMediaBytes) return null;
      return {
        path: path.resolve(sourcePath),
        owned: true,
        ...(mime ? { mime } : {}),
        name: path.basename(canonicalSource),
        size: stat.size,
      };
    } catch {
      // The quote record can still retain a path whose file is currently unavailable.
      return { path: resolvedSourcePath, owned: false, ...(mime ? { mime } : {}) };
    }
  }

  private requestGc(): void {
    if (this.closed) return;
    if (this.gcRunning) {
      this.gcRequested = true;
      return;
    }
    if (this.gcScheduled) return;
    this.gcScheduled = true;
    queueMicrotask(() => {
      this.gcScheduled = false;
      this.runGc();
    });
  }

  runGc(now = Date.now()): void {
    if (this.closed || this.gcRunning) {
      this.gcRequested = true;
      return;
    }
    this.gcRunning = true;
    try {
      const sweepAccounts = new Set([
        ...activeAccounts,
        ...(
          this.db.prepare("SELECT DISTINCT account_id FROM quote_messages").all() as Array<{
            account_id: string;
          }>
        ).map(({ account_id }) => account_id),
      ]);
      const messageCutoff = now - this.policy.retentionMs;
      this.db.prepare("DELETE FROM quote_messages WHERE created_at < ?").run(messageCutoff);

      const accounts = this.db
        .prepare("SELECT DISTINCT account_id FROM quote_messages")
        .all() as Array<{ account_id: string }>;
      for (const { account_id: accountId } of accounts) {
        this.db
          .prepare(`
            DELETE FROM quote_messages
            WHERE rowid IN (
              SELECT rowid FROM quote_messages
              WHERE account_id = ?
              ORDER BY created_at DESC, rowid DESC
              LIMIT -1 OFFSET ?
            )
          `)
          .run(accountId, this.policy.maxMessagesPerAccount);
        this.expireOldMedia(accountId, now - this.policy.mediaRetentionMs);
        this.enforceMediaBudget(accountId);
      }
      this.pruneOrphanMediaFiles(sweepAccounts);
      this.cleanupReleasedMedia();
    } catch (err) {
      logger.warn(`quote cache GC failed: ${String(err)}`);
    } finally {
      this.gcRunning = false;
      if (this.gcRequested) {
        this.gcRequested = false;
        this.requestGc();
      }
    }
  }

  private listMedia(accountId: string): MediaRow[] {
    return this.db
      .prepare(`
        SELECT media_path, MAX(COALESCE(media_size, 0)) AS media_size,
               MAX(created_at) AS newest_at
        FROM quote_media_refs
        WHERE account_id = ? AND media_path IS NOT NULL AND media_owned = 1
        GROUP BY media_path
        ORDER BY newest_at ASC
      `)
      .all(accountId) as MediaRow[];
  }

  private expireOldMedia(accountId: string, cutoff: number): void {
    for (const media of this.listMedia(accountId)) {
      if (media.newest_at >= cutoff || this.isMediaActive(media.media_path)) continue;
      this.detachMedia(media.media_path);
    }
  }

  private enforceMediaBudget(accountId: string): void {
    const rows = this.listMedia(accountId);
    let total = rows.reduce((sum, row) => sum + Math.max(0, row.media_size), 0);
    for (const row of rows) {
      if (total <= this.policy.maxMediaBytesPerAccount) break;
      if (this.isMediaActive(row.media_path)) continue;
      this.detachMedia(row.media_path);
      total -= Math.max(0, row.media_size);
    }
  }

  private detachMedia(mediaPath: string): void {
    if (this.isMediaActive(mediaPath)) return;
    this.db
      .prepare(
        "UPDATE quote_messages SET media_path = NULL WHERE media_path = ? AND media_owned = 1",
      )
      .run(mediaPath);
    const rows = this.db
      .prepare("SELECT rowid, media_items FROM quote_messages WHERE media_items != '[]'")
      .all() as Array<{ rowid: number; media_items: string }>;
    for (const row of rows) {
      const items = JSON.parse(row.media_items) as StoredMedia[];
      let changed = false;
      for (const item of items) {
        if (item.path === mediaPath && item.owned) {
          delete item.path;
          changed = true;
        }
      }
      if (changed)
        this.db
          .prepare("UPDATE quote_messages SET media_items = ? WHERE rowid = ?")
          .run(JSON.stringify(items), row.rowid);
    }
    this.removeMediaIfOrphaned(mediaPath);
  }

  private removeMediaIfOrphaned(mediaPath: string): void {
    if (this.isMediaActive(mediaPath)) {
      pendingOwnedMediaPaths.set(mediaPath, this.databasePath);
      return;
    }
    const row = this.db
      .prepare("SELECT 1 AS found FROM quote_media_refs WHERE media_path = ? LIMIT 1")
      .get(mediaPath) as { found?: number } | undefined;
    if (row?.found) return;
    try {
      fs.unlinkSync(mediaPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(`quote cache: failed to remove media path=${mediaPath}: ${String(err)}`);
      }
    }
  }

  private pruneOrphanMediaFiles(accounts: Set<string>): void {
    if (this.mediaStorage.mode === "inbound") return;
    try {
      const mediaRootStat = fs.lstatSync(this.mediaRoot);
      if (!mediaRootStat.isDirectory() || mediaRootStat.isSymbolicLink()) return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    const known = new Set(
      (
        this.db
          .prepare("SELECT DISTINCT media_path FROM quote_media_refs WHERE media_path IS NOT NULL")
          .all() as Array<{ media_path: string }>
      ).map((row) => row.media_path),
    );
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(fullPath);
        else if (entry.isFile() && !known.has(fullPath)) {
          if (this.isMediaActive(fullPath)) {
            pendingOwnedMediaPaths.set(fullPath, this.databasePath);
            continue;
          }
          try {
            fs.unlinkSync(fullPath);
          } catch {
            // retry during the next GC pass
          }
        }
      }
    };
    for (const accountId of accounts) {
      const accountDir = path.join(this.mediaRoot, accountMediaDirName(accountId));
      try {
        const accountStat = fs.lstatSync(accountDir);
        if (accountStat.isDirectory() && !accountStat.isSymbolicLink()) visit(accountDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.gcTimer);
    this.db.close();
  }
}

let activeStore: QuoteStore | null = null;
let initialization: Promise<QuoteStore | null> | null = null;
const activeAccounts = new Set<string>();

export async function initializeQuoteStore(
  cfg: OpenClawConfig,
  accountId?: string,
): Promise<QuoteStore | null> {
  if (accountId) activeAccounts.add(accountId);
  const policy = resolveQuoteCachePolicy(cfg);
  if (!policy.enabled) {
    activeStore?.close();
    activeStore = null;
    initialization = null;
    return null;
  }
  if (activeStore) {
    activeStore.updatePolicy(policy);
    return activeStore;
  }
  if (!initialization) {
    let pending: Promise<QuoteStore | null>;
    pending = QuoteStore.open({ policy })
      .then((store) => {
        if (initialization !== pending) {
          store?.close();
          return null;
        }
        activeStore = store;
        return store;
      })
      .catch((err) => {
        if (initialization === pending) initialization = null;
        throw err;
      });
    initialization = pending;
  }
  return initialization;
}

export function getQuoteStore(): QuoteStore | null {
  return activeStore;
}

export function getActiveQuoteMediaSubdir(accountId: string): string | undefined {
  if (
    !activeStore ||
    activeStore.usesInboundMediaStorage() ||
    activeStore.usesCustomMediaStorage()
  ) {
    return undefined;
  }
  return resolveQuoteMediaSubdir(accountId);
}

export function closeQuoteStore(): void {
  activeStore?.close();
  activeStore = null;
  initialization = null;
  activeAccounts.clear();
}

export function deleteQuoteCacheForAccount(accountId: string): void {
  if (activeStore) {
    activeStore.deleteAccount(accountId);
    return;
  }

  const rootDir = path.join(resolveStateDir(), "openclaw-weixin");
  const mediaRoot = resolveQuoteMediaRoot({ mode: "managed" });
  const dbPath = path.join(rootDir, "ref-messages.sqlite");
  if (!fs.existsSync(dbPath)) return;
  try {
    const require = createRequire(import.meta.url);
    const sqlite = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };
    const db = new sqlite.DatabaseSync(dbPath);
    const columns = db.prepare("PRAGMA table_info(quote_messages)").all() as Array<{
      name?: string;
    }>;
    if (!columns.some((column) => column.name === "media_owned")) {
      db.exec("ALTER TABLE quote_messages ADD COLUMN media_owned INTEGER NOT NULL DEFAULT 1");
    }
    const mediaTable = mediaReferenceTable(db);
    const ownedPaths = db
      .prepare(`
        SELECT DISTINCT media_path FROM ${mediaTable}
        WHERE account_id = ? AND media_owned = 1 AND media_path IS NOT NULL
      `)
      .all(accountId) as Array<{ media_path: string }>;
    db.prepare("DELETE FROM quote_messages WHERE account_id = ?").run(accountId);
    for (const { media_path: mediaPath } of ownedPaths) {
      const remaining = db
        .prepare(`SELECT 1 AS found FROM ${mediaTable} WHERE media_path = ? LIMIT 1`)
        .get(mediaPath) as { found?: number } | undefined;
      if (!remaining?.found && activeMediaPaths.has(mediaPath)) {
        pendingOwnedMediaPaths.set(mediaPath, dbPath);
      } else if (!remaining?.found) {
        try {
          fs.unlinkSync(mediaPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.warn(`quote cache: failed to remove media path=${mediaPath}: ${String(err)}`);
          }
        }
      }
    }
    removeUnreferencedMediaFiles(
      db,
      path.join(mediaRoot, accountMediaDirName(accountId)),
      mediaRoot,
    );
    const legacyMediaRoot = path.join(rootDir, "ref-media");
    removeUnreferencedMediaFiles(
      db,
      path.join(legacyMediaRoot, accountMediaDirName(accountId)),
      legacyMediaRoot,
    );
    const customMediaRoot = resolveConfiguredCustomMediaRoot();
    if (customMediaRoot) {
      removeUnreferencedMediaFiles(
        db,
        path.join(customMediaRoot, accountMediaDirName(accountId)),
        customMediaRoot,
      );
    }
    db.close();
  } catch (err) {
    logger.warn(`quote cache: failed to delete account=${accountId}: ${String(err)}`);
  }
}

export function deactivateQuoteStoreAccount(accountId: string): void {
  activeAccounts.delete(accountId);
  if (activeAccounts.size === 0) closeQuoteStore();
}
