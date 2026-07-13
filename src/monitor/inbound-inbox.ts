import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { MessageItemType, type WeixinMessage } from "../api/types.js";
import { resolveStateDir } from "../storage/state-dir.js";
import type { Logger } from "../util/logger.js";

const DEFAULT_ORDINARY_CONCURRENCY = 4;
const APPROVAL_CONCURRENCY = 1;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_MAX_DONE_RECORDS = 32;
const DEFAULT_MAX_DONE_AGE_MS = 24 * 60 * 60 * 1000;
const ACTIVE_RECORDS_SYMBOL = Symbol.for("openclaw-weixin.inbound-inbox.active-records");

type InboxKind = "ordinary" | "approval";
type PendingEntry = {
  id: string;
  pendingPath: string;
  donePath: string;
};

export type InboundInboxRecord = {
  id: string;
  enqueuedAt: string;
  message: WeixinMessage;
};

export type CreateInboundInboxOpts = {
  accountId: string;
  aLog: Logger;
  processMessage: (message: WeixinMessage) => Promise<void>;
  ordinaryConcurrency?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxDoneRecords?: number;
  maxDoneAgeMs?: number;
};

export type InboundInbox = {
  enqueueBatch(messages: WeixinMessage[]): Promise<void>;
  scheduleProcessing(): void;
  stop(): void;
};

type GlobalWithActiveRecords = typeof globalThis & {
  [ACTIVE_RECORDS_SYMBOL]?: Set<string>;
};

export function resolveInboundInboxDir(accountId: string): string {
  return path.join(resolveStateDir(), "openclaw-weixin", "inbox", accountId);
}

export function getInboundInboxRecordId(message: WeixinMessage): string {
  if (message.message_id != null) return `msg-${message.message_id}`;
  if (message.seq != null) return `seq-${message.seq}`;
  return `sha-${createHash("sha256").update(stableStringify(message)).digest("hex").slice(0, 24)}`;
}

export function isApprovalMessage(message: WeixinMessage): boolean {
  const textBody = extractTextBody(message.item_list).trim();
  return /^\/approve(?:\s|$)/i.test(textBody) && /\bplugin:/i.test(textBody);
}

export function createInboundInbox(opts: CreateInboundInboxOpts): InboundInbox {
  return new LocalInboundInbox(opts);
}

function getActiveRecords(): Set<string> {
  const globalState = globalThis as GlobalWithActiveRecords;
  globalState[ACTIVE_RECORDS_SYMBOL] ??= new Set<string>();
  return globalState[ACTIVE_RECORDS_SYMBOL];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function extractTextBody(itemList?: import("../api/types.js").MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

class LocalInboundInbox implements InboundInbox {
  private readonly inboxDir: string;
  private readonly ordinaryConcurrency: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxDoneRecords: number;
  private readonly maxDoneAgeMs: number;
  private ordinaryActive = 0;
  private approvalActive = 0;
  private pumpQueued = false;
  private stopped = false;
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryBlockedUntil = new Map<string, number>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly opts: CreateInboundInboxOpts) {
    this.inboxDir = resolveInboundInboxDir(opts.accountId);
    this.ordinaryConcurrency = opts.ordinaryConcurrency ?? DEFAULT_ORDINARY_CONCURRENCY;
    this.retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = opts.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.maxDoneRecords = opts.maxDoneRecords ?? DEFAULT_MAX_DONE_RECORDS;
    this.maxDoneAgeMs = opts.maxDoneAgeMs ?? DEFAULT_MAX_DONE_AGE_MS;
    try {
      fs.mkdirSync(this.inboxDir, { recursive: true });
    } catch (err) {
      throw new Error(`Failed to initialize inbound inbox ${this.inboxDir}: ${formatError(err)}`);
    }
  }

  async enqueueBatch(messages: WeixinMessage[]): Promise<void> {
    for (const message of messages) {
      this.persistRecord(message);
    }
  }

  scheduleProcessing(): void {
    if (this.stopped || this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      if (this.stopped) return;
      void this.pump().catch((err) => {
        this.opts.aLog.error(`Inbound inbox pump failed: ${formatError(err)}`);
      });
    });
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.retryBlockedUntil.clear();
  }

  private persistRecord(message: WeixinMessage): void {
    const entry = this.getEntry(getInboundInboxRecordId(message));
    if (this.recordExists(entry)) return;
    const tempPath = path.join(
      this.inboxDir,
      `${entry.id}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    const record: InboundInboxRecord = {
      id: entry.id,
      enqueuedAt: new Date().toISOString(),
      message,
    };
    try {
      fs.writeFileSync(tempPath, JSON.stringify(record), "utf-8");
      fs.renameSync(tempPath, entry.pendingPath);
    } catch (err) {
      this.cleanupTempFile(tempPath);
      if (this.recordExists(entry)) return;
      this.opts.aLog.error(`Failed to persist inbound inbox record ${entry.id}: ${formatError(err)}`);
      throw err;
    }
  }

  private async pump(): Promise<void> {
    this.pruneDoneTombstones();
    for (const entry of this.listPendingEntries()) {
      if (this.stopped) return;
      if (this.ordinaryActive >= this.ordinaryConcurrency && this.approvalActive >= APPROVAL_CONCURRENCY) {
        return;
      }
      const blockedUntil = this.retryBlockedUntil.get(entry.pendingPath);
      if (blockedUntil != null && blockedUntil > Date.now()) continue;
      if (getActiveRecords().has(entry.pendingPath)) continue;
      let record: InboundInboxRecord;
      try {
        record = this.readRecord(entry);
      } catch (err) {
        this.opts.aLog.error(`Failed to read inbound inbox record ${entry.id}: ${formatError(err)}`);
        this.scheduleRetry(entry.pendingPath);
        continue;
      }
      const kind: InboxKind = isApprovalMessage(record.message) ? "approval" : "ordinary";
      if (kind === "approval") {
        if (this.approvalActive >= APPROVAL_CONCURRENCY) continue;
      } else if (this.ordinaryActive >= this.ordinaryConcurrency) {
        continue;
      }
      this.startProcessing(entry, record, kind);
    }
  }

  private startProcessing(entry: PendingEntry, record: InboundInboxRecord, kind: InboxKind): void {
    getActiveRecords().add(entry.pendingPath);
    if (kind === "approval") {
      this.approvalActive += 1;
    } else {
      this.ordinaryActive += 1;
    }
    void this.runRecord(entry, record, kind);
  }

  private async runRecord(
    entry: PendingEntry,
    record: InboundInboxRecord,
    kind: InboxKind,
  ): Promise<void> {
    try {
      try {
        await this.opts.processMessage(record.message);
      } catch (err) {
        this.opts.aLog.error(`Failed to process inbound record ${record.id}: ${formatError(err)}`);
        this.scheduleRetry(entry.pendingPath);
        return;
      }
      await this.finalizeRecord(entry);
    } finally {
      getActiveRecords().delete(entry.pendingPath);
      if (kind === "approval") {
        this.approvalActive -= 1;
      } else {
        this.ordinaryActive -= 1;
      }
      if (!this.stopped) {
        this.scheduleProcessing();
      }
    }
  }

  private async finalizeRecord(entry: PendingEntry): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        this.markDone(entry);
        return;
      } catch (err) {
        attempt += 1;
        const delayMs = Math.min(this.retryBaseMs * 2 ** (attempt - 1), this.retryMaxMs);
        this.opts.aLog.error(
          `Failed to finalize inbound record ${entry.id}; retrying in ${delayMs}ms: ${formatError(err)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private markDone(entry: PendingEntry): void {
    try {
      fs.renameSync(entry.pendingPath, entry.donePath);
    } catch (err) {
      if (!fs.existsSync(entry.pendingPath) && fs.existsSync(entry.donePath)) return;
      throw new Error(`Failed to finalize inbound record ${entry.id}: ${formatError(err)}`);
    }
    this.clearRetry(entry.pendingPath);
    this.pruneDoneTombstones();
  }

  private scheduleRetry(pendingPath: string): void {
    if (this.stopped) return;
    const attempt = (this.retryAttempts.get(pendingPath) ?? 0) + 1;
    this.retryAttempts.set(pendingPath, attempt);
    const delayMs = Math.min(this.retryBaseMs * 2 ** (attempt - 1), this.retryMaxMs);
    this.retryBlockedUntil.set(pendingPath, Date.now() + delayMs);
    const existingTimer = this.retryTimers.get(pendingPath);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.retryTimers.delete(pendingPath);
      this.retryBlockedUntil.delete(pendingPath);
      this.scheduleProcessing();
    }, delayMs);
    this.retryTimers.set(pendingPath, timer);
  }

  private clearRetry(pendingPath: string): void {
    this.retryAttempts.delete(pendingPath);
    this.retryBlockedUntil.delete(pendingPath);
    const timer = this.retryTimers.get(pendingPath);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(pendingPath);
    }
  }

  private readRecord(entry: PendingEntry): InboundInboxRecord {
    const parsed = JSON.parse(fs.readFileSync(entry.pendingPath, "utf-8")) as Partial<InboundInboxRecord>;
    if (parsed.id !== entry.id || typeof parsed.enqueuedAt !== "string" || parsed.message == null) {
      throw new Error(`Invalid inbox record payload at ${entry.pendingPath}`);
    }
    return {
      id: parsed.id,
      enqueuedAt: parsed.enqueuedAt,
      message: parsed.message as WeixinMessage,
    };
  }

  private recordExists(entry: PendingEntry): boolean {
    return fs.existsSync(entry.pendingPath) || fs.existsSync(entry.donePath);
  }

  private getEntry(id: string): PendingEntry {
    return {
      id,
      pendingPath: path.join(this.inboxDir, `${id}.pending.json`),
      donePath: path.join(this.inboxDir, `${id}.done.json`),
    };
  }

  private listPendingEntries(): PendingEntry[] {
    return fs
      .readdirSync(this.inboxDir)
      .filter((name) => name.endsWith(".pending.json"))
      .sort((left, right) => left.localeCompare(right))
      .map((name) => this.getEntry(name.slice(0, -".pending.json".length)));
  }

  private pruneDoneTombstones(): void {
    const now = Date.now();
    const doneFiles = fs
      .readdirSync(this.inboxDir)
      .filter((name) => name.endsWith(".done.json"))
      .map((name) => {
        const filePath = path.join(this.inboxDir, name);
        return { filePath, stat: fs.statSync(filePath) };
      })
      .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    doneFiles.forEach(({ filePath, stat }, index) => {
      if (index < this.maxDoneRecords && now - stat.mtimeMs <= this.maxDoneAgeMs) return;
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        this.opts.aLog.warn(`Failed to prune inbound tombstone ${filePath}: ${formatError(err)}`);
      }
    });
  }

  private cleanupTempFile(tempPath: string): void {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (err) {
      this.opts.aLog.warn(`Failed to clean temp inbox file ${tempPath}: ${formatError(err)}`);
    }
  }
}
