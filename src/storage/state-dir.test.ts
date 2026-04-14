import { describe, it, expect, vi, afterEach } from "vitest";
import os from "node:os";
import { resolveStateDir } from "./state-dir.js";

describe("resolveStateDir", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.CLAWDBOT_STATE_DIR;
  });

  it("returns OPENCLAW_STATE_DIR when set", () => {
    process.env.OPENCLAW_STATE_DIR = "/custom/state";
    expect(resolveStateDir()).toBe("/custom/state");
  });

  it("returns CLAWDBOT_STATE_DIR when OPENCLAW_STATE_DIR is unset", () => {
    delete process.env.OPENCLAW_STATE_DIR;
    process.env.CLAWDBOT_STATE_DIR = "/clawdbot/state";
    expect(resolveStateDir()).toBe("/clawdbot/state");
  });

  it("prefers OPENCLAW_STATE_DIR over CLAWDBOT_STATE_DIR", () => {
    process.env.OPENCLAW_STATE_DIR = "/openclaw";
    process.env.CLAWDBOT_STATE_DIR = "/clawdbot";
    expect(resolveStateDir()).toBe("/openclaw");
  });

  it("falls back to ~/.openclaw when neither env var is set", () => {
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.CLAWDBOT_STATE_DIR;
    const expected = `${os.homedir()}/.openclaw`;
    expect(resolveStateDir()).toBe(expected);
  });

  it("trims whitespace from env vars", () => {
    process.env.OPENCLAW_STATE_DIR = "  ";
    process.env.CLAWDBOT_STATE_DIR = " /trimmed ";
    expect(resolveStateDir()).toBe("/trimmed");
  });
});
