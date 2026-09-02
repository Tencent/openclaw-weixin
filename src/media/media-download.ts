import type { WeixinInboundMediaOpts } from "../messaging/inbound.js";
import { logger } from "../util/logger.js";
import { getMimeFromFilename } from "./mime.js";
import {
  downloadAndDecryptBuffer,
  downloadPlainCdnBuffer,
} from "../cdn/pic-decrypt.js";
import fs from "node:fs/promises";
import { isSilkBuffer, silkToWav } from "./silk-transcode.js";
import type { WeixinMessage } from "../api/types.js";
import { MessageItemType } from "../api/types.js";

const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/** Persist a buffer via the framework's unified media store. */
type SaveMediaFn = (
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string,
) => Promise<{ path: string }>;

/**
 * Download and decrypt media from a single MessageItem.
 * Returns the populated WeixinInboundMediaOpts fields; empty object on unsupported type or failure.
 */
export async function downloadMediaFromItem(
  item: WeixinMessage["item_list"] extends (infer T)[] | undefined ? T : never,
  deps: {
    cdnBaseUrl: string;
    saveMedia: SaveMediaFn;
    log: (msg: string) => void;
    errLog: (msg: string) => void;
    label: string;
  },
): Promise<WeixinInboundMediaOpts> {
  const { cdnBaseUrl, saveMedia, log, errLog, label } = deps;
  const result: WeixinInboundMediaOpts = {};

  if (item.type === MessageItemType.IMAGE) {
    const img = item.image_item;
    if (!img?.media?.encrypt_query_param && !img?.media?.full_url) return result;
    const aesKeyBase64 = img.aeskey
      ? Buffer.from(img.aeskey, "hex").toString("base64")
      : img.media.aes_key;
    logger.debug(
      `${label} image: encrypt_query_param=${(img.media.encrypt_query_param ?? "").slice(0, 40)}... hasAesKey=${Boolean(aesKeyBase64)} aeskeySource=${img.aeskey ? "image_item.aeskey" : "media.aes_key"} full_url=${Boolean(img.media.full_url)}`,
    );
    try {
      const buf = aesKeyBase64
        ? await downloadAndDecryptBuffer(
            img.media.encrypt_query_param ?? "",
            aesKeyBase64,
            cdnBaseUrl,
            `${label} image`,
            img.media.full_url,
          )
        : await downloadPlainCdnBuffer(
            img.media.encrypt_query_param ?? "",
            cdnBaseUrl,
            `${label} image-plain`,
            img.media.full_url,
          );
      const saved = await saveMedia(buf, undefined, "inbound", WEIXIN_MEDIA_MAX_BYTES);
      result.decryptedPicPath = saved.path;
      logger.debug(`${label} image saved: ${saved.path}`);
    } catch (err) {
      logger.error(`${label} image download/decrypt failed: ${String(err)}`);
      errLog(`weixin ${label} image download/decrypt failed: ${String(err)}`);
    }
  } else if (item.type === MessageItemType.VOICE) {
    const voice = item.voice_item;
    if ((!voice?.media?.encrypt_query_param && !voice?.media?.full_url) || !voice?.media?.aes_key)
      return result;
    try {
      const silkBuf = await downloadAndDecryptBuffer(
        voice.media.encrypt_query_param ?? "",
        voice.media.aes_key,
        cdnBaseUrl,
        `${label} voice`,
        voice.media.full_url,
      );
      const hex16 = silkBuf.subarray(0, 16).toString("hex");
      logger.info(
        `${label} inbound-voice encode_type=${voice.encode_type} sample_rate=${voice.sample_rate} playtime=${voice.playtime} bits=${voice.bits_per_sample} size=${voice.size} bytes=${silkBuf.length} hex16=${hex16} isSilk=${isSilkBuffer(silkBuf)}`,
      );
      if (process.env.WEIXIN_DUMP_INBOUND_VOICE === "1") {
      await fs.writeFile("/tmp/oc-last-inbound-voice.silk", silkBuf).catch(() => undefined);
      await fs.writeFile(
        "/tmp/oc-last-inbound-voice.json",
        JSON.stringify({
          encode_type: voice.encode_type,
          sample_rate: voice.sample_rate,
          playtime: voice.playtime,
          bits_per_sample: voice.bits_per_sample,
          size: voice.size,
          bytes: silkBuf.length,
          hex16,
          isSilk: isSilkBuffer(silkBuf),
          encrypt_type: voice.media?.encrypt_type,
          has_full_url: Boolean(voice.media?.full_url),
          has_query_param: Boolean(voice.media?.encrypt_query_param),
          aes_key_len: voice.media?.aes_key ? String(voice.media.aes_key).length : 0,
          aes_key: voice.media?.aes_key,
          encrypt_query_param: voice.media?.encrypt_query_param,
          full_url: voice.media?.full_url,
          media_keys: voice.media ? Object.keys(voice.media) : [],
          voice_keys: Object.keys(voice),
        }),
      ).catch(() => undefined);
      }
      logger.debug(`${label} voice: decrypted ${silkBuf.length} bytes, attempting silk transcode`);
      const wavBuf = await silkToWav(silkBuf);
      if (wavBuf) {
        const saved = await saveMedia(wavBuf, "audio/wav", "inbound", WEIXIN_MEDIA_MAX_BYTES);
        result.decryptedVoicePath = saved.path;
        result.voiceMediaType = "audio/wav";
        logger.debug(`${label} voice: saved WAV to ${saved.path}`);
      } else {
        const saved = await saveMedia(silkBuf, "audio/silk", "inbound", WEIXIN_MEDIA_MAX_BYTES);
        result.decryptedVoicePath = saved.path;
        result.voiceMediaType = "audio/silk";
        logger.debug(`${label} voice: silk transcode unavailable, saved raw SILK to ${saved.path}`);
      }
    } catch (err) {
      logger.error(`${label} voice download/transcode failed: ${String(err)}`);
      errLog(`weixin ${label} voice download/transcode failed: ${String(err)}`);
    }
  } else if (item.type === MessageItemType.FILE) {
    const fileItem = item.file_item;
    if ((!fileItem?.media?.encrypt_query_param && !fileItem?.media?.full_url) || !fileItem?.media?.aes_key)
      return result;
    try {
      const buf = await downloadAndDecryptBuffer(
        fileItem.media.encrypt_query_param ?? "",
        fileItem.media.aes_key,
        cdnBaseUrl,
        `${label} file`,
        fileItem.media.full_url,
      );
      const mime = getMimeFromFilename(fileItem.file_name ?? "file.bin");
      const saved = await saveMedia(
        buf,
        mime,
        "inbound",
        WEIXIN_MEDIA_MAX_BYTES,
        fileItem.file_name ?? undefined,
      );
      result.decryptedFilePath = saved.path;
      result.fileMediaType = mime;
      logger.debug(`${label} file: saved to ${saved.path} mime=${mime}`);
    } catch (err) {
      logger.error(`${label} file download failed: ${String(err)}`);
      errLog(`weixin ${label} file download failed: ${String(err)}`);
    }
  } else if (item.type === MessageItemType.VIDEO) {
    const videoItem = item.video_item;
    if ((!videoItem?.media?.encrypt_query_param && !videoItem?.media?.full_url) || !videoItem?.media?.aes_key)
      return result;
    try {
      const buf = await downloadAndDecryptBuffer(
        videoItem.media.encrypt_query_param ?? "",
        videoItem.media.aes_key,
        cdnBaseUrl,
        `${label} video`,
        videoItem.media.full_url,
      );
      const saved = await saveMedia(buf, "video/mp4", "inbound", WEIXIN_MEDIA_MAX_BYTES);
      result.decryptedVideoPath = saved.path;
      logger.debug(`${label} video: saved to ${saved.path}`);
    } catch (err) {
      logger.error(`${label} video download failed: ${String(err)}`);
      errLog(`weixin ${label} video download failed: ${String(err)}`);
    }
  }

  return result;
}
