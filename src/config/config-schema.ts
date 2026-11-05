import path from "node:path";
import { z } from "zod";

import { CDN_BASE_URL, DEFAULT_BASE_URL } from "../auth/accounts.js";
import {
  DEFAULT_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS,
  MAX_DOWNLOAD_TIMEOUT_MS,
} from "./media-download.js";

// ---------------------------------------------------------------------------
// Zod config schema
// ---------------------------------------------------------------------------

const weixinAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  cdnBaseUrl: z.string().default(CDN_BASE_URL),
  routeTag: z.number().optional(),
  /**
   * Origin of `botrealnameverifycgi`. Include the port when it is not 443,
   * for example `http://10.x.x.x:8088`. The CGI path stays fixed.
   */
  acctwebBaseUrl: z.string().optional(),
  /**
   * HTTP proxy for `botrealnameverifycgi` only. The request target stays
   * `acctwebBaseUrl` or `https://weixin110.qq.com`. Example: `http://10.x.x.x:8088`.
   */
  acctwebProxy: z.string().optional(),
});

const quoteCacheSchema = z.object({
  enabled: z.boolean().default(true),
  mediaStorage: z
    .discriminatedUnion("mode", [
      z.object({ mode: z.literal("inbound") }),
      z.object({ mode: z.literal("managed") }),
      z.object({
        mode: z.literal("custom"),
        directory: z.string().min(1).refine(path.isAbsolute, "must be an absolute path"),
      }),
    ])
    .default({ mode: "managed" }),
  retentionDays: z.number().positive().default(30),
  maxMessagesPerAccount: z.number().int().positive().default(10_000),
  mediaRetentionDays: z.number().positive().default(7),
  maxMediaBytesPerAccount: z
    .number()
    .int()
    .positive()
    .default(256 * 1024 * 1024),
  maxSingleMediaBytes: z
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
});

/** Top-level weixin config schema (token is stored in credentials file, not config). */
export const WeixinConfigSchema = weixinAccountSchema.extend({
  accounts: z.record(z.string(), weixinAccountSchema).optional(),
  replyProgressMessages: z.boolean().default(true),
  /** Send and recover user-visible failure notices only when explicitly enabled. */
  errorNotices: z.boolean().default(false),
  mediaDownload: z
    .object({
      /** Zero disables the total download deadline. */
      timeoutMs: z.number().int().min(0).max(MAX_DOWNLOAD_TIMEOUT_MS).default(0),
      /** Maximum time without response headers or a non-empty body chunk. */
      idleTimeoutMs: z
        .number()
        .int()
        .positive()
        .max(MAX_DOWNLOAD_TIMEOUT_MS)
        .default(DEFAULT_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS),
    })
    .default({ timeoutMs: 0, idleTimeoutMs: DEFAULT_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS }),
  /**
   * Ask whether this OpenClaw connects to the operator's own WeChat ClawBot.
   * Y shows the bot bind QR directly. N completes real-name authorization first.
   * Default false: show the bot bind QR with no prompt and no bot_spam_ticket.
   */
  promptBindOwner: z.boolean().default(false),
  /**
   * When true, get_bot_qrcode sends bot_spam_business_data so security requires the phone PIN.
   * Default false: omit the field and leave the PIN decision to security.
   */
  verifyPin: z.boolean().default(false),
  quoteCache: quoteCacheSchema.default({
    enabled: true,
    mediaStorage: { mode: "managed" },
    retentionDays: 30,
    maxMessagesPerAccount: 10_000,
    mediaRetentionDays: 7,
    maxMediaBytesPerAccount: 256 * 1024 * 1024,
    maxSingleMediaBytes: 25 * 1024 * 1024,
  }),
  /** ISO 8601; bumped on each successful login to refresh gateway config from disk. */
  channelConfigUpdatedAt: z.string().optional(),
});
