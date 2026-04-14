import { randomUUID } from "node:crypto";

import { apiGetFetch } from "../api/api.js";
import { logger } from "../util/logger.js";
import { redactToken } from "../util/redact.js";

type ActiveLogin = {
  sessionKey: string;
  id: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  botToken?: string;
  status?: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect";
  error?: string;
  /** The current effective polling base URL; may be updated on IDC redirect. */
  currentApiBaseUrl?: string;
};

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
/** Client-side timeout for the long-poll get_qrcode_status request. */
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

/** Default `bot_type` for ilink get_bot_qrcode / get_qrcode_status (this channel build). */
export const DEFAULT_ILINK_BOT_TYPE = "3";

/** Fixed API base URL for all QR code requests. */
const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";

const activeLogins = new Map<string, ActiveLogin>();

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  /** The user ID of the person who scanned the QR code. */
  ilink_user_id?: string;
  /** New host to redirect polling to when status is scaned_but_redirect. */
  redirect_host?: string;
}

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

/** Remove all expired entries from the activeLogins map to prevent memory leaks. */
function purgeExpiredLogins(): void {
  for (const [id, login] of activeLogins) {
    if (!isLoginFresh(login)) {
      activeLogins.delete(id);
    }
  }
}

async function fetchQRCode(apiBaseUrl: string, botType: string): Promise<QRCodeResponse> {
  logger.info(`Fetching QR code from: ${apiBaseUrl} bot_type=${botType}`);
  const rawText = await apiGetFetch({
    baseUrl: apiBaseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    label: "fetchQRCode",
  });
  return JSON.parse(rawText) as QRCodeResponse;
}

async function pollQRStatus(apiBaseUrl: string, qrcode: string): Promise<StatusResponse> {
  logger.debug(`Long-poll QR status from: ${apiBaseUrl} qrcode=***`);
  try {
    const rawText = await apiGetFetch({
      baseUrl: apiBaseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: "pollQRStatus",
    });
    logger.debug(`pollQRStatus: body=${rawText.substring(0, 200)}`);
    return JSON.parse(rawText) as StatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.debug(`pollQRStatus: client-side timeout after ${QR_LONG_POLL_TIMEOUT_MS}ms, returning wait`);
      return { status: "wait" };
    }
    // 网关超时（如 Cloudflare 524）或其他网络错误，视为等待状态继续轮询
    logger.warn(`pollQRStatus: network/gateway error, will retry: ${String(err)}`);
    return { status: "wait" };
  }
}

export type WeixinQrStartResult = {
  qrcodeUrl?: string;
  message: string;
  sessionKey: string;
};

export type WeixinQrWaitResult = {
  connected: boolean;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  /** The user ID of the person who scanned the QR code; add to allowFrom. */
  userId?: string;
  message: string;
};

export async function startWeixinLoginWithQr(opts: {
  verbose?: boolean;
  timeoutMs?: number;
  force?: boolean;
  accountId?: string;
  apiBaseUrl: string;
  botType?: string;
}): Promise<WeixinQrStartResult> {
  const sessionKey = opts.accountId || randomUUID();

  purgeExpiredLogins();

  const existing = activeLogins.get(sessionKey);
  if (!opts.force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
    return {
      qrcodeUrl: existing.qrcodeUrl,
      message: "二维码已就绪，请使用微信扫描。",
      sessionKey,
    };
  }

  try {
    const botType = opts.botType || DEFAULT_ILINK_BOT_TYPE;
    logger.info(`Starting Weixin login with bot_type=${botType}`);

    const qrResponse = await fetchQRCode(FIXED_BASE_URL, botType);
    logger.info(
      `QR code received, qrcode=${redactToken(qrResponse.qrcode)} imgContentLen=${qrResponse.qrcode_img_content?.length ?? 0}`,
    );
    logger.info(`二维码链接: ${qrResponse.qrcode_img_content}`);

    const login: ActiveLogin = {
      sessionKey,
      id: randomUUID(),
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      startedAt: Date.now(),
    };

    activeLogins.set(sessionKey, login);

    return {
      qrcodeUrl: qrResponse.qrcode_img_content,
      message: "使用微信扫描以下二维码，以完成连接。",
      sessionKey,
    };
  } catch (err) {
    logger.error(`Failed to start Weixin login: ${String(err)}`);
    return {
      message: `Failed to start login: ${String(err)}`,
      sessionKey,
    };
  }
}

const MAX_QR_REFRESH_COUNT = 3;

export async function waitForWeixinLogin(opts: {
  timeoutMs?: number;
  verbose?: boolean;
  sessionKey: string;
  apiBaseUrl: string;
  botType?: string;
}): Promise<WeixinQrWaitResult> {
  let activeLogin = activeLogins.get(opts.sessionKey);

  if (!activeLogin) {
    logger.warn(`waitForWeixinLogin: no active login sessionKey=${opts.sessionKey}`);
    return {
      connected: false,
      message: "当前没有进行中的登录，请先发起登录。",
    };
  }

  if (!isLoginFresh(activeLogin)) {
    logger.warn(`waitForWeixinLogin: login QR expired sessionKey=${opts.sessionKey}`);
    activeLogins.delete(opts.sessionKey);
    return {
      connected: false,
      message: "二维码已过期，请重新生成。",
    };
  }

  const timeoutMs = Math.max(opts.timeoutMs ?? 480_000, 1000);
  const deadline = Date.now() + timeoutMs;
  let scannedPrinted = false;
  let qrRefreshCount = 1;

  // Initialize the effective polling base URL; may be updated on IDC redirect.
  activeLogin.currentApiBaseUrl = FIXED_BASE_URL;

  logger.info("Starting to poll QR code status...");

  while (Date.now() < deadline) {
    try {
      const currentBaseUrl = activeLogin.currentApiBaseUrl ?? FIXED_BASE_URL;
      const statusResponse = await pollQRStatus(currentBaseUrl, activeLogin.qrcode);
      logger.debug(`pollQRStatus: status=${statusResponse.status} hasBotToken=${Boolean(statusResponse.bot_token)} hasBotId=${Boolean(statusResponse.ilink_bot_id)}`);
      activeLogin.status = statusResponse.status;

      switch (statusResponse.status) {
        case "wait":
          if (opts.verbose) {
            process.stdout.write(".");
          }
          break;
        case "scaned":
          if (!scannedPrinted) {
            process.stdout.write("\n👀 已扫码，在微信继续操作...\n");
            scannedPrinted = true;
          }
          break;
        case "expired": {
          qrRefreshCount++;
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            logger.warn(
              `waitForWeixinLogin: QR expired ${MAX_QR_REFRESH_COUNT} times, giving up sessionKey=${opts.sessionKey}`,
            );
            activeLogins.delete(opts.sessionKey);
            return {
              connected: false,
              message: "登录超时：二维码多次过期，请重新开始登录流程。",
            };
          }

          process.stdout.write(`\n⏳ 二维码已过期，正在刷新...(${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
          logger.info(
            `waitForWeixinLogin: QR expired, refreshing (${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})`,
          );

          try {
            const botType = opts.botType || DEFAULT_ILINK_BOT_TYPE;
            const qrResponse = await fetchQRCode(FIXED_BASE_URL, botType);
            activeLogin.qrcode = qrResponse.qrcode;
            activeLogin.qrcodeUrl = qrResponse.qrcode_img_content;
            activeLogin.startedAt = Date.now();
            scannedPrinted = false;
            logger.info(`waitForWeixinLogin: new QR code obtained qrcode=${redactToken(qrResponse.qrcode)}`);
            process.stdout.write(`🔄 新二维码已生成，请重新扫描\n\n`);
            try {
              const qrterm = await import("qrcode-terminal");
              qrterm.default.generate(qrResponse.qrcode_img_content, { small: true });
              process.stdout.write(`如果二维码未能成功展示，请用浏览器打开以下链接扫码：\n`);
              process.stdout.write(`${qrResponse.qrcode_img_content}\n`);
            } catch {
              process.stdout.write(`二维码未加载成功，请用浏览器打开以下链接扫码：\n`);
              process.stdout.write(`${qrResponse.qrcode_img_content}\n`);
            }          
          } catch (refreshErr) {
            logger.error(`waitForWeixinLogin: failed to refresh QR code: ${String(refreshErr)}`);
            activeLogins.delete(opts.sessionKey);
            return {
              connected: false,
              message: `刷新二维码失败: ${String(refreshErr)}`,
            };
          }
          break;
        }
        case "scaned_but_redirect": {
          const redirectHost = statusResponse.redirect_host;
          if (redirectHost) {
            const newBaseUrl = `https://${redirectHost}`;
            activeLogin.currentApiBaseUrl = newBaseUrl;
            logger.info(`waitForWeixinLogin: IDC redirect, switching polling host to ${redirectHost}`);
          } else {
            logger.warn(`waitForWeixinLogin: received scaned_but_redirect but redirect_host is missing, continuing with current host`);
          }
          break;
        }
        case "confirmed": {
          if (!statusResponse.ilink_bot_id) {
            activeLogins.delete(opts.sessionKey);
            logger.error("Login confirmed but ilink_bot_id missing from response");
            return {
              connected: false,
              message: "登录失败：服务器未返回 ilink_bot_id。",
            };
          }

          activeLogin.botToken = statusResponse.bot_token;
          activeLogins.delete(opts.sessionKey);

          logger.info(
            `✅ Login confirmed! ilink_bot_id=${statusResponse.ilink_bot_id} ilink_user_id=${redactToken(statusResponse.ilink_user_id)}`,
          );

          return {
            connected: true,
            botToken: statusResponse.bot_token,
            accountId: statusResponse.ilink_bot_id,
            baseUrl: statusResponse.baseurl,
            userId: statusResponse.ilink_user_id,
            message: "✅ 与微信连接成功！",
          };
        }
      }

    } catch (err) {
      logger.error(`Error polling QR status: ${String(err)}`);
      activeLogins.delete(opts.sessionKey);
      return {
        connected: false,
        message: `Login failed: ${String(err)}`,
      };
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  logger.warn(
    `waitForWeixinLogin: timed out waiting for QR scan sessionKey=${opts.sessionKey} timeoutMs=${timeoutMs}`,
  );
  activeLogins.delete(opts.sessionKey);
  return {
    connected: false,
    message: "登录超时，请重试。",
  };
}
