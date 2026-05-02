import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getUploadUrl } from "../api/api.js";
import type { WeixinApiOptions } from "../api/api.js";
import { aesEcbPaddedSize } from "./aes-ecb.js";
import { uploadBufferToCdn } from "./cdn-upload.js";
import { logger } from "../util/logger.js";
import { getExtensionFromContentTypeOrUrl } from "../media/mime.js";
import { tempFileName } from "../util/random.js";
import { UploadMediaType } from "../api/types.js";

export type UploadedFileInfo = {
  filekey: string;
  /** 由 upload_param 上传后 CDN 返回的下载加密参数; fill into ImageItem.media.encrypt_query_param */
  downloadEncryptedQueryParam: string;
  /** AES-128-ECB key, hex-encoded; convert to base64 for CDNMedia.aes_key */
  aeskey: string;
  /** Plaintext file size in bytes */
  fileSize: number;
  /** Ciphertext file size in bytes (AES-128-ECB with PKCS7 padding); use for ImageItem.hd_size / mid_size */
  fileSizeCiphertext: number;
};

/** Maximum outbound remote media download size (50 MB). */
const MAX_REMOTE_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/** Allowed roots for local-file outbound media. */
export const ALLOWED_MEDIA_ROOTS = ["/tmp/", "/var/tmp/", "/dev/shm/"];

/**
 * Resolve a local media path safely, blocking directory traversal outside
 * allowed roots or process-relative paths.
 */
export function resolveSafeLocalPath(raw: string): string {
  let candidate: string;
  if (raw.startsWith("file://")) {
    const u = new URL(raw);
    if (u.hostname && u.hostname !== "localhost") {
      throw new Error(`local media path: remote file:// host not allowed (${u.hostname})`);
    }
    candidate = u.pathname;
  } else if (!path.isAbsolute(raw)) {
    candidate = path.resolve(process.cwd(), raw);
  } else {
    candidate = raw;
  }
  // Resolve symlinks and normalize
  try {
    candidate = path.resolve(candidate);
  } catch {
    throw new Error(`local media path: failed to resolve`);
  }
  // Require the resolved path to be under an allowed root or inside cwd
  const cwd = process.cwd();
  const allowed = ALLOWED_MEDIA_ROOTS.some((r) => candidate.startsWith(r)) ||
    candidate.startsWith(cwd + path.sep);
  if (!allowed) {
    throw new Error(`local media path: outside allowed directories`);
  }
  return candidate;
}

/** Block SSRF: private / loopback / link-local / metadata IP ranges. */
function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "0.0.0.0" || h === "[::]") return true;
  // AWS / GCP / Azure / Alibaba Cloud metadata endpoints
  if (h === "169.254.169.254" || h === "100.100.100.200") return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  // RFC 1918 + CGNAT + link-local
  if (h.startsWith("10.") || h.startsWith("192.168.")) return true;
  if (h.startsWith("172.")) { const b = parseInt(h.split(".")[1], 10); if (b >= 16 && b <= 31) return true; }
  if (h.startsWith("169.254.") || h.startsWith("100.") || h.startsWith("127.")) return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // ULAs
  return false;
}

/**
 * Download a remote media URL (image, video, file) to a local temp file in destDir.
 * Returns the local file path; extension is inferred from Content-Type / URL.
 *
 * Safety: blocks private/internal IPs (SSRF), enforces size limit, follows at most 1 redirect.
 */
export async function downloadRemoteImageToTemp(url: string, destDir: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`remote media download: invalid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`remote media download: unsupported protocol ${parsed.protocol}`);
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error(`remote media download: host not allowed`);
  }

  logger.debug(`downloadRemoteImageToTemp: fetching url=${url}`);
  const res = await fetch(url, { redirect: "error" });
  if (!res.ok) {
    const msg = `remote media download failed: ${res.status} ${res.statusText} url=${url}`;
    logger.error(`downloadRemoteImageToTemp: ${msg}`);
    throw new Error(msg);
  }
  const contentLen = res.headers.get("content-length");
  if (contentLen && parseInt(contentLen, 10) > MAX_REMOTE_DOWNLOAD_BYTES) {
    throw new Error(`remote media download: file too large (${contentLen} > ${MAX_REMOTE_DOWNLOAD_BYTES})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_REMOTE_DOWNLOAD_BYTES) {
    throw new Error(`remote media download: file too large (${buf.length} > ${MAX_REMOTE_DOWNLOAD_BYTES})`);
  }
  logger.debug(`downloadRemoteImageToTemp: downloaded ${buf.length} bytes`);
  await fs.mkdir(destDir, { recursive: true });
  const ext = getExtensionFromContentTypeOrUrl(res.headers.get("content-type"), url);
  const name = tempFileName("weixin-remote", ext);
  const filePath = path.join(destDir, name);
  await fs.writeFile(filePath, buf);
  logger.debug(`downloadRemoteImageToTemp: saved to ${filePath} ext=${ext}`);
  return filePath;
}

/**
 * Common upload pipeline: read file → hash → gen aeskey → getUploadUrl → uploadBufferToCdn → return info.
 */
async function uploadMediaToCdn(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
  mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
  label: string;
}): Promise<UploadedFileInfo> {
  const { filePath, toUserId, opts, cdnBaseUrl, mediaType, label } = params;

  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  logger.debug(
    `${label}: file=${filePath} rawsize=${rawsize} filesize=${filesize} md5=${rawfilemd5} filekey=${filekey}`,
  );

  const uploadUrlResp = await getUploadUrl({
    ...opts,
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });

  const uploadFullUrl = uploadUrlResp.upload_full_url?.trim();
  const uploadParam = uploadUrlResp.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    logger.error(
      `${label}: getUploadUrl returned no upload URL (need upload_full_url or upload_param), resp=${JSON.stringify(uploadUrlResp)}`,
    );
    throw new Error(`${label}: getUploadUrl returned no upload URL`);
  }

  const { downloadParam: downloadEncryptedQueryParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl: uploadFullUrl || undefined,
    uploadParam: uploadParam ?? undefined,
    filekey,
    cdnBaseUrl,
    aeskey,
    label: `${label}[orig filekey=${filekey}]`,
  });

  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

/** Upload a local image file to the Weixin CDN with AES-128-ECB encryption. */
export async function uploadFileToWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({
    ...params,
    mediaType: UploadMediaType.IMAGE,
    label: "uploadFileToWeixin",
  });
}

/** Upload a local video file to the Weixin CDN. */
export async function uploadVideoToWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({
    ...params,
    mediaType: UploadMediaType.VIDEO,
    label: "uploadVideoToWeixin",
  });
}

/**
 * Upload a local file attachment (non-image, non-video) to the Weixin CDN.
 * Uses media_type=FILE; no thumbnail required.
 */
export async function uploadFileAttachmentToWeixin(params: {
  filePath: string;
  fileName: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({
    ...params,
    mediaType: UploadMediaType.FILE,
    label: "uploadFileAttachmentToWeixin",
  });
}
