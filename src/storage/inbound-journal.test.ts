import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InboundJournal } from "./inbound-journal.js";

let root: string;
let file: string;
const message = (id: string, sender = "user") => ({ message_id: id, from_user_id: sender });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-journal-"));
  file = path.join(root, "account.sync.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
it("keeps the cursor and pending input unchanged when atomic replacement fails", () => {
  const journal = new InboundJournal(file);
  journal.accept([message("first")], "cursor-1");
  const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
    throw new Error("disk failure");
  });
  expect(() => journal.accept([message("second")], "cursor-2")).toThrow("Cannot persist");
  rename.mockRestore();
  expect(journal.cursor).toBe("cursor-1");
  const restored = new InboundJournal(file);
  expect(restored.cursor).toBe("cursor-1");
  expect(restored.pending().map((m) => m.message_id)).toEqual(["first"]);
  expect(fs.readdirSync(root)).toEqual(["account.sync.json"]);
});
it("recovers pending input but records crashed admitted work as interrupted", () => {
  const journal = new InboundJournal(file);
  const added = journal.accept([message("active"), message("pending")], "cursor");
  journal.start([added[0]]);
  const restored = new InboundJournal(file);
  expect(restored.pending().map((m) => m.message_id)).toEqual(["pending"]);
  expect(restored.interruptedCount).toBe(1);
  expect(restored.accept([message("active")], "new-cursor")).toEqual([]);
});
it("scopes duplicate IDs to the sender and account and retains merged source identities", () => {
  const journal = new InboundJournal(file);
  const added = journal.accept([message("1"), message("1", "other"), message("2")], "cursor");
  journal.start([added[0], added[2]]);
  journal.finish([added[0], added[2]]);
  const restored = new InboundJournal(file);
  expect(restored.pending().map((m) => m.from_user_id)).toEqual(["other"]);
  expect(restored.accept([message("1"), message("2")], "cursor-2")).toEqual([]);
  expect(
    new InboundJournal(path.join(root, "other.sync.json")).accept([message("1")]),
  ).toHaveLength(1);
});
it.each(["broken json", JSON.stringify({ get_updates_buf: "cursor", inbound: { version: 2 } })])(
  "refuses a damaged inbox instead of silently discarding input: %s",
  (data) => {
    fs.writeFileSync(file, data);
    expect(() => new InboundJournal(file)).toThrow("Cannot persist");
    expect(fs.readFileSync(file, "utf8")).toBe(data);
  },
);
it("migrates a cursor-only snapshot and restricts the file containing raw messages", () => {
  fs.writeFileSync(file, JSON.stringify({ get_updates_buf: "legacy" }));
  const journal = new InboundJournal(file);
  expect(journal.cursor).toBe("legacy");
  journal.accept([message("new")], "new");
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(new InboundJournal(file).pending()[0].message_id).toBe("new");
});
it("uses an item ID when the top-level message ID is blank", () => {
  const journal = new InboundJournal(file);
  const msg = {
    message_id: "  ",
    from_user_id: "user",
    item_list: [{ type: 1, msg_id: "item-1" }],
  };
  const accepted = journal.accept([msg], "cursor");
  journal.finish(accepted);
  expect(new InboundJournal(file).accept([msg], "next-cursor")).toEqual([]);
});
it("restores pending state when admission fails after replacing the file", () => {
  const journal = new InboundJournal(file);
  const added = journal.accept([message("not-started")], "cursor");
  const fsync = fs.fsyncSync;
  let count = 0;
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    if (++count === 2) throw new Error("directory sync failed");
    fsync(fd);
  });
  expect(() => journal.start(added)).toThrow("Cannot persist");
  const restored = new InboundJournal(file);
  expect(restored.pending().map((m) => m.message_id)).toEqual(["not-started"]);
  expect(restored.interruptedCount).toBe(0);
});
