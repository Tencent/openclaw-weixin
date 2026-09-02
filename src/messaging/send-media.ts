import path from "node:path";

import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";
import { getMimeFromFilename } from "../media/mime.js";
import {
  sendFileMessageWeixin,
  sendImageMessageWeixin,
  sendVideoMessageWeixin,
} from "./send.js";
import {
  uploadFileAttachmentToWeixin,
  uploadFileToWeixin,
  uploadVideoToWeixin,
} from "../cdn/upload.js";

export type SendWeixinMediaFileParams = {
  filePath: string;
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string; runId?: string };
  cdnBaseUrl: string;
  /** Ignored: native VOICE is disabled (iLink does not render bot bubbles). */
  asVoice?: boolean;
  /** Force FILE attachment (default for audio as well). */
  forceDocument?: boolean;
};

async function sendAsFileAttachment(params: SendWeixinMediaFileParams): Promise<{ messageId: string }> {
  const { filePath, to, text, opts, cdnBaseUrl } = params;
  const uploadOpts: WeixinApiOptions = { baseUrl: opts.baseUrl, token: opts.token };
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
  return sendFileMessageWeixin({ to, text, fileName, uploaded, opts });
}

/**
 * Upload a local file and send it as a weixin message, routing by MIME type:
 *   video/*  -> uploadVideoToWeixin        + sendVideoMessageWeixin
 *   image/*  -> uploadFileToWeixin         + sendImageMessageWeixin
 *   audio/*  -> FILE attachment (native VOICE disabled: iLink does not render bot bubbles)
 *   else     -> uploadFileAttachmentToWeixin + sendFileMessageWeixin
 *
 * Used by both the auto-reply deliver path (monitor.ts) and the outbound
 * sendMedia path (channel.ts) so they stay in sync.
 */
export async function sendWeixinMediaFile(
  params: SendWeixinMediaFileParams,
): Promise<{ messageId: string }> {
  const { filePath, to, text, opts, cdnBaseUrl } = params;
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
    return sendVideoMessageWeixin({ to, text, uploaded, opts });
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
    return sendImageMessageWeixin({ to, text, uploaded, opts });
  }

  return sendAsFileAttachment(params);
}
