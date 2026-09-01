import { z } from "zod";

import { CDN_BASE_URL, DEFAULT_BASE_URL } from "../auth/accounts.js";

// ---------------------------------------------------------------------------
// Zod config schema
// ---------------------------------------------------------------------------

const weixinAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  cdnBaseUrl: z.string().default(CDN_BASE_URL),
  routeTag: z.number().optional(),
});

const quoteCacheSchema = z.object({
  enabled: z.boolean().default(true),
  retentionDays: z.number().positive().default(30),
  maxMessagesPerAccount: z.number().int().positive().default(10_000),
  mediaRetentionDays: z.number().positive().default(7),
  maxMediaBytesPerAccount: z.number().int().positive().default(256 * 1024 * 1024),
  maxSingleMediaBytes: z.number().int().positive().default(25 * 1024 * 1024),
});

/** Top-level weixin config schema (token is stored in credentials file, not config). */
export const WeixinConfigSchema = weixinAccountSchema.extend({
  accounts: z.record(z.string(), weixinAccountSchema).optional(),
  replyProgressMessages: z.boolean().default(true),
  quoteCache: quoteCacheSchema.default({
    enabled: true,
    retentionDays: 30,
    maxMessagesPerAccount: 10_000,
    mediaRetentionDays: 7,
    maxMediaBytesPerAccount: 256 * 1024 * 1024,
    maxSingleMediaBytes: 25 * 1024 * 1024,
  }),
  /** ISO 8601; bumped on each successful login to refresh gateway config from disk. */
  channelConfigUpdatedAt: z.string().optional(),
});
