import fs from "node:fs";
import path from "node:path";

import { logger } from "../util/logger.js";
import { generateId } from "../util/random.js";
import type { WeixinMessage, MessageItem } from "../api/types.js";
import { MessageItemType } from "../api/types.js";
import { resolveStateDir } from "../storage/state-dir.js";
import { resolvePartialQuote } from "./partial-quote.js";
import { getQuoteStore } from "./quote-store.js";
import type { QuoteStore } from "./quote-store.js";

// ---------------------------------------------------------------------------
// Context token store (in-process cache + disk persistence)
// ---------------------------------------------------------------------------

/**
 * contextToken is issued per-message by the Weixin getupdates API and must
 * be echoed verbatim in every outbound send. The in-memory map is the primary
 * lookup; a disk-backed file per account ensures tokens survive gateway restarts.
 */
const contextTokenStore = new Map<string, string>();

function contextTokenKey(accountId: string, userId: string): string {
  return `${accountId}:${userId}`;
}

// ---------------------------------------------------------------------------
// Disk persistence helpers
// ---------------------------------------------------------------------------

function resolveContextTokenFilePath(accountId: string): string {
  return path.join(
    resolveStateDir(),
    "openclaw-weixin",
    "accounts",
    `${accountId}.context-tokens.json`,
  );
}

/** Persist all context tokens for a given account to disk. */
function persistContextTokens(accountId: string): void {
  const prefix = `${accountId}:`;
  const tokens: Record<string, string> = {};
  for (const [k, v] of contextTokenStore) {
    if (k.startsWith(prefix)) {
      tokens[k.slice(prefix.length)] = v;
    }
  }
  const filePath = resolveContextTokenFilePath(accountId);
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(tokens, null, 0), "utf-8");
  } catch (err) {
    logger.warn(`persistContextTokens: failed to write ${filePath}: ${String(err)}`);
  }
}

/**
 * Restore persisted context tokens for an account into the in-memory map.
 * Called once during gateway startAccount to survive restarts.
 */
export function restoreContextTokens(accountId: string): void {
  const filePath = resolveContextTokenFilePath(accountId);
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, "utf-8");
    const tokens = JSON.parse(raw) as Record<string, string>;
    let count = 0;
    for (const [userId, token] of Object.entries(tokens)) {
      if (typeof token === "string" && token) {
        contextTokenStore.set(contextTokenKey(accountId, userId), token);
        count++;
      }
    }
    logger.info(`restoreContextTokens: restored ${count} tokens for account=${accountId}`);
  } catch (err) {
    logger.warn(`restoreContextTokens: failed to read ${filePath}: ${String(err)}`);
  }
}

/** Remove all context tokens for a given account (memory + disk). */
export function clearContextTokensForAccount(accountId: string): void {
  const prefix = `${accountId}:`;
  for (const k of [...contextTokenStore.keys()]) {
    if (k.startsWith(prefix)) {
      contextTokenStore.delete(k);
    }
  }
  const filePath = resolveContextTokenFilePath(accountId);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    logger.warn(`clearContextTokensForAccount: failed to remove ${filePath}: ${String(err)}`);
  }
  logger.info(`clearContextTokensForAccount: cleared tokens for account=${accountId}`);
}

/** Store a context token for a given account+user pair (memory + disk). */
export function setContextToken(accountId: string, userId: string, token: string): void {
  const k = contextTokenKey(accountId, userId);
  logger.debug(`setContextToken: key=${k}`);
  contextTokenStore.set(k, token);
  persistContextTokens(accountId);
}

/** Retrieve the cached context token for a given account+user pair. */
export function getContextToken(accountId: string, userId: string): string | undefined {
  const k = contextTokenKey(accountId, userId);
  const val = contextTokenStore.get(k);
  logger.debug(
    `getContextToken: key=${k} found=${val !== undefined} storeSize=${contextTokenStore.size}`,
  );
  return val;
}

/**
 * Find all accountIds that have an active contextToken for the given userId.
 * Used to infer the sending bot account from the recipient address when
 * accountId is not explicitly provided (e.g. cron delivery).
 *
 * Returns all matching accountIds (not just the first) so the caller can
 * detect ambiguity when multiple accounts have sessions with the same user.
 */
export function findAccountIdsByContextToken(
  accountIds: string[],
  userId: string,
): string[] {
  return accountIds.filter((id) => contextTokenStore.has(contextTokenKey(id, userId)));
}

// ---------------------------------------------------------------------------
// Message ID generation
// ---------------------------------------------------------------------------

function generateMessageSid(): string {
  return generateId("openclaw-weixin");
}

/** Inbound context passed to the OpenClaw core pipeline (matches MsgContext shape). */
export type WeixinMsgContext = {
  Body: string;
  From: string;
  To: string;
  AccountId: string;
  OriginatingChannel: "openclaw-weixin";
  OriginatingTo: string;
  MessageSid: string;
  /** Provider message ID retained losslessly for transcript metadata. */
  MessageSidFull?: string;
  Timestamp?: number;
  Provider: "openclaw-weixin";
  ChatType: "direct";
  /** Set by monitor after resolveAgentRoute so dispatchReplyFromConfig uses the correct session. */
  SessionKey?: string;
  context_token?: string;
  MediaUrl?: string;
  MediaPath?: string;
  MediaType?: string;
  MediaPaths?: string[];
  MediaTypes?: string[];
  media?: Array<{
    path?: string;
    contentType?: string;
    fileName?: string;
    messageId?: string;
  }>;
  ReplyToId?: string;
  ReplyToBody?: string;
  ReplyToQuoteText?: string;
  ReplyToIsQuote?: boolean;
  /** Raw message body for framework command authorization. */
  CommandBody?: string;
  /** Whether the sender is authorized to execute slash commands. */
  CommandAuthorized?: boolean;
};

/** Returns true if the message item is a media type (image, video, file, or voice). */
export function isMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VIDEO ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VOICE
  );
}

export function getMediaLabel(type: number | undefined): string {
  switch (type) {
    case MessageItemType.IMAGE:
      return "[图片]";
    case MessageItemType.VIDEO:
      return "[视频]";
    case MessageItemType.FILE:
      return "[文件]";
    case MessageItemType.VOICE:
      return "[语音]";
    default:
      return "";
  }
}

export function getWeixinMessageId(msg: WeixinMessage): string | undefined {
  const topLevel = msg.message_id?.trim();
  if (topLevel) return topLevel;
  for (const item of msg.item_list ?? []) {
    const itemId = item.msg_id?.trim();
    if (itemId) return itemId;
  }
  return undefined;
}

function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
    // 语音转文字：如果语音消息有 text 字段，直接使用文字内容
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
    if (isMediaItem(item)) return getMediaLabel(item.type);
  }
  return "";
}

export type WeixinInboundMediaOpts = {
  /** Local path to decrypted image file. */
  decryptedPicPath?: string;
  /** Local path to transcoded/raw voice file (.wav or .silk). */
  decryptedVoicePath?: string;
  /** MIME type for the voice file (e.g. "audio/wav" or "audio/silk"). */
  voiceMediaType?: string;
  /** Local path to decrypted file attachment. */
  decryptedFilePath?: string;
  /** MIME type for the file attachment (guessed from file_name). */
  fileMediaType?: string;
  /** Local path to decrypted video file. */
  decryptedVideoPath?: string;
  /** The downloaded media belongs to an inline quoted message, not the current message. */
  referencedMedia?: boolean;
};

/**
 * Convert a WeixinMessage from getUpdates to the inbound MsgContext for the core pipeline.
 * Media: only pass MediaPath (local file, after CDN download + decrypt).
 * We never pass MediaUrl — the upstream CDN URL is encrypted/auth-only.
 * Priority when multiple media types present: image > video > file > voice.
 */
export function weixinMessageToMsgContext(
  msg: WeixinMessage,
  accountId: string,
  opts?: WeixinInboundMediaOpts,
): WeixinMsgContext {
  const from_user_id = msg.from_user_id ?? "";
  const ctx: WeixinMsgContext = {
    Body: bodyFromItemList(msg.item_list),
    From: from_user_id,
    To: from_user_id,
    AccountId: accountId,
    OriginatingChannel: "openclaw-weixin",
    OriginatingTo: from_user_id,
    MessageSid: generateMessageSid(),
    Timestamp: msg.create_time_ms,
    Provider: "openclaw-weixin",
    ChatType: "direct",
  };
  if (msg.context_token) {
    ctx.context_token = msg.context_token;
  }
  const providerMessageId = getWeixinMessageId(msg);
  if (providerMessageId) ctx.MessageSidFull = providerMessageId;

  if (opts?.decryptedPicPath) {
    ctx.MediaPath = opts.decryptedPicPath;
    ctx.MediaType = "image/*";
  } else if (opts?.decryptedVideoPath) {
    ctx.MediaPath = opts.decryptedVideoPath;
    ctx.MediaType = "video/mp4";
  } else if (opts?.decryptedFilePath) {
    ctx.MediaPath = opts.decryptedFilePath;
    ctx.MediaType = opts.fileMediaType ?? "application/octet-stream";
  } else if (opts?.decryptedVoicePath) {
    ctx.MediaPath = opts.decryptedVoicePath;
    ctx.MediaType = opts.voiceMediaType ?? "audio/wav";
  }

  if (opts?.referencedMedia && ctx.MediaPath) {
    ctx.MediaPaths = [ctx.MediaPath];
    ctx.MediaTypes = [ctx.MediaType ?? "application/octet-stream"];
    delete ctx.MediaPath;
    delete ctx.MediaType;
  }

  applyInlineQuoteContext(ctx, msg);

  return ctx;
}

function findReferenceItem(msg: WeixinMessage): MessageItem | undefined {
  return msg.item_list?.find((item) => item.ref_msg);
}

function inlineQuoteBody(item: MessageItem): string | undefined {
  const ref = item.ref_msg;
  if (!ref) return undefined;
  const parts: string[] = [];
  if (ref.title?.trim()) parts.push(ref.title.trim());
  if (ref.message_item) {
    const body = bodyFromItemList([ref.message_item]);
    if (body) parts.push(body);
  }
  return parts.length ? parts.join(" | ") : undefined;
}

function applyInlineQuoteContext(ctx: WeixinMsgContext, msg: WeixinMessage): void {
  const item = findReferenceItem(msg);
  if (!item?.ref_msg) return;
  const replyToId = item.ref_msg.svr_id?.trim() || item.ref_msg.message_item?.msg_id?.trim();
  const body = inlineQuoteBody(item);
  ctx.ReplyToIsQuote = true;
  if (replyToId) ctx.ReplyToId = replyToId;
  if (body) ctx.ReplyToBody = body;
}

function expiredMediaLabel(mime?: string, name?: string): string {
  const kind = mime?.startsWith("image/")
    ? "图片"
    : mime?.startsWith("video/")
      ? "视频"
      : mime?.startsWith("audio/")
        ? "语音"
        : "附件";
  return name ? `[引用的${kind}已过期: ${name}]` : `[引用的${kind}已过期]`;
}

/** Resolve an ID-only quote after sender authorization has succeeded. */
export function resolveStoredQuoteContext(
  ctx: WeixinMsgContext,
  msg: WeixinMessage,
  accountId: string,
  store: Pick<QuoteStore, "find"> | null = getQuoteStore(),
): void {
  const item = findReferenceItem(msg);
  const ref = item?.ref_msg;
  const referenceId = ref?.svr_id?.trim() || ref?.message_item?.msg_id?.trim();
  if (!item || !ref || !referenceId) return;

  ctx.ReplyToId = referenceId;
  ctx.ReplyToIsQuote = true;
  if (ctx.ReplyToBody && (ref.title?.trim() || ref.message_item)) return;
  const record = store?.find(accountId, ctx.From, referenceId);
  if (!record) {
    if (!ctx.ReplyToBody) ctx.ReplyToBody = "[引用消息内容未缓存]";
    return;
  }

  ctx.ReplyToBody = record.body || expiredMediaLabel(record.mediaMime, record.mediaName);
  if (ref.partial_text && record.body) {
    const partial = resolvePartialQuote(record.body, ref.partial_text);
    if (!partial.fallback && partial.resolved) ctx.ReplyToQuoteText = partial.resolved;
  }

  if (!record.mediaPath) {
    if (record.mediaMime || record.mediaName) {
      ctx.ReplyToBody = expiredMediaLabel(record.mediaMime, record.mediaName);
    }
    return;
  }
  if (!fs.existsSync(record.mediaPath)) {
    ctx.ReplyToBody = expiredMediaLabel(record.mediaMime, record.mediaName);
    return;
  }
  const currentPaths = ctx.MediaPaths ?? (ctx.MediaPath ? [ctx.MediaPath] : []);
  const currentTypes =
    ctx.MediaTypes ?? (ctx.MediaPath ? [ctx.MediaType ?? "application/octet-stream"] : []);
  ctx.MediaPaths = [...currentPaths, record.mediaPath];
  ctx.MediaTypes = [...currentTypes, record.mediaMime ?? "application/octet-stream"];
  ctx.media = ctx.MediaPaths.map((mediaPath, index) => ({
    path: mediaPath,
    contentType: ctx.MediaTypes?.[index] ?? "application/octet-stream",
    ...(index === ctx.MediaPaths!.length - 1 && record.mediaName
      ? { fileName: record.mediaName }
      : {}),
    ...(index === ctx.MediaPaths!.length - 1 ? { messageId: referenceId } : {}),
  }));
}

/** Extract the context_token from an inbound WeixinMsgContext. */
export function getContextTokenFromMsgContext(ctx: WeixinMsgContext): string | undefined {
  return ctx.context_token;
}
