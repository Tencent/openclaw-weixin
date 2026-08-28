import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../storage/state-dir.js";

/**
 * Resolve the framework credentials directory (mirrors core resolveOAuthDir).
 * Path: $OPENCLAW_OAUTH_DIR || $OPENCLAW_STATE_DIR/credentials || ~/.openclaw/credentials
 */
function resolveCredentialsDir(): string {
  const override = process.env.OPENCLAW_OAUTH_DIR?.trim();
  if (override) return override;
  return path.join(resolveStateDir(), "credentials");
}

/**
 * Sanitize a channel/account key for safe use in filenames (mirrors core safeChannelKey).
 */
function safeKey(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) throw new Error("invalid key for allowFrom path");
  const safe = trimmed.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") throw new Error("invalid key for allowFrom path");
  return safe;
}

/**
 * Resolve the framework allowFrom file path for a given account.
 * Mirrors: `resolveAllowFromPath(channel, env, accountId)` from core.
 * Path: `<credDir>/openclaw-weixin-<accountId>-allowFrom.json`
 */
export function resolveFrameworkAllowFromPath(accountId: string): string {
  const base = safeKey("openclaw-weixin");
  const safeAccount = safeKey(accountId);
  return path.join(resolveCredentialsDir(), `${base}-${safeAccount}-allowFrom.json`);
}

type AllowFromFileContent = {
  version: number;
  allowFrom: string[];
};

/**
 * Read the framework allowFrom list for an account (user IDs authorized via pairing).
 * Returns an empty array when the file is missing or unreadable.
 */
export function readFrameworkAllowFromList(accountId: string): string[] {
  const filePath = resolveFrameworkAllowFromPath(accountId);
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as AllowFromFileContent;
    if (Array.isArray(parsed.allowFrom)) {
      return parsed.allowFrom.filter((id): id is string => typeof id === "string" && id.trim() !== "");
    }
  } catch {
    // best-effort
  }
  return [];
}
