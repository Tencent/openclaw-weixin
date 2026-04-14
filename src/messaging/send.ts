import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

import { sendMessage as sendMessageApi } from "../api/api.js";
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";
import { generateId } from "../util/random.js";
import type { MessageItem, SendMessageReq } from "../api/types.js";
import { MessageItemType, MessageState, MessageType } from "../api/types.js";
import type { UploadedFileInfo } from "../cdn/upload.js";

export { StreamingMarkdownFilter } from "./markdown-filter.js";

function generateClientId(): string {
  return generateId("openclaw-weixin");
}

/** Build a SendMessageReq containing a single text message. */
function buildTextMessageReq(params: {
  to: string;
  text: string;
  contextToken?: string;
  clientId: string;
}): SendMessageReq {
  const { to, text, contextToken, clientId } = params;
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
    },
  };
}

/** Build a SendMessageReq from a reply payload (text only; image send uses sendImageMessageWeixin). */
function buildSendMessageReq(params: {
  to: string;
  contextToken?: string;
  payload: ReplyPayload;
  clientId: string;
}): SendMessageReq {
  const { to, contextToken, payload, clientId } = params;
  return buildTextMessageReq({
    to,
    text: payload.text ?? "",
    contextToken,
    clientId,
  });
}

/**
 * Send a plain text message downstream.
 */
export async function sendMessageWeixin(params: {
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, opts } = params;
  if (!opts.contextToken) {
    logger.warn(`sendMessageWeixin: contextToken missing for to=${to}, sending without context`);
  }
  const clientId = generateClientId();
  const req = buildSendMessageReq({
    to,
    contextToken: opts.contextToken,
    payload: { text },
    clientId,
  });
  try {
    await sendMessageApi({
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      body: req,
    });
  } catch (err) {
    logger.error(`sendMessageWeixin: failed to=${to} clientId=${clientId} err=${String(err)}`);
    throw err;
  }
  return { messageId: clientId };
}

/**
 * Send one or more MessageItems (optionally preceded by a text caption) downstream.
 * Each item is sent as its own request so that item_list always has exactly one entry.
 */
async function sendMediaItems(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: WeixinApiOptions & { contextToken?: string };
  label: string;
}): Promise<{ messageId: string }> {
  const { to, text, mediaItem, opts, label } = params;

  const items: MessageItem[] = [];
  if (text) {
    items.push({ type: MessageItemType.TEXT, text_item: { text } });
  }
  items.push(mediaItem);

  let lastClientId = "";
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
      },
    };
    try {
      await sendMessageApi({
        baseUrl: opts.baseUrl,
        token: opts.token,
        timeoutMs: opts.timeoutMs,
        body: req,
      });
    } catch (err) {
      logger.error(
        `${label}: failed to=${to} clientId=${lastClientId} err=${String(err)}`,
      );
      throw err;
    }
  }

  logger.info(`${label}: success to=${to} clientId=${lastClientId}`);
  return { messageId: lastClientId };
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
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.warn(`sendImageMessageWeixin: contextToken missing for to=${to}, sending without context`);
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

  return sendMediaItems({ to, text, mediaItem: imageItem, opts, label: "sendImageMessageWeixin" });
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
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.warn(`sendVideoMessageWeixin: contextToken missing for to=${to}, sending without context`);
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

  return sendMediaItems({ to, text, mediaItem: videoItem, opts, label: "sendVideoMessageWeixin" });
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
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, fileName, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.warn(`sendFileMessageWeixin: contextToken missing for to=${to}, sending without context`);
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

  return sendMediaItems({ to, text, mediaItem: fileItem, opts, label: "sendFileMessageWeixin" });
}

/**
 * Send a voice message downstream using a previously uploaded audio file.
 * VoiceItem: media (CDN ref), encode_type, sample_rate, playtime (ms).
 * Supported encode_type: 6=SILK, 5=AMR, 7=MP3, 8=OGG-SPEEX.
 * Includes an optional text caption sent as a separate TEXT item first.
 */
export async function sendVoiceMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: import("../cdn/upload.js").UploadedFileInfo;
  playtimeMs?: number;
  encodeType?: number;
  opts: import("../api/api.js").WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, uploaded, playtimeMs, encodeType, opts } = params;
  if (!opts.contextToken) {
    logger.warn(`sendVoiceMessageWeixin: contextToken missing for to=${to}, sending without context`);
  }
  logger.info(
    `sendVoiceMessageWeixin: to=${to} filekey=${uploaded.filekey} fileSize=${uploaded.fileSize} playtimeMs=${playtimeMs ?? "auto"}`,
  );

  const voiceItem: MessageItem = {
    type: MessageItemType.VOICE,
    voice_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      encode_type: encodeType ?? 6,
      bits_per_sample: 16,
      sample_rate: 24000,
      playtime: playtimeMs ?? Math.round((uploaded.fileSize / 24000) * 1000),
    },
  };

  return sendMediaItems({ to, text, mediaItem: voiceItem, opts, label: "sendVoiceMessageWeixin" });
}
