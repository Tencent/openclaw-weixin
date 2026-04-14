import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-mode-test-"));

vi.mock("../storage/state-dir.js", () => ({
  resolveStateDir: () => mockStateDir,
}));

vi.mock("../util/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { toggleDebugMode, isDebugMode, _resetForTest } from "./debug-mode.js";

describe("debug-mode", () => {
  beforeEach(() => {
    _resetForTest();
  });

  afterEach(() => {
    _resetForTest();
  });

  it("defaults to off", () => {
    expect(isDebugMode("acc1")).toBe(false);
  });

  it("toggles on then off", () => {
    expect(toggleDebugMode("acc1")).toBe(true);
    expect(isDebugMode("acc1")).toBe(true);

    expect(toggleDebugMode("acc1")).toBe(false);
    expect(isDebugMode("acc1")).toBe(false);
  });

  it("is per-account", () => {
    toggleDebugMode("acc1");
    expect(isDebugMode("acc1")).toBe(true);
    expect(isDebugMode("acc2")).toBe(false);
  });

  it("toggles independently across accounts", () => {
    toggleDebugMode("acc1");
    toggleDebugMode("acc2");
    toggleDebugMode("acc1");

    expect(isDebugMode("acc1")).toBe(false);
    expect(isDebugMode("acc2")).toBe(true);
  });

  it("persists state to disk", () => {
    toggleDebugMode("acc1");

    const filePath = path.join(mockStateDir, "openclaw-weixin", "debug-mode.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw.accounts.acc1).toBe(true);
  });

  it("state survives re-read from disk (simulates restart)", () => {
    toggleDebugMode("acc1");
    expect(isDebugMode("acc1")).toBe(true);

    // isDebugMode re-reads from disk each time, so it reflects persisted state
    expect(isDebugMode("acc1")).toBe(true);
  });

  it("clean state after file deletion", () => {
    toggleDebugMode("acc1");
    _resetForTest();
    expect(isDebugMode("acc1")).toBe(false);
  });
});
