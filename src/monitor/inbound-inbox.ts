import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { MessageItemType, type WeixinMessage } from "../api/types.js";
import type { DurableInboundLifecycle } from "../messaging/process-message.js";
import { resolveStateDir } from "../storage/state-dir.js";
import type { Logger } from "../util/logger.js";

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const DONE_RETENTION_MS = 24 * 60 * 60 * 1000;
const DONE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const SHARED_STATE_SYMBOL = Symbol.for("openclaw-weixin.inbound-inbox.shared-state");

type InboxKind = "ordinary" | "approval";
type PendingEntry = {
  id: string;
  pendingPath: string;
  donePath: string;
  record?: InboundInboxRecord;
};

type InboundInboxRecord = {
  id: string;
  order?: number;
  message: WeixinMessage;
};

type CreateInboundInboxOpts = {
  accountId: string;
  aLog: Logger;
  durableQueueAdmissionSupported: boolean;
  processMessage: (
    message: WeixinMessage,
    durableInboundLifecycle?: DurableInboundLifecycle,
    messageSid?: string,
  ) => Promise<void>;
};

type InboundInbox = {
  enqueueBatch(messages: WeixinMessage[]): Promise<void>;
  scheduleProcessing(): void;
  stop(): void;
};

type RecordState = {
  kind?: InboxKind;
  active: boolean;
  processed: boolean;
  queued: boolean;
  retryAttempts: number;
  blockedUntil: number;
};

type SharedInboxState = {
  records: Map<string, RecordState>;
  managers: Set<InboundInbox>;
  nextRecordOrder?: number;
  lastPrunedAt?: number;
  wakeTimer?: ReturnType<typeof setTimeout>;
};

type GlobalWithInboxState = typeof globalThis & {
  [SHARED_STATE_SYMBOL]?: Map<string, SharedInboxState>;
};

export function resolveInboundInboxDir(accountId: string): string {
  return path.join(resolveStateDir(), "openclaw-weixin", "inbox", accountId);
}

function getInboundInboxRecordId(message: WeixinMessage): string {
  if (message.message_id != null) return `msg-${message.message_id}`;
  if (message.seq != null) return `seq-${message.seq}`;
  return `sha-${createHash("sha256").update(stableStringify(message)).digest("hex").slice(0, 24)}`;
}

function isApprovalMessage(message: WeixinMessage): boolean {
  const textBody = extractTextBody(message.item_list).trim();
  return /^\/approve\s+plugin:/i.test(textBody);
}

export function createInboundInbox(opts: CreateInboundInboxOpts): InboundInbox {
  return new LocalInboundInbox(opts);
}

function getSharedInboxState(inboxDir: string): SharedInboxState {
  const globalState = globalThis as GlobalWithInboxState;
  globalState[SHARED_STATE_SYMBOL] ??= new Map<string, SharedInboxState>();
  let state = globalState[SHARED_STATE_SYMBOL].get(inboxDir);
  if (!state) {
    state = { records: new Map(), managers: new Set() };
    globalState[SHARED_STATE_SYMBOL].set(inboxDir, state);
  }
  return state;
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
  private readonly sharedState: SharedInboxState;
  private pumpQueued = false;
  private stopped = false;

  constructor(private readonly opts: CreateInboundInboxOpts) {
    this.inboxDir = resolveInboundInboxDir(opts.accountId);
    try {
      fs.mkdirSync(this.inboxDir, { recursive: true });
    } catch (err) {
      throw new Error(`Failed to initialize inbound inbox ${this.inboxDir}: ${formatError(err)}`);
    }
    this.sharedState = getSharedInboxState(this.inboxDir);
    this.sharedState.managers.add(this);
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
      try {
        this.pump();
      } catch (err) {
        this.opts.aLog.error(`Inbound inbox pump failed: ${formatError(err)}`);
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.sharedState.managers.delete(this);
    if (this.sharedState.managers.size === 0 && this.sharedState.wakeTimer) {
      clearTimeout(this.sharedState.wakeTimer);
      this.sharedState.wakeTimer = undefined;
    }
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
      order: this.reserveRecordOrder(),
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

  private pump(): void {
    this.pruneDoneTombstones();
    let ordinaryRetryBlocked = false;
    for (const entry of this.listPendingEntries()) {
      if (this.stopped) return;
      if (
        this.getActiveCount("ordinary") >= 1 &&
        this.getActiveCount("approval") >= 1
      ) {
        return;
      }
      const state = this.sharedState.records.get(entry.pendingPath);
      if (state?.active || state?.queued) continue;
      if ((state?.blockedUntil ?? 0) > Date.now()) {
        if (!state?.processed && state?.kind !== "approval") {
          ordinaryRetryBlocked = true;
        }
        continue;
      }

      let record = entry.record;
      if (!state?.processed) {
        if (!record) {
          try {
            record = this.readRecord(entry);
          } catch (err) {
            this.opts.aLog.error(`Failed to read inbound inbox record ${entry.id}: ${formatError(err)}`);
            if (state?.kind !== "approval") {
              ordinaryRetryBlocked = true;
            }
            this.scheduleRetry(state ?? this.createRecordState(entry.pendingPath));
            continue;
          }
        }
      }
      let kind = state?.kind;
      if (!kind) {
        if (!record) {
          throw new Error(`Missing payload for unclassified inbound record ${entry.id}`);
        }
        kind = isApprovalMessage(record.message) ? "approval" : "ordinary";
      }
      if (kind === "ordinary" && ordinaryRetryBlocked) continue;
      if (this.getActiveCount(kind) >= 1) continue;

      const nextState = state ?? this.createRecordState(entry.pendingPath);
      nextState.kind = kind;
      this.startProcessing(entry, record, nextState);
    }
    this.scheduleWake();
  }

  private startProcessing(
    entry: PendingEntry,
    record: InboundInboxRecord | undefined,
    state: RecordState,
  ): void {
    state.active = true;
    void this.runRecord(entry, record, state);
  }

  private async runRecord(
    entry: PendingEntry,
    record: InboundInboxRecord | undefined,
    state: RecordState,
  ): Promise<void> {
    try {
      if (!state.processed) {
        if (!record) {
          throw new Error(`Missing payload for unprocessed inbound record ${entry.id}`);
        }
        try {
          const durableInboundLifecycle = this.opts.durableQueueAdmissionSupported
            ? this.createDurableInboundLifecycle(entry, state)
            : undefined;
          await this.opts.processMessage(
            record.message,
            durableInboundLifecycle,
            this.getMessageSid(entry.id),
          );
          if (state.queued || state.processed) return;
          state.processed = true;
        } catch (err) {
          this.opts.aLog.error(`Failed to process inbound record ${entry.id}: ${formatError(err)}`);
          if (!state.queued && !state.processed) {
            this.scheduleRetry(state);
          }
          return;
        }
      }
      this.finalizeRecord(entry, state);
    } finally {
      state.active = false;
      this.wakeManagers();
    }
  }

  private getActiveCount(kind: InboxKind): number {
    let count = 0;
    for (const state of this.sharedState.records.values()) {
      if (state.active && state.kind === kind) {
        count += 1;
      }
    }
    return count;
  }

  private createRecordState(pendingPath: string): RecordState {
    const state: RecordState = {
      active: false,
      processed: false,
      queued: false,
      retryAttempts: 0,
      blockedUntil: 0,
    };
    this.sharedState.records.set(pendingPath, state);
    return state;
  }

  private createDurableInboundLifecycle(
    entry: PendingEntry,
    state: RecordState,
  ): DurableInboundLifecycle {
    const complete = () => {
      state.queued = false;
      state.processed = true;
      state.active = false;
      this.finalizeRecord(entry, state);
      this.wakeManagers();
    };
    return {
      onEnqueued: () => {
        state.queued = true;
        state.active = false;
        this.wakeManagers();
      },
      onComplete: complete,
      onTurnAdopted: complete,
    };
  }

  private finalizeRecord(entry: PendingEntry, state: RecordState): void {
    try {
      this.markDone(entry);
      this.sharedState.records.delete(entry.pendingPath);
      this.scheduleWake();
    } catch (err) {
      this.opts.aLog.error(`Failed to finalize inbound record ${entry.id}: ${formatError(err)}`);
      this.scheduleRetry(state);
    }
  }

  private markDone(entry: PendingEntry): void {
    try {
      const completedAt = new Date();
      fs.utimesSync(entry.pendingPath, completedAt, completedAt);
      fs.renameSync(entry.pendingPath, entry.donePath);
    } catch (err) {
      if (!fs.existsSync(entry.pendingPath) && fs.existsSync(entry.donePath)) {
        return;
      }
      throw new Error(`Failed to finalize inbound record ${entry.id}: ${formatError(err)}`);
    }
  }

  private scheduleRetry(state: RecordState): void {
    state.retryAttempts += 1;
    const delayMs = Math.min(
      RETRY_BASE_MS * 2 ** (state.retryAttempts - 1),
      RETRY_MAX_MS,
    );
    state.blockedUntil = Date.now() + delayMs;
    this.scheduleWake();
  }

  private scheduleWake(): void {
    if (this.sharedState.wakeTimer) {
      clearTimeout(this.sharedState.wakeTimer);
      this.sharedState.wakeTimer = undefined;
    }
    if (this.sharedState.managers.size === 0) return;

    const now = Date.now();
    let nextWake = Number.POSITIVE_INFINITY;
    for (const state of this.sharedState.records.values()) {
      if (state.blockedUntil > now && state.blockedUntil < nextWake) {
        nextWake = state.blockedUntil;
      }
    }
    if (!Number.isFinite(nextWake)) return;

    this.sharedState.wakeTimer = setTimeout(() => {
      this.sharedState.wakeTimer = undefined;
      this.wakeManagers();
    }, nextWake - now);
  }

  private wakeManagers(): void {
    for (const manager of this.sharedState.managers) {
      manager.scheduleProcessing();
    }
  }

  private readRecord(entry: PendingEntry): InboundInboxRecord {
    const parsed = JSON.parse(fs.readFileSync(entry.pendingPath, "utf-8")) as Partial<InboundInboxRecord>;
    if (
      parsed.id !== entry.id ||
      parsed.message == null ||
      (parsed.order != null && !Number.isSafeInteger(parsed.order))
    ) {
      throw new Error(`Invalid inbox record payload at ${entry.pendingPath}`);
    }
    return {
      id: parsed.id,
      ...(parsed.order != null ? { order: parsed.order } : {}),
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

  private getMessageSid(recordId: string): string {
    const digest = createHash("sha256")
      .update(`${this.opts.accountId}\0${recordId}`)
      .digest("hex")
      .slice(0, 24);
    return `openclaw-weixin:inbox-${digest}`;
  }

  private reserveRecordOrder(): number {
    if (this.sharedState.nextRecordOrder == null) {
      let highestOrder = Date.now() * 1000;
      for (const name of fs.readdirSync(this.inboxDir)) {
        if (!name.endsWith(".pending.json")) continue;
        const entry = this.getEntry(name.slice(0, -".pending.json".length));
        try {
          const order = this.readRecord(entry).order;
          if (order != null && Number.isSafeInteger(order)) {
            highestOrder = Math.max(highestOrder, order);
          }
        } catch (err) {
          this.opts.aLog.warn(
            `Failed to inspect inbound record order ${entry.id}: ${formatError(err)}`,
          );
        }
      }
      this.sharedState.nextRecordOrder = highestOrder;
    }
    this.sharedState.nextRecordOrder += 1;
    return this.sharedState.nextRecordOrder;
  }

  private listPendingEntries(): PendingEntry[] {
    const entries = fs
      .readdirSync(this.inboxDir)
      .filter((name) => name.endsWith(".pending.json"))
      .map((name) => this.getEntry(name.slice(0, -".pending.json".length)))
      .map((entry) => {
        try {
          return { ...entry, record: this.readRecord(entry) };
        } catch {
          return entry;
        }
      });
    return entries.sort((left, right) => {
      const leftOrder = left.record?.order;
      const rightOrder = right.record?.order;
      if (leftOrder != null || rightOrder != null) {
        if (leftOrder == null) return -1;
        if (rightOrder == null) return 1;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      }
      return left.id.localeCompare(right.id, "en", { numeric: true });
    });
  }

  private pruneDoneTombstones(): void {
    const now = Date.now();
    if (now - (this.sharedState.lastPrunedAt ?? 0) < DONE_PRUNE_INTERVAL_MS) return;
    for (const name of fs.readdirSync(this.inboxDir)) {
      if (!name.endsWith(".done.json")) continue;
      const filePath = path.join(this.inboxDir, name);
      try {
        if (now - fs.statSync(filePath).mtimeMs <= DONE_RETENTION_MS) continue;
        fs.unlinkSync(filePath);
      } catch (err) {
        this.opts.aLog.warn(`Failed to prune inbound tombstone ${filePath}: ${formatError(err)}`);
      }
    }
    this.sharedState.lastPrunedAt = now;
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
