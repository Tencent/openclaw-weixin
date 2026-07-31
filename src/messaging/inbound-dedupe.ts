import { createHash } from "node:crypto";

import type { MessageItem, WeixinMessage } from "../api/types.js";
import { MessageItemType } from "../api/types.js";
import { logger } from "../util/logger.js";

/**
 * Replay-dedupe TTL for getUpdates at-least-once delivery (~1s typical spacing).
 * Not a content-dedupe window: a new user send with a new message_id is always claimed.
 * In-memory Map — single process only; multi-instance gateways need a shared store (out of scope).
 */
export const WEIXIN_INBOUND_DEDUPE_TTL_MS = 5 * 60 * 1000;
const WEIXIN_INBOUND_DEDUPE_MAX_ENTRIES = 20_000;

/** Process-local claim store (single-instance deploy). */
const seenAt = new Map<string, number>();

function extractTextForFallback(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return String(item.voice_item.text);
    }
  }
  return "";
}

/**
 * Stable inbound identity for dedupe + MessageSid.
 * Prefer transport ids from iLink; fall back to content fingerprint.
 */
export function buildWeixinInboundDedupeKey(
  accountId: string,
  msg: WeixinMessage,
): string | null {
  const from = msg.from_user_id ?? "";
  if (!accountId) return null;

  if (msg.message_id != null && Number.isFinite(msg.message_id)) {
    return `weixin:v1:${accountId}:${from}:mid:${msg.message_id}`;
  }
  if (msg.client_id) {
    return `weixin:v1:${accountId}:${from}:cid:${msg.client_id}`;
  }
  if (msg.seq != null && Number.isFinite(msg.seq)) {
    return `weixin:v1:${accountId}:${from}:seq:${msg.seq}`;
  }

  const body = extractTextForFallback(msg.item_list);
  const t = msg.create_time_ms ?? 0;
  if (!from && !body && !t) return null;
  const digest = createHash("sha256")
    .update(body)
    .update("\0")
    .update(String(t))
    .digest("hex")
    .slice(0, 16);
  return `weixin:v1:${accountId}:${from}:body:${digest}`;
}

function pruneExpired(now: number): void {
  for (const [key, at] of seenAt) {
    if (now - at > WEIXIN_INBOUND_DEDUPE_TTL_MS) seenAt.delete(key);
  }
  if (seenAt.size <= WEIXIN_INBOUND_DEDUPE_MAX_ENTRIES) return;
  // Hard cap: drop oldest half when overflowing.
  const entries = [...seenAt.entries()].sort((a, b) => a[1] - b[1]);
  const drop = Math.ceil(entries.length / 2);
  for (let i = 0; i < drop; i++) {
    seenAt.delete(entries[i]![0]);
  }
}

/**
 * Claim a logical inbound message for processing.
 * @returns true if this is the first claim (process it); false if a duplicate within TTL.
 */
export function claimWeixinInboundMessage(key: string, now = Date.now()): boolean {
  pruneExpired(now);
  const prev = seenAt.get(key);
  if (prev != null && now - prev <= WEIXIN_INBOUND_DEDUPE_TTL_MS) {
    return false;
  }
  seenAt.set(key, now);
  return true;
}

/** Test helper — clears the in-memory cache. */
export function resetWeixinInboundDedupeForTests(): void {
  seenAt.clear();
}

export function logWeixinInboundDuplicate(params: {
  accountId: string;
  key: string;
  messageId?: number;
  seq?: number;
  from?: string;
}): void {
  logger.info(
    `[weixin] dropping duplicate inbound message account=${params.accountId} key=${params.key} msgId=${params.messageId ?? "?"} seq=${params.seq ?? "?"} from=${params.from ?? "?"}`,
  );
}
