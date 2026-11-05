import type { MessageItem, RefMessage, WeixinMessage } from "../api/types.js";
import { MessageItemType } from "../api/types.js";
import { resolveMediaDownloadPolicy } from "../config/media-download.js";
import { downloadMediaFromItem } from "../media/media-download.js";
import {
  attachAdditionalMedia,
  downloadableMediaItems,
  downloadedMediaEntry,
  isMediaItem,
  inlineQuoteBody,
  resolveStoredQuoteContext,
  weixinMessageToMsgContext,
} from "./inbound.js";
import type { WeixinInboundMediaOpts } from "./inbound.js";
import { getActiveQuoteMediaSubdir, getQuoteStore } from "./quote-store.js";
import type { ProcessMessageDeps } from "./process-message.js";

export type PreparedInboundMessage = {
  message: WeixinMessage;
  ctx: ReturnType<typeof weixinMessageToMsgContext>;
  downloadedItems: Map<MessageItem, WeixinInboundMediaOpts>;
  release: () => void;
};

/** Download one original message atomically; failure releases only its own media. */
export async function prepareInboundMessage(
  full: WeixinMessage,
  deps: ProcessMessageDeps,
): Promise<PreparedInboundMessage> {
  const downloadPolicy = resolveMediaDownloadPolicy(deps.config);
  const quoteStore = getQuoteStore();
  const mediaLease = quoteStore?.createMediaLease(deps.accountId);
  try {
    const mediaOpts: WeixinInboundMediaOpts = {};

    // Download in original item order; quoted media is a fallback only.
    const hasDownloadableMedia = (m?: { encrypt_query_param?: string; full_url?: string }) =>
      m?.encrypt_query_param || m?.full_url;
    const firstMediaItem = downloadableMediaItems(full)[0];
    const downloadedItems = new Map<MessageItem, WeixinInboundMediaOpts>();
    const saveMedia =
      quoteStore && mediaLease && !quoteStore.usesInboundMediaStorage()
        ? (buffer: Buffer, type?: string, _subdir?: string, max?: number, name?: string) =>
            mediaLease.saveMediaBuffer(buffer, type, max, name)
        : deps.channelRuntime.media.saveMediaBuffer;
    const downloadItem = async (item: MessageItem, label: string) => {
      const downloaded = await downloadMediaFromItem(item, {
        ...downloadPolicy,
        cdnBaseUrl: deps.cdnBaseUrl,
        saveMedia,
        mediaSubdir: getActiveQuoteMediaSubdir(deps.accountId),
        log: deps.log,
        errLog: deps.errLog,
        label,
        abortSignal: deps.abortSignal,
        throwOnError: true,
      });
      downloadedItems.set(item, downloaded);
      return downloaded;
    };
    const refMediaCandidate = !firstMediaItem
      ? full.item_list?.find(
          (i) =>
            i.type === MessageItemType.TEXT &&
            i.ref_msg?.message_item &&
            isMediaItem(i.ref_msg.message_item!),
        )?.ref_msg?.message_item
      : undefined;

    // Metadata-only references can use storage; only actual URLs need a fallback download.
    const refMediaItem =
      refMediaCandidate &&
      (hasDownloadableMedia(refMediaCandidate.image_item?.media) ||
        hasDownloadableMedia(refMediaCandidate.video_item?.media) ||
        hasDownloadableMedia(refMediaCandidate.file_item?.media) ||
        hasDownloadableMedia(refMediaCandidate.voice_item?.media))
        ? refMediaCandidate
        : undefined;

    if (firstMediaItem) {
      const downloaded = await downloadItem(firstMediaItem, "inbound");
      Object.assign(mediaOpts, downloaded);
    }

    deps.abortSignal?.throwIfAborted();
    const ctx = weixinMessageToMsgContext(full, deps.accountId, mediaOpts);

    if (firstMediaItem) {
      await attachAdditionalMedia(ctx, full, firstMediaItem, (item) =>
        downloadItem(item, "inbound"),
      );
    }

    const cachedQuoteAttached = resolveStoredQuoteContext(ctx, full, deps.accountId);
    if (refMediaItem && !cachedQuoteAttached) {
      try {
        const downloaded = await downloadItem(refMediaItem, "ref");
        const entry = downloadedMediaEntry(refMediaItem, downloaded);
        if (entry) {
          ctx.media = [{ ...entry, ...(ctx.ReplyToId ? { messageId: ctx.ReplyToId } : {}) }];
          ctx.MediaPaths = [entry.path];
          ctx.MediaTypes = [entry.contentType];
          // A successful fetch replaces any stale-cache expiration label.
          ctx.ReplyToBody = weixinMessageToMsgContext(full, deps.accountId).ReplyToBody;
        }
      } catch (error) {
        deps.abortSignal?.throwIfAborted();
        deps.errLog(
          `weixin quoted attachment unavailable; continuing current message: ${String(error)}`,
        );
        ctx.ReplyToBody = [ctx.ReplyToBody, "[引用附件暂不可用]"].filter(Boolean).join("\n");
      }
    }
    for (const filePath of ctx.MediaPaths ?? (ctx.MediaPath ? [ctx.MediaPath] : [])) {
      mediaLease?.retain(filePath);
    }
    return { message: full, ctx, downloadedItems, release: () => mediaLease?.release() };
  } catch (error) {
    mediaLease?.release();
    throw error;
  }
}

/** Reuse prepared bytes and preserve attachment metadata without another download. */
export function combinePreparedMedia(
  ctx: PreparedInboundMessage["ctx"],
  prepared: PreparedInboundMessage[],
): void {
  const entries = prepared.flatMap(({ ctx: sourceCtx, downloadedItems }) => {
    if (sourceCtx.media) return sourceCtx.media;
    const facts = new Map(
      [...downloadedItems].flatMap(([item, media]) => {
        const entry = downloadedMediaEntry(item, media);
        return entry ? [[entry.path, entry] as const] : [];
      }),
    );
    const paths = sourceCtx.MediaPaths ?? (sourceCtx.MediaPath ? [sourceCtx.MediaPath] : []);
    const types = sourceCtx.MediaTypes ?? (sourceCtx.MediaPath ? [sourceCtx.MediaType] : []);
    return paths.map(
      (filePath, index) =>
        facts.get(filePath) ?? {
          path: filePath,
          contentType: types[index] ?? "application/octet-stream",
        },
    );
  });
  if (!entries.length) return;
  ctx.media = entries;
  ctx.MediaPaths = entries.map((entry) => entry.path!);
  ctx.MediaTypes = entries.map((entry) => entry.contentType ?? "application/octet-stream");
  ctx.ChannelPromptContext = prepared.flatMap((item) => item.ctx.ChannelPromptContext ?? []);
  delete ctx.MediaPath;
  delete ctx.MediaType;
}

/** Carry resolved ID-only quote text into the final merge without changing raw source records. */
export function preparedQuoteBodies(
  prepared: PreparedInboundMessage[],
): ReadonlyMap<RefMessage, string> {
  return new Map(
    prepared.flatMap(({ message, ctx }) => {
      const item = message.item_list?.find((item) => item.ref_msg);
      const ref = item?.ref_msg;
      const body = ctx.ReplyToQuoteText ?? ctx.ReplyToBody;
      return ref && item && body && body !== inlineQuoteBody(item) ? [[ref, body] as const] : [];
    }),
  );
}
