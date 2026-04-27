import path from "node:path";
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";
import { getMimeFromFilename } from "../media/mime.js";
import { sendFileMessageWeixin, sendImageMessageWeixin, sendVideoMessageWeixin } from "./send.js";
import { uploadFileAttachmentToWeixin, uploadFileToWeixin, uploadVideoToWeixin } from "../cdn/upload.js";

/**
 * Short-window dedup for `sendWeixinMediaFile`.
 *
 * Background: the OpenClaw core delivery layer can re-parse a `MEDIA:` directive
 * out of an agent's text payload AND simultaneously honor an explicit `media`
 * field passed to the `message` tool. When both code paths reach this plugin,
 * we receive two `sendWeixinMediaFile` calls for the same `(to, filePath)` pair
 * within a few seconds and the recipient sees the same image / file twice
 * (see https://github.com/Tencent/openclaw-weixin/issues/74).
 *
 * Until the upstream is fixed, we keep an in-memory map keyed by
 * `${to}::${filePath}` recording the most recent successful send. A second
 * call landing inside DEDUP_WINDOW_MS short-circuits and returns the same
 * `messageId` without re-uploading.
 *
 * The map is bounded: once it grows past DEDUP_GC_THRESHOLD entries we evict
 * anything older than DEDUP_GC_MAX_AGE_MS.
 *
 * Exported helpers are for tests only — production code should not rely on
 * the cache being cleared between calls.
 */
const DEDUP_WINDOW_MS = 5000;
const DEDUP_GC_THRESHOLD = 100;
const DEDUP_GC_MAX_AGE_MS = 60_000;

interface DedupEntry {
  ts: number;
  messageId: string;
}

const recentSends = new Map<string, DedupEntry>();

function dedupKey(to: string, filePath: string): string {
  return `${to}::${filePath}`;
}

function checkDedup(to: string, filePath: string): { messageId: string } | null {
  const key = dedupKey(to, filePath);
  const prev = recentSends.get(key);
  if (prev && Date.now() - prev.ts < DEDUP_WINDOW_MS) {
    return { messageId: prev.messageId };
  }
  return null;
}

function recordSend(to: string, filePath: string, messageId: string): void {
  recentSends.set(dedupKey(to, filePath), { ts: Date.now(), messageId });
  if (recentSends.size > DEDUP_GC_THRESHOLD) {
    const cutoff = Date.now() - DEDUP_GC_MAX_AGE_MS;
    for (const [k, v] of recentSends) {
      if (v.ts < cutoff) recentSends.delete(k);
    }
  }
}

/** @internal Test-only hook: wipe the dedup map between assertions. */
export function __resetSendMediaDedupForTests(): void {
  recentSends.clear();
}

/** @internal Test-only hook: introspect map size for GC assertions. */
export function __sendMediaDedupSizeForTests(): number {
  return recentSends.size;
}

/**
 * Upload a local file and send it as a weixin message, routing by MIME type:
 *   video/*  → uploadVideoToWeixin        + sendVideoMessageWeixin
 *   image/*  → uploadFileToWeixin         + sendImageMessageWeixin
 *   else     → uploadFileAttachmentToWeixin + sendFileMessageWeixin
 *
 * Used by both the auto-reply deliver path (monitor.ts) and the outbound
 * sendMedia path (channel.ts) so they stay in sync.
 *
 * Repeat invocations for the same `(to, filePath)` within
 * {@link DEDUP_WINDOW_MS} are short-circuited and return the previous
 * `messageId` (see issue #74).
 */
export async function sendWeixinMediaFile(params: {
  filePath: string;
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
  cdnBaseUrl: string;
}): Promise<{ messageId: string }> {
  const { filePath, to, text, opts, cdnBaseUrl } = params;

  const dedup = checkDedup(to, filePath);
  if (dedup) {
    logger.warn(
      `[weixin] sendWeixinMediaFile: DEDUP — skipping duplicate send to=${to} filePath=${filePath} messageId=${dedup.messageId}`,
    );
    return dedup;
  }

  const mime = getMimeFromFilename(filePath);
  const uploadOpts: WeixinApiOptions = { baseUrl: opts.baseUrl, token: opts.token };

  if (mime.startsWith("video/")) {
    logger.info(`[weixin] sendWeixinMediaFile: uploading video filePath=${filePath} to=${to}`);
    const uploaded = await uploadVideoToWeixin({
      filePath,
      toUserId: to,
      opts: uploadOpts,
      cdnBaseUrl,
    });
    logger.info(
      `[weixin] sendWeixinMediaFile: video upload done filekey=${uploaded.filekey} size=${uploaded.fileSize}`,
    );
    const result = await sendVideoMessageWeixin({ to, text, uploaded, opts });
    recordSend(to, filePath, result.messageId);
    return result;
  }

  if (mime.startsWith("image/")) {
    logger.info(`[weixin] sendWeixinMediaFile: uploading image filePath=${filePath} to=${to}`);
    const uploaded = await uploadFileToWeixin({
      filePath,
      toUserId: to,
      opts: uploadOpts,
      cdnBaseUrl,
    });
    logger.info(
      `[weixin] sendWeixinMediaFile: image upload done filekey=${uploaded.filekey} size=${uploaded.fileSize}`,
    );
    const result = await sendImageMessageWeixin({ to, text, uploaded, opts });
    recordSend(to, filePath, result.messageId);
    return result;
  }

  // File attachment: pdf, doc, zip, etc.
  const fileName = path.basename(filePath);
  logger.info(
    `[weixin] sendWeixinMediaFile: uploading file attachment filePath=${filePath} name=${fileName} to=${to}`,
  );
  const uploaded = await uploadFileAttachmentToWeixin({
    filePath,
    fileName,
    toUserId: to,
    opts: uploadOpts,
    cdnBaseUrl,
  });
  logger.info(
    `[weixin] sendWeixinMediaFile: file upload done filekey=${uploaded.filekey} size=${uploaded.fileSize}`,
  );
  const result = await sendFileMessageWeixin({ to, text, fileName, uploaded, opts });
  recordSend(to, filePath, result.messageId);
  return result;
}
