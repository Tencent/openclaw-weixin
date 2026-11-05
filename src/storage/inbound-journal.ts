import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { WeixinMessage } from "../api/types.js";
import { loadGetUpdatesBuf } from "./sync-buf.js";

const RECENT_MESSAGE_LIMIT = 10_000;
type RecordState = "pending" | "processing" | "interrupted";
type InboundRecord = { key: string; state: RecordState; message: WeixinMessage };
type Snapshot = {
  get_updates_buf: string;
  inbound: { version: 1; records: InboundRecord[]; recent: string[] };
};

/** Persistence errors must stop dispatch, including failures after admission. */
export class InboundJournalError extends Error {
  constructor(cause: unknown) {
    super("Cannot persist inbound messages; stopping account to preserve recovery state", {
      cause,
    });
  }
}

/** One synchronous writer owns both the poll cursor and the recoverable inbox. */
export class InboundJournal {
  private data: Snapshot;
  private keys = new WeakMap<WeixinMessage, string>();

  constructor(private filePath: string) {
    let saved: any;
    try {
      saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new InboundJournalError(error);
    }
    if (saved !== undefined && (!saved || typeof saved.get_updates_buf !== "string")) {
      throw new InboundJournalError(new Error("Invalid cursor state"));
    }
    if (saved && "inbound" in saved) {
      const inbox = saved.inbound;
      if (
        inbox?.version !== 1 ||
        !Array.isArray(inbox.records) ||
        !Array.isArray(inbox.recent) ||
        !inbox.recent.every((key: unknown) => typeof key === "string") ||
        !inbox.records.every(
          (r: any) =>
            r &&
            typeof r.key === "string" &&
            ["pending", "processing", "interrupted"].includes(r.state) &&
            r.message &&
            typeof r.message === "object" &&
            !Array.isArray(r.message),
        ) ||
        new Set(inbox.records.map((r: any) => r.key)).size !== inbox.records.length
      )
        throw new InboundJournalError(new Error("Invalid inbox state"));
      this.data = saved;
    } else {
      this.data = {
        get_updates_buf: saved?.get_updates_buf ?? loadGetUpdatesBuf(filePath) ?? "",
        inbound: { version: 1, records: [], recent: [] },
      };
    }
    for (const record of this.data.inbound.records) this.keys.set(record.message, record.key);
    if (this.data.inbound.records.some((r) => r.state === "processing")) {
      this.commit({
        ...this.data,
        inbound: {
          ...this.data.inbound,
          records: this.data.inbound.records.map((r) =>
            r.state === "processing" ? { ...r, state: "interrupted" } : r,
          ),
        },
      });
    }
  }

  get cursor(): string {
    return this.data.get_updates_buf;
  }
  get interruptedCount(): number {
    return this.data.inbound.records.filter((r) => r.state === "interrupted").length;
  }
  pending(): WeixinMessage[] {
    return this.data.inbound.records.filter((r) => r.state === "pending").map((r) => r.message);
  }

  /** Save every new raw message before exposing the corresponding cursor. */
  accept(messages: WeixinMessage[], cursor?: string): WeixinMessage[] {
    const known = new Set([
      ...this.data.inbound.recent,
      ...this.data.inbound.records.map((r) => r.key),
    ]);
    const added: InboundRecord[] = [];
    for (const message of messages) {
      const id =
        String(message.message_id ?? "").trim() ||
        message.item_list?.map((i) => String(i.msg_id ?? "").trim()).find(Boolean);
      const key =
        id != null && String(id).trim()
          ? JSON.stringify([message.from_user_id ?? "", String(id).trim()])
          : randomUUID();
      if (known.has(key)) continue;
      known.add(key);
      added.push({ key, state: "pending", message });
    }
    const nextCursor = cursor || this.cursor;
    if (added.length || nextCursor !== this.cursor) {
      this.commit({
        get_updates_buf: nextCursor,
        inbound: { ...this.data.inbound, records: [...this.data.inbound.records, ...added] },
      });
    }
    for (const r of added) this.keys.set(r.message, r.key);
    return added.map((r) => r.message);
  }

  start(messages: readonly WeixinMessage[]): void {
    const previous = this.data;
    try {
      this.transition(messages, "processing");
    } catch (error) {
      // No command/agent has run yet. If rename succeeded but directory sync failed,
      // restore the pending snapshot before stopping the account.
      if (this.data !== previous) {
        try {
          this.commit(previous);
        } catch (rollbackError) {
          throw new InboundJournalError(
            new AggregateError([error, rollbackError], "Admission rollback failed"),
          );
        }
      }
      throw error;
    }
  }
  interrupt(messages: readonly WeixinMessage[]): void {
    this.transition(messages, "interrupted");
  }
  finish(messages: readonly WeixinMessage[]): void {
    const keys = this.messageKeys(messages);
    this.commit({
      ...this.data,
      inbound: {
        ...this.data.inbound,
        records: this.data.inbound.records.filter((r) => !keys.has(r.key)),
        recent: [...this.data.inbound.recent, ...keys].slice(-RECENT_MESSAGE_LIMIT),
      },
    });
  }
  private messageKeys(messages: readonly WeixinMessage[]): Set<string> {
    return new Set(
      messages.map((m) => {
        const key = this.keys.get(m);
        if (!key) throw new InboundJournalError(new Error("Unknown inbound message"));
        return key;
      }),
    );
  }
  private transition(messages: readonly WeixinMessage[], state: RecordState): void {
    const keys = this.messageKeys(messages);
    this.commit({
      ...this.data,
      inbound: {
        ...this.data.inbound,
        records: this.data.inbound.records.map((r) => (keys.has(r.key) ? { ...r, state } : r)),
      },
    });
  }
  private commit(next: Snapshot): void {
    const dir = path.dirname(this.filePath);
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fd = fs.openSync(temp, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(next), "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, this.filePath);
      this.data = next;
      // Persist the directory entry as well as the file contents.
      fd = fs.openSync(dir, "r");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
    } catch (error) {
      throw new InboundJournalError(error);
    } finally {
      try {
        if (fd !== undefined) fs.closeSync(fd);
      } catch {
        /* Preserve the persistence error. */
      }
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        /* A stale temporary file is never loaded. */
      }
    }
  }
}
