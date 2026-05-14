import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfigRouteTag } from "../auth/accounts.js";
import { logger } from "../util/logger.js";
import { redactBody, redactUrl } from "../util/redact.js";

import type {
  BaseInfo,
  GetUploadUrlReq,
  GetUploadUrlResp,
  GetUpdatesReq,
  GetUpdatesResp,
  NotifyStopResp,
  NotifyStartResp,
  SendMessageReq,
  SendTypingReq,
  GetConfigResp,
} from "./types.js";

export type WeixinApiOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  /** Long-poll timeout for getUpdates (server may hold the request up to this). */
  longPollTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// BaseInfo — attached to every outgoing CGI request
// ---------------------------------------------------------------------------

interface PackageJson {
  name?: string;
  version?: string;
  ilink_appid?: string;
}

function readPackageJson(): PackageJson {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(dir, "..", "..", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as PackageJson;
  } catch {
    return {};
  }
}

const pkg = readPackageJson();

const CHANNEL_VERSION = pkg.version ?? "unknown";

/** iLink-App-Id: 直接读取 package.json 顶层 ilink_appid 字段。 */
const ILINK_APP_ID: string = pkg.ilink_appid ?? "";

/**
 * iLink-App-ClientVersion: uint32 encoded as 0x00MMNNPP
 * High 8 bits fixed to 0; remaining bits: major<<16 | minor<<8 | patch.
 * e.g. "1.0.11" -> 0x0001000B = 65547
 */
function buildClientVersion(version: string): number {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const ILINK_APP_CLIENT_VERSION: number = buildClientVersion(pkg.version ?? "0.0.0");

/** Build the `base_info` payload included in every API request. */
export function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

/** Default timeout for long-poll getUpdates requests. */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** Default timeout for regular API requests (sendMessage, getUploadUrl). */
const DEFAULT_API_TIMEOUT_MS = 15_000;
/** Default timeout for lightweight API requests (getConfig, sendTyping). */
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** X-WECHAT-UIN header: random uint32 -> decimal string -> base64. */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/** Build headers shared by both GET and POST requests. */
function buildCommonHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
  const routeTag = loadConfigRouteTag();
  if (routeTag) {
    headers.SKRouteTag = routeTag;
  }
  return headers;
}

function buildHeaders(opts: { token?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(opts.body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }
  logger.debug(
    `requestHeaders: ${JSON.stringify({ ...headers, Authorization: headers.Authorization ? "Bearer ***" : undefined })}`,
  );
  return headers;
}

/**
 * GET fetch wrapper: send a GET request to a Weixin API endpoint.
 * When `timeoutMs` is set, the request is aborted after that many milliseconds.
 * Query parameters should already be encoded in `endpoint`.
 * Returns the raw response text on success; throws on HTTP error or (if used) timeout abort.
 */
export async function apiGetFetch(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
  label: string;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildCommonHeaders();
  logger.debug(`GET ${redactUrl(url.toString())}`);

  const timeoutMs = params.timeoutMs;
  const controller =
    timeoutMs != null && timeoutMs > 0 ? new AbortController() : undefined;
  const t =
    controller != null && timeoutMs != null
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: hdrs,
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (t !== undefined) clearTimeout(t);
    const rawText = await res.text();
    logger.debug(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    if (t !== undefined) clearTimeout(t);
    throw err;
  }
}

/**
 * Common fetch wrapper: POST JSON to a Weixin API endpoint with timeout + abort.
 * Returns the raw response text on success; throws on HTTP error or timeout.
 */
async function apiPostFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  label: string;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildHeaders({ token: params.token, body: params.body });
  logger.debug(`POST ${redactUrl(url.toString())} body=${redactBody(params.body)}`);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: hdrs,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(t);
    const rawText = await res.text();
    logger.debug(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

/**
 * Long-poll getUpdates. Server should hold the request until new messages or timeout.
 *
 * On client-side timeout (no server response within timeoutMs), returns an empty response
 * with ret=0 so the caller can simply retry. This is normal for long-poll.
 */
export async function getUpdates(
  params: GetUpdatesReq & {
    baseUrl: string;
    token?: string;
    timeoutMs?: number;
  },
): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiPostFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
      label: "getUpdates",
    });
    const resp: GetUpdatesResp = JSON.parse(rawText);
    return resp;
  } catch (err) {
    // Long-poll timeout is normal; return empty response so caller can retry
    if (err instanceof Error && err.name === "AbortError") {
      logger.debug(`getUpdates: client-side timeout after ${timeout}ms, returning empty response`);
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    }
    throw err;
  }
}

/** Get a pre-signed CDN upload URL for a file. */
export async function getUploadUrl(
  params: GetUploadUrlReq & WeixinApiOptions,
): Promise<GetUploadUrlResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      thumb_rawsize: params.thumb_rawsize,
      thumb_rawfilemd5: params.thumb_rawfilemd5,
      thumb_filesize: params.thumb_filesize,
      no_need_thumb: params.no_need_thumb,
      aeskey: params.aeskey,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "getUploadUrl",
  });
  const resp: GetUploadUrlResp = JSON.parse(rawText);
  return resp;
}

/** Send a single message downstream. */
export async function sendMessage(
  params: WeixinApiOptions & { body: SendMessageReq },
): Promise<void> {
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
  });
}

/** Fetch bot config (includes typing_ticket) for a given user. */
export async function getConfig(
  params: WeixinApiOptions & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "getConfig",
  });
  const resp: GetConfigResp = JSON.parse(rawText);
  return resp;
}

/** Send a typing indicator to a user. */
export async function sendTyping(
  params: WeixinApiOptions & { body: SendTypingReq },
): Promise<void> {
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "sendTyping",
  });
}

/**
 * Notify Weixin that this channel client is stopping (gateway shutdown / channel stop).
 * Uses a standalone timeout (not the gateway abort signal) so the request can finish
 * after OpenClaw has already aborted the long-poll.
 */
export async function notifyStop(params: WeixinApiOptions): Promise<NotifyStopResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/msg/notifystop",
    body: JSON.stringify({ base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "notifyStop",
  });
  return JSON.parse(rawText) as NotifyStopResp;
}

/**
 * Notify Weixin that this channel client is starting (gateway startup / channel start).
 */
export async function notifyStart(params: WeixinApiOptions): Promise<NotifyStartResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/msg/notifystart",
    body: JSON.stringify({ base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "notifyStart",
  });
  return JSON.parse(rawText) as NotifyStartResp;
}
