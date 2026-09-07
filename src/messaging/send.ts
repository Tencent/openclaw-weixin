import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

import { sendMessage as sendMessageApi } from "../api/api.js";
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";
import { generateId } from "../util/random.js";
import type { MessageItem, SendMessageReq } from "../api/types.js";
import { MessageItemType, MessageState, MessageType } from "../api/types.js";
import type { UploadedFileInfo } from "../cdn/upload.js";
import { getMediaLabel } from "./inbound.js";
import { getQuoteStore } from "./quote-store.js";

export { StreamingMarkdownFilter } from "./markdown-filter.js";

type WeixinMessageSendOptions = WeixinApiOptions & {
  contextToken?: string;
  runId?: string;
  accountId?: string;
};

type WeixinSendResult = { messageId: string; serverMessageId?: string };

async function cacheOutboundMessage(params: {
  opts: WeixinMessageSendOptions;
  to: string;
  serverMessageId?: string;
  body: string;
  sourceMediaPath?: string;
  mediaMime?: string;
  mediaName?: string;
}): Promise<void> {
  if (!params.opts.accountId || !params.serverMessageId) return;
  try {
    await getQuoteStore()?.put({
      accountId: params.opts.accountId,
      conversationId: params.to,
      messageId: params.serverMessageId,
      direction: "outbound",
      body: params.body,
      ...(params.sourceMediaPath ? { sourceMediaPath: params.sourceMediaPath } : {}),
      ...(params.mediaMime ? { mediaMime: params.mediaMime } : {}),
      ...(params.mediaName ? { mediaName: params.mediaName } : {}),
      createdAt: Date.now(),
    });
  } catch (err) {
    logger.warn(
      `quote cache: failed to save outbound message id=${params.serverMessageId}: ${String(err)}`,
    );
  }
}

function generateClientId(): string {
  return generateId("openclaw-weixin");
}

/** Build a SendMessageReq containing a single text message. */
function buildTextMessageReq(params: {
  to: string;
  text: string;
  contextToken?: string;
  runId?: string;
  clientId: string;
}): SendMessageReq {
  const { to, text, contextToken, runId, clientId } = params;
  const item_list: MessageItem[] = text
    ? [{ type: MessageItemType.TEXT, text_item: { text } }]
    : [];
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: item_list.length ? item_list : undefined,
      context_token: contextToken ?? undefined,
      run_id: runId ?? undefined,
    },
  };
}

/** Build a SendMessageReq from a reply payload (text only; image send uses sendImageMessageWeixin). */
function buildSendMessageReq(params: {
  to: string;
  contextToken?: string;
  runId?: string;
  payload: ReplyPayload;
  clientId: string;
}): SendMessageReq {
  const { to, contextToken, runId, payload, clientId } = params;
  return buildTextMessageReq({
    to,
    text: payload.text ?? "",
    contextToken,
    runId,
    clientId,
  });
}

/**
 * Send a plain text message downstream.
 */
export async function sendMessageWeixin(params: {
  to: string;
  text: string;
  opts: WeixinMessageSendOptions;
}): Promise<WeixinSendResult> {
  const { to, text, opts } = params;
  if (!opts.contextToken) {
    logger.warn(`sendMessageWeixin: contextToken missing for to=${to}, sending without context`);
  }
  const clientId = generateClientId();
  const req = buildSendMessageReq({
    to,
    contextToken: opts.contextToken,
    runId: opts.runId,
    payload: { text },
    clientId,
  });
  try {
    const response = await sendMessageApi({
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      body: req,
    });
    const serverMessageId = response?.message_id;
    await cacheOutboundMessage({ opts, to, serverMessageId, body: text });
    return {
      messageId: clientId,
      ...(serverMessageId ? { serverMessageId } : {}),
    };
  } catch (err) {
    logger.error(`sendMessageWeixin: failed to=${to} clientId=${clientId} err=${String(err)}`);
    throw err;
  }
}

/** Send a single structured MessageItem downstream. */
export async function sendMessageItemWeixin(params: {
  to: string;
  item: MessageItem;
  opts: WeixinMessageSendOptions;
  clientId?: string;
  label?: string;
}): Promise<WeixinSendResult> {
  const { to, item, opts } = params;
  if (!opts.contextToken) {
    logger.warn(
      `sendMessageItemWeixin: contextToken missing for to=${to}, sending without context`,
    );
  }
  const clientId = params.clientId ?? generateClientId();
  const req: SendMessageReq = {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [item],
      context_token: opts.contextToken ?? undefined,
      run_id: opts.runId,
    },
  };
  try {
    const response = await sendMessageApi({
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      body: req,
    });
    const serverMessageId = response?.message_id;
    const itemText = item.type === MessageItemType.TEXT ? (item.text_item?.text ?? "") : "";
    if (itemText) await cacheOutboundMessage({ opts, to, serverMessageId, body: itemText });
    return {
      messageId: clientId,
      ...(serverMessageId ? { serverMessageId } : {}),
    };
  } catch (err) {
    logger.error(
      `${params.label ?? "sendMessageItemWeixin"}: failed to=${to} clientId=${clientId} err=${String(err)}`,
    );
    throw err;
  }
}

/**
 * Send one or more MessageItems (optionally preceded by a text caption) downstream.
 * Each item is sent as its own request so that item_list always has exactly one entry.
 */
async function sendMediaItems(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: WeixinMessageSendOptions;
  label: string;
  sourceMediaPath?: string;
  mediaMime?: string;
  mediaName?: string;
}): Promise<WeixinSendResult> {
  const { to, text, mediaItem, opts, label } = params;
  const runId = opts.runId;

  const items: MessageItem[] = [];
  if (text) {
    items.push({ type: MessageItemType.TEXT, text_item: { text } });
  }
  items.push(mediaItem);

  let lastClientId = "";
  let lastServerMessageId: string | undefined;
  for (const item of items) {
    lastClientId = generateClientId();
    const req: SendMessageReq = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: lastClientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: opts.contextToken ?? undefined,
        run_id: runId,
      },
    };
    try {
      const response = await sendMessageApi({
        baseUrl: opts.baseUrl,
        token: opts.token,
        timeoutMs: opts.timeoutMs,
        body: req,
      });
      lastServerMessageId = response?.message_id;
      if (item.type === MessageItemType.TEXT) {
        await cacheOutboundMessage({
          opts,
          to,
          serverMessageId: lastServerMessageId,
          body: item.text_item?.text ?? text,
        });
      } else {
        await cacheOutboundMessage({
          opts,
          to,
          serverMessageId: lastServerMessageId,
          body: getMediaLabel(item.type),
          sourceMediaPath: params.sourceMediaPath,
          mediaMime: params.mediaMime,
          mediaName: params.mediaName,
        });
      }
    } catch (err) {
      logger.error(`${label}: failed to=${to} clientId=${lastClientId} err=${String(err)}`);
      throw err;
    }
  }

  logger.info(`${label}: success to=${to} clientId=${lastClientId}`);
  return {
    messageId: lastClientId,
    ...(lastServerMessageId ? { serverMessageId: lastServerMessageId } : {}),
  };
}

/**
 * Send an image message downstream using a previously uploaded file.
 * Optionally include a text caption as a separate TEXT item before the image.
 *
 * ImageItem fields:
 *   - media.encrypt_query_param: CDN download param
 *   - media.aes_key: AES key, base64-encoded
 *   - mid_size: original ciphertext file size
 */
export async function sendImageMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinMessageSendOptions;
  filePath?: string;
  mediaMime?: string;
}): Promise<WeixinSendResult> {
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.warn(
      `sendImageMessageWeixin: contextToken missing for to=${to}, sending without context`,
    );
  }
  logger.info(
    `sendImageMessageWeixin: to=${to} filekey=${uploaded.filekey} fileSize=${uploaded.fileSize} aeskey=present`,
  );

  const imageItem: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({
    to,
    text,
    mediaItem: imageItem,
    opts,
    label: "sendImageMessageWeixin",
    sourceMediaPath: params.filePath,
    mediaMime: params.mediaMime,
    mediaName: params.filePath?.split(/[\\/]/).pop(),
  });
}

/**
 * Send a video message downstream using a previously uploaded file.
 * VideoItem: media (CDN ref), video_size (ciphertext bytes).
 * Includes an optional text caption sent as a separate TEXT item first.
 */
export async function sendVideoMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinMessageSendOptions;
  filePath?: string;
  mediaMime?: string;
}): Promise<WeixinSendResult> {
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.warn(
      `sendVideoMessageWeixin: contextToken missing for to=${to}, sending without context`,
    );
  }

  const videoItem: MessageItem = {
    type: MessageItemType.VIDEO,
    video_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      video_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({
    to,
    text,
    mediaItem: videoItem,
    opts,
    label: "sendVideoMessageWeixin",
    sourceMediaPath: params.filePath,
    mediaMime: params.mediaMime,
    mediaName: params.filePath?.split(/[\\/]/).pop(),
  });
}

/**
 * Send a file attachment downstream using a previously uploaded file.
 * FileItem: media (CDN ref), file_name, len (plaintext bytes as string).
 * Includes an optional text caption sent as a separate TEXT item first.
 */
export async function sendFileMessageWeixin(params: {
  to: string;
  text: string;
  fileName: string;
  uploaded: UploadedFileInfo;
  opts: WeixinMessageSendOptions;
  filePath?: string;
  mediaMime?: string;
}): Promise<WeixinSendResult> {
  const { to, text, fileName, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.warn(
      `sendFileMessageWeixin: contextToken missing for to=${to}, sending without context`,
    );
  }
  const fileItem: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };

  return sendMediaItems({
    to,
    text,
    mediaItem: fileItem,
    opts,
    label: "sendFileMessageWeixin",
    sourceMediaPath: params.filePath,
    mediaMime: params.mediaMime,
    mediaName: fileName,
  });
}
