import path from "node:path";

import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/core";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";

import {
  registerWeixinAccountId,
  loadWeixinAccount,
  saveWeixinAccount,
  listWeixinAccountIds,
  resolveWeixinAccount,
  triggerWeixinChannelReload,
  clearStaleAccountsForUserId,
  DEFAULT_BASE_URL,
} from "./auth/accounts.js";
import type { ResolvedWeixinAccount } from "./auth/accounts.js";
import { assertSessionActive } from "./api/session-guard.js";
import { getContextToken, findAccountIdsByContextToken, restoreContextTokens, clearContextTokensForAccount } from "./messaging/inbound.js";
import { logger } from "./util/logger.js";
import {
  DEFAULT_ILINK_BOT_TYPE,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
} from "./auth/login-qr.js";
import type { WeixinQrStartResult, WeixinQrWaitResult } from "./auth/login-qr.js";
// Lazy-imported inside startAccount to avoid pulling in the monitor -> process-message ->
// command-auth chain during plugin registration, which can re-enter plugin/provider registry
// resolution before the account actually starts.
import { sendWeixinMediaFile } from "./messaging/send-media.js";
import { sendMessageWeixin, StreamingMarkdownFilter } from "./messaging/send.js";
import { downloadRemoteImageToTemp } from "./cdn/upload.js";

/** Returns true when mediaUrl refers to a local filesystem path (absolute or relative). */
function isLocalFilePath(mediaUrl: string): boolean {
  // Treat anything without a URL scheme (no "://") as a local path.
  return !mediaUrl.includes("://");
}

function isRemoteUrl(mediaUrl: string): boolean {
  return mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://");
}

const MEDIA_OUTBOUND_TEMP_DIR = path.join(resolvePreferredOpenClawTmpDir(), "weixin/media/outbound-temp");

/** Resolve any local path scheme to an absolute filesystem path. */
function resolveLocalPath(mediaUrl: string): string {
  if (mediaUrl.startsWith("file://")) return new URL(mediaUrl).pathname;
  // Resolve any relative path (./foo, ../foo, .openclaw/foo, foo/bar) against cwd
  if (!path.isAbsolute(mediaUrl)) return path.resolve(mediaUrl);
  return mediaUrl;
}

/**
 * Resolve the effective accountId for an outbound message when the caller
 * did not provide one (e.g. cron delivery without explicit accountId).
 *
 * Priority:
 *   1. Multiple accounts → match via contextToken for the `to` recipient
 *   2. Single account → use it directly
 *   3. No match → throw a descriptive error
 */
function resolveOutboundAccountId(
  cfg: OpenClawConfig,
  to: string,
): string {
  const allIds = listWeixinAccountIds(cfg);

  if (allIds.length === 0) {
    throw new Error(
      `weixin: no accounts registered — run \`openclaw channels login --channel openclaw-weixin\``,
    );
  }

  if (allIds.length === 1) {
    logger.info(`resolveOutboundAccountId: single account, using ${allIds[0]}`);
    return allIds[0];
  }

  // Multiple accounts: find which ones have a contextToken for the recipient.
  const matched = findAccountIdsByContextToken(allIds, to);

  if (matched.length === 1) {
    logger.info(`resolveOutboundAccountId: matched accountId=${matched[0]} for to=${to}`);
    return matched[0];
  }

  if (matched.length > 1) {
    logger.warn(
      `resolveOutboundAccountId: ambiguous — ${matched.length} accounts matched for to=${to}: ${matched.join(", ")}`,
    );
    throw new Error(
      `weixin: ambiguous account for to=${to} ` +
      `(${matched.length} accounts have active sessions with this recipient: ${matched.join(", ")}). ` +
      `Specify accountId in the delivery config to disambiguate.`,
    );
  }

  throw new Error(
    `weixin: cannot determine which account to use for to=${to} ` +
    `(${allIds.length} accounts registered, none has an active session with this recipient). ` +
    `Specify accountId in the delivery config, or ensure the recipient has recently messaged the bot.`,
  );
}

async function sendWeixinOutbound(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  accountId?: string | null;
  contextToken?: string;
  mediaUrl?: string;
}): Promise<{ channel: string; messageId: string }> {
  const account = resolveWeixinAccount(params.cfg, params.accountId);
  const aLog = logger.withAccount(account.accountId);
  assertSessionActive(account.accountId);
  if (!account.configured) {
    aLog.error(`sendWeixinOutbound: account not configured`);
    throw new Error("weixin not configured: please run `openclaw channels login --channel openclaw-weixin`");
  }
  if (!params.contextToken) {
    aLog.warn(`sendWeixinOutbound: contextToken missing for to=${params.to}, sending without context`);
  }
  const f = new StreamingMarkdownFilter();
  const rawText = params.text ?? "";
  const filteredText = f.feed(rawText) + f.flush();
  const result = await sendMessageWeixin({ to: params.to, text: filteredText, opts: {
    baseUrl: account.baseUrl,
    token: account.token,
    contextToken: params.contextToken,
  }});
  return { channel: "openclaw-weixin", messageId: result.messageId };
}

export const weixinPlugin: ChannelPlugin<ResolvedWeixinAccount> = {
  id: "openclaw-weixin",
  meta: {
    id: "openclaw-weixin",
    label: "openclaw-weixin",
    selectionLabel: "openclaw-weixin (long-poll)",
    docsPath: "/channels/openclaw-weixin",
    docsLabel: "openclaw-weixin",
    blurb: "getUpdates long-poll upstream, sendMessage downstream; token auth.",
    order: 75,
  },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    media: true,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: {
      minChars: 200,
      idleMs: 3000,
    },
  },
  messaging: {
    targetResolver: {
      // Weixin user IDs always end with @im.wechat; treat as direct IDs, skip directory lookup.
      looksLikeId: (raw) => raw.endsWith("@im.wechat"),
    },
  },
  agentPrompt: {
    messageToolHints: () => [
      "To send an image or file to the current user, use the message tool with action='send' and set 'media' to a local file path or a remote URL. You do not need to specify 'to' — the current conversation recipient is used automatically.",
      "When the user asks you to find an image from the web, use a web search or browser tool to find a suitable image URL, then send it using the message tool with 'media' set to that HTTPS image URL — do NOT download the image first.",
      "IMPORTANT: When generating or saving a file to send, always use an absolute path (e.g. /tmp/photo.png), never a relative path like ./photo.png. Relative paths cannot be resolved and the file will not be delivered.",
      "IMPORTANT: When creating a cron job (scheduled task) for the current Weixin user, you MUST set delivery.to to the user's Weixin ID (the xxx@im.wechat address from the current conversation) AND set delivery.accountId to the current AccountId. Without an explicit 'to', the cron delivery will fail with 'requires target'. Without an explicit 'accountId', the message may be sent from the wrong bot account. Example: delivery: { mode: 'announce', channel: 'openclaw-weixin', to: '<current_user_id@im.wechat>', accountId: '<current_AccountId>' }.",
      "IMPORTANT: When outputting a MEDIA: directive to send a file, the MEDIA: tag MUST be on its own line — never inline with other text. Correct:\nSome text here\nMEDIA:/path/to/file.mp4\nIncorrect: Some text here MEDIA:/path/to/file.mp4",
    ],
  },
  reload: { configPrefixes: ["channels.openclaw-weixin"] },
  config: {
    listAccountIds: (cfg) => listWeixinAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveWeixinAccount(cfg, accountId),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async (ctx) => {
      const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
      const result = await sendWeixinOutbound({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        accountId,
        contextToken: getContextToken(accountId!, ctx.to),
      });
      return result;
    },
    sendMedia: async (ctx) => {
      const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
      const account = resolveWeixinAccount(ctx.cfg, accountId);
      const aLog = logger.withAccount(account.accountId);
      assertSessionActive(account.accountId);
      if (!account.configured) {
        aLog.error(`sendMedia: account not configured`);
        throw new Error(
          "weixin not configured: please run `openclaw channels login --channel openclaw-weixin`",
        );
      }

      const mediaUrl = ctx.mediaUrl;

      if (mediaUrl && (isLocalFilePath(mediaUrl) || isRemoteUrl(mediaUrl))) {
        let filePath: string;
        if (isLocalFilePath(mediaUrl)) {
          filePath = resolveLocalPath(mediaUrl);
          aLog.debug(`sendMedia: uploading local file ${filePath}`);
        } else {
          aLog.debug(`sendMedia: downloading remote mediaUrl=${mediaUrl.slice(0, 80)}...`);
          filePath = await downloadRemoteImageToTemp(mediaUrl, MEDIA_OUTBOUND_TEMP_DIR);
          aLog.debug(`sendMedia: remote image downloaded to ${filePath}`);
        }
        const contextToken = getContextToken(account.accountId, ctx.to);
        const result = await sendWeixinMediaFile({
          filePath,
          to: ctx.to,
          text: ctx.text ?? "",
          opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
          cdnBaseUrl: account.cdnBaseUrl,
        });
        return { channel: "openclaw-weixin", messageId: result.messageId };
      }

      const result = await sendWeixinOutbound({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text ?? "",
        accountId,
        contextToken: getContextToken(account.accountId, ctx.to),
      });
      return result;
    },
  },
  status: {
    defaultRuntime: {
      accountId: "",
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    collectStatusIssues: () => [],
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      lastError: snapshot.lastError ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      ...runtime,
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  auth: {
    login: async ({ cfg, accountId, verbose, runtime }) => {
      const account = resolveWeixinAccount(cfg, accountId);

      const log = (msg: string) => {
        runtime?.log?.(msg);
      };

      log(`正在启动微信扫码登录...`);
      const startResult: WeixinQrStartResult = await startWeixinLoginWithQr({
        accountId: account.accountId,
        apiBaseUrl: account.baseUrl,
        botType: DEFAULT_ILINK_BOT_TYPE,
        verbose: Boolean(verbose),
      });

      if (!startResult.qrcodeUrl) {
        logger.warn(
          `auth.login: failed to get QR code accountId=${account.accountId} message=${startResult.message}`,
        );
        log(startResult.message);
        throw new Error(startResult.message);
      }

      log(`\n使用微信扫描以下二维码，以完成连接：\n`);
      try {
        const qrcodeterminal = await import("qrcode-terminal");
        await new Promise<void>((resolve) => {
          qrcodeterminal.default.generate(startResult.qrcodeUrl!, { small: true }, (qr: string) => {
            console.log(qr);
            log(`如果二维码未能成功展示，请用浏览器打开以下链接扫码：`);
            log(startResult.qrcodeUrl!);
            resolve();
          });
        });
      } catch (err) {
        logger.warn(
          `auth.login: qrcode-terminal unavailable, falling back to URL err=${String(err)}`,
        );
        log(`二维码未加载成功，请用浏览器打开以下链接扫码：`);
        log(startResult.qrcodeUrl!);
      }

      const loginTimeoutMs = 480_000;
      log(`\n等待连接结果...\n`);

      const waitResult: WeixinQrWaitResult = await waitForWeixinLogin({
        sessionKey: startResult.sessionKey,
        apiBaseUrl: account.baseUrl,
        timeoutMs: loginTimeoutMs,
        verbose: Boolean(verbose),
        botType: DEFAULT_ILINK_BOT_TYPE,
      });

      if (waitResult.connected && waitResult.botToken && waitResult.accountId) {
        try {
          // Normalize the raw ilink_bot_id (e.g. "hex@im.bot") to a filesystem-safe
          // key (e.g. "hex-im-bot") so account files have no special chars.
          const normalizedId = normalizeAccountId(waitResult.accountId);
          saveWeixinAccount(normalizedId, {
            token: waitResult.botToken,
            baseUrl: waitResult.baseUrl,
            userId: waitResult.userId,
          });
          registerWeixinAccountId(normalizedId);
          if (waitResult.userId) {
            clearStaleAccountsForUserId(normalizedId, waitResult.userId, clearContextTokensForAccount);
          }
          void triggerWeixinChannelReload();
          log(`\n✅ 与微信连接成功！`);
        } catch (err) {
          logger.error(
            `auth.login: failed to save account data accountId=${waitResult.accountId} err=${String(err)}`,
          );
          log(`⚠️  保存账号数据失败: ${String(err)}`);
        }
      } else {
        logger.warn(
          `auth.login: login did not complete accountId=${account.accountId} message=${waitResult.message}`,
        );
        // log(waitResult.message);
        throw new Error(waitResult.message);
      }
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      logger.debug(`startAccount entry`);
      if (!ctx) {
        logger.warn(`gateway.startAccount: called with undefined ctx, skipping`);
        return;
      }
      const account = ctx.account;
      const aLog = logger.withAccount(account.accountId);
      aLog.debug(`about to call monitorWeixinProvider`);
      restoreContextTokens(account.accountId);
      aLog.info(`starting weixin webhook`);

      ctx.setStatus?.({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        lastEventAt: Date.now(),
      });

      if (!account.configured) {
        aLog.error(`account not configured`);
        ctx.log?.error?.(
          `[${account.accountId}] weixin not logged in — run: openclaw channels login --channel openclaw-weixin`,
        );
        ctx.setStatus?.({ accountId: account.accountId, running: false });
        throw new Error("weixin not configured: missing token");
      }

      ctx.log?.info?.(`[${account.accountId}] starting weixin provider (${DEFAULT_BASE_URL})`);

      const logPath = aLog.getLogFilePath();
      ctx.log?.info?.(`[${account.accountId}] weixin logs: ${logPath}`);

      const { monitorWeixinProvider } = await import("./monitor/monitor.js");
      return monitorWeixinProvider({
        baseUrl: account.baseUrl,
        cdnBaseUrl: account.cdnBaseUrl,
        token: account.token,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        setStatus: ctx.setStatus,
      });
    },
    loginWithQrStart: async ({ accountId, force, timeoutMs, verbose }) => {
      // For re-login: use saved baseUrl from account data; fall back to default for new accounts.
      const savedBaseUrl = accountId ? loadWeixinAccount(accountId)?.baseUrl?.trim() : "";
      const result: WeixinQrStartResult = await startWeixinLoginWithQr({
        accountId: accountId ?? undefined,
        apiBaseUrl: savedBaseUrl || DEFAULT_BASE_URL,
        botType: DEFAULT_ILINK_BOT_TYPE,
        force,
        timeoutMs,
        verbose,
      });
      // Return sessionKey so the client can pass it back in loginWithQrWait.
      return {
        qrDataUrl: result.qrcodeUrl,
        message: result.message,
        sessionKey: result.sessionKey,
      } as { qrDataUrl?: string; message: string };
    },
    loginWithQrWait: async (params) => {
      // sessionKey is forwarded by the client after loginWithQrStart (runtime param extension).
      const sessionKey = (params as { sessionKey?: string }).sessionKey || params.accountId || "";
      const savedBaseUrl = params.accountId
        ? loadWeixinAccount(params.accountId)?.baseUrl?.trim()
        : "";
      const result: WeixinQrWaitResult = await waitForWeixinLogin({
        sessionKey,
        apiBaseUrl: savedBaseUrl || DEFAULT_BASE_URL,
        timeoutMs: params.timeoutMs,
      });

      if (result.connected && result.botToken && result.accountId) {
        try {
          const normalizedId = normalizeAccountId(result.accountId);
          saveWeixinAccount(normalizedId, {
            token: result.botToken,
            baseUrl: result.baseUrl,
            userId: result.userId,
          });
          registerWeixinAccountId(normalizedId);
          if (result.userId) {
            clearStaleAccountsForUserId(normalizedId, result.userId, clearContextTokensForAccount);
          }
          triggerWeixinChannelReload();
          logger.info(`loginWithQrWait: saved account data for accountId=${normalizedId}`);
        } catch (err) {
          logger.error(`loginWithQrWait: failed to save account data err=${String(err)}`);
        }
      }

      return {
        connected: result.connected,
        message: result.message,
        accountId: result.accountId,
      } as { connected: boolean; message: string };
    },
  },
};
