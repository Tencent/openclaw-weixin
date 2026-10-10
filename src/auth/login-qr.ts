import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";

import { apiGetFetch, apiPostFetch } from "../api/api.js";
import { listIndexedWeixinAccountIds, loadWeixinAccount } from "./accounts.js";
import { logger } from "../util/logger.js";
import { redactToken } from "../util/redact.js";

type ActiveLogin = {
  sessionKey: string;
  accountId?: string;
  id: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  botToken?: string;
  status?:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "scaned_but_redirect"
    | "need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
  error?: string;
  /** The current effective polling base URL; may be updated on IDC redirect. */
  currentApiBaseUrl?: string;
  /** 待提交的配对码，用户输入后暂存，下次轮询时携带 */
  pendingVerifyCode?: string;
  browser?: boolean;
  qrDataUrl?: string;
  verificationRequired?: boolean;
  polling?: boolean;
  qrRefreshCount?: number;
  /** Account IDs whose tokens were offered for this exact QR generation; never retain tokens. */
  offeredAccountIds?: string[];
  abortController: AbortController;
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
  status:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "scaned_but_redirect"
    | "need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
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
  for (const login of activeLogins.values()) {
    if (!isLoginFresh(login)) {
      removeLogin(login);
    }
  }
}

/** 获取本地已登录账号的 bot token 列表，最多返回最新的 10 个。 */
function getLocalBotAccounts(): { tokens: string[]; accountIds: string[] } {
  const accountIds = listIndexedWeixinAccountIds();
  const tokens: string[] = [];
  const offeredAccountIds: string[] = [];
  // 从最新注册的账号开始取（列表末尾为最新）
  for (let i = accountIds.length - 1; i >= 0 && tokens.length < 10; i--) {
    const data = loadWeixinAccount(accountIds[i]);
    const token = data?.token?.trim();
    if (token) {
      tokens.push(token);
      offeredAccountIds.push(accountIds[i]);
    }
  }
  return { tokens, accountIds: offeredAccountIds };
}

async function fetchQRCode(
  apiBaseUrl: string,
  botType: string,
  abortSignal?: AbortSignal,
  browser = false,
): Promise<QRCodeResponse & { offeredAccountIds: string[] }> {
  logger.info(`NewFetching QR code from: ${apiBaseUrl} bot_type=${botType}`);
  const localAccounts = getLocalBotAccounts();
  const localTokenList = localAccounts.tokens;
  logger.info(`newfetchQRCode: local_token_list count=${localTokenList.length}`);
  const rawText = await apiPostFetch({
    baseUrl: apiBaseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: JSON.stringify({ local_token_list: localTokenList }),
    label: "fetchQRCode",
    abortSignal,
    ...(browser ? { timeoutMs: 30_000 } : {}),
  });
  return {
    ...(JSON.parse(rawText) as QRCodeResponse),
    offeredAccountIds: localAccounts.accountIds,
  };
}

/** 从 stdin 读取一行用户输入，输出提示语后等待回车确认，返回 trim 后的字符串。 */
async function readVerifyCodeFromStdin(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let input = "";
    const onData = (chunk: Buffer | string) => {
      const str = chunk.toString();
      input += str;
      if (input.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(input.trim());
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", onData);
  });
}

async function pollQRStatus(
  apiBaseUrl: string,
  qrcode: string,
  verifyCode?: string,
  options?: { timeoutMs: number; abortSignal: AbortSignal },
): Promise<StatusResponse> {
  logger.debug(`Long-poll QR status from: ${apiBaseUrl} qrcode=***`);
  try {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) {
      endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    }
    const rawText = await apiGetFetch({
      baseUrl: apiBaseUrl,
      endpoint,
      timeoutMs: options?.timeoutMs ?? QR_LONG_POLL_TIMEOUT_MS,
      abortSignal: options?.abortSignal,
      label: "pollQRStatus",
    });
    return JSON.parse(rawText) as StatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.debug(
        `pollQRStatus: client-side timeout after ${QR_LONG_POLL_TIMEOUT_MS}ms, returning wait`,
      );
      return { status: "wait" };
    }
    // 网关超时（如 Cloudflare 524）或其他网络错误，视为等待状态继续轮询
    logger.warn("pollQRStatus: network/gateway error, will retry");
    return { status: "wait" };
  }
}

/**
 * 在终端展示二维码及备用链接。
 * 供 CLI 登录流程和 MCP Tool 登录流程共同复用。
 */
export async function displayQRCode(qrcodeUrl: string): Promise<void> {
  try {
    const qrterm = await import("qrcode-terminal");
    qrterm.default.generate(qrcodeUrl, { small: true });
    process.stdout.write(`若二维码未能显示或无法使用，你可以访问以下链接以继续：\n`);
    process.stdout.write(`${qrcodeUrl}\n`);
  } catch {
    process.stdout.write(`若二维码未能显示或无法使用，你可以访问以下链接以继续：\n`);
    process.stdout.write(`${qrcodeUrl}\n`);
  }
}

export type WeixinQrStartResult = {
  qrcodeUrl?: string;
  message: string;
  sessionKey: string;
  qrDataUrl?: string;
  expiresAtMs?: number;
  cancelled?: boolean;
};

export type WeixinQrWaitResult = {
  connected: boolean;
  /**
   * Server reported `binded_redirect`: the scanned bot is already bound to
   * this OpenClaw instance, so no new credentials are issued and existing
   * local credentials remain valid. Callers should treat this as a successful
   * outcome (semantically "already done") rather than a login failure.
   */
  alreadyConnected?: boolean;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  /** The user ID of the person who scanned the QR code; add to allowFrom. */
  userId?: string;
  message: string;
  qrDataUrl?: string;
  sessionKey?: string;
  expiresAtMs?: number;
  verificationRequired?: boolean;
  cancelled?: boolean;
};

export async function startWeixinLoginWithQr(opts: {
  verbose?: boolean;
  force?: boolean;
  accountId?: string;
  apiBaseUrl: string;
  botType?: string;
  browser?: boolean;
  assertCurrent?: () => void;
  requestSignal?: AbortSignal;
}): Promise<WeixinQrStartResult> {
  opts.assertCurrent?.();
  const sessionKey = opts.browser ? randomUUID() : opts.accountId || randomUUID();

  purgeExpiredLogins();

  const existing =
    opts.browser && opts.accountId
      ? [...activeLogins.values()].find(
          (login) => login.browser && login.accountId === opts.accountId,
        )
      : activeLogins.get(sessionKey);
  if (
    !opts.force &&
    existing &&
    existing.browser === opts.browser &&
    isLoginFresh(existing) &&
    existing.qrcodeUrl
  ) {
    return {
      qrcodeUrl: existing.qrcodeUrl,
      message: "二维码已显示，请用手机微信扫描。",
      sessionKey: existing.sessionKey,
      qrDataUrl: existing.qrDataUrl,
      expiresAtMs: existing.startedAt + ACTIVE_LOGIN_TTL_MS,
    };
  }

  // Reserve the identity before awaiting the network; replacement fences old responses.
  if (existing) removeLogin(existing);
  const login: ActiveLogin = {
    sessionKey,
    accountId: opts.accountId,
    id: randomUUID(),
    qrcode: "",
    qrcodeUrl: "",
    startedAt: Date.now(),
    browser: opts.browser,
    abortController: new AbortController(),
    qrRefreshCount: 1,
  };
  activeLogins.set(sessionKey, login);
  try {
    const botType = opts.botType || DEFAULT_ILINK_BOT_TYPE;
    logger.info(`Starting Weixin login with bot_type=${botType}`);

    const signal = opts.requestSignal
      ? AbortSignal.any([login.abortController.signal, opts.requestSignal])
      : login.abortController.signal;
    const qrResponse = await fetchQRCode(FIXED_BASE_URL, botType, signal, opts.browser);
    if (!ownsLogin(login))
      return { sessionKey, cancelled: true, message: "连接流程已取消或替换。" };
    opts.assertCurrent?.();
    const qrDataUrl = opts.browser
      ? await encodeBrowserQr(qrResponse.qrcode_img_content)
      : undefined;
    if (!ownsLogin(login))
      return { sessionKey, cancelled: true, message: "连接流程已取消或替换。" };
    opts.assertCurrent?.();
    login.qrcode = qrResponse.qrcode;
    login.qrcodeUrl = qrResponse.qrcode_img_content;
    login.qrDataUrl = qrDataUrl;
    login.offeredAccountIds = opts.browser ? qrResponse.offeredAccountIds : undefined;
    login.startedAt = Date.now();

    return {
      qrcodeUrl: qrResponse.qrcode_img_content,
      message: "用手机微信扫描以下二维码，以继续连接：",
      sessionKey,
      qrDataUrl,
      expiresAtMs: login.startedAt + ACTIVE_LOGIN_TTL_MS,
    };
  } catch {
    if (!ownsLogin(login))
      return { sessionKey, cancelled: true, message: "连接流程已取消或替换。" };
    removeLogin(login);
    opts.assertCurrent?.();
    logger.error("Failed to start Weixin login");
    return {
      message: "获取微信二维码失败，请重试。",
      sessionKey,
    };
  }
}

const MAX_QR_REFRESH_COUNT = 3;

function ownsLogin(login: ActiveLogin): boolean {
  return activeLogins.get(login.sessionKey) === login && !login.abortController?.signal.aborted;
}

function removeLogin(login: ActiveLogin): void {
  if (activeLogins.get(login.sessionKey) !== login) return;
  login.pendingVerifyCode = undefined;
  login.abortController?.abort();
  activeLogins.delete(login.sessionKey);
}

async function encodeBrowserQr(payload: string): Promise<string> {
  if (!payload || payload.length > 2048) throw new Error("Invalid QR payload");
  const result = await QRCode.toDataURL(payload, {
    type: "image/png",
    width: 320,
    margin: 2,
    errorCorrectionLevel: "L",
  });
  if (!result.startsWith("data:image/png;base64,") || result.length > 16_384) {
    throw new Error("QR image exceeds browser contract");
  }
  return result;
}

/** These operations share the same identity owner as CLI and web login. */
export function controlWeixinLogin(params: {
  action: "verify" | "cancel";
  sessionKey: string;
  code?: string;
}): { ok: true; message: string; cancelled?: boolean } {
  const login = activeLogins.get(params.sessionKey);
  if (params.action === "cancel") {
    if (login?.browser) removeLogin(login);
    return { ok: true, cancelled: true, message: "连接流程已取消。" };
  }
  if (!login?.browser || !ownsLogin(login) || !isLoginFresh(login) || !login.verificationRequired) {
    throw new Error("当前没有等待验证码的微信连接，请重新发起连接。");
  }
  if (!params.code || !/^\d{1,10}$/.test(params.code))
    throw new Error("请输入手机微信显示的数字。");
  login.pendingVerifyCode = params.code;
  login.verificationRequired = false;
  return { ok: true, message: "验证码已提交，正在等待微信确认。" };
}

export function disposeWeixinLogins(): void {
  for (const login of activeLogins.values()) removeLogin(login);
}

/** One bounded polling slice; never reads stdin or persists outside the identity guard. */
export async function waitForWeixinLoginBrowser(opts: {
  sessionKey: string;
  timeoutMs?: number;
  onConnected: (result: WeixinQrWaitResult) => string;
  assertCurrent: () => void;
  requestSignal?: AbortSignal;
}): Promise<WeixinQrWaitResult> {
  opts.assertCurrent();
  const login = activeLogins.get(opts.sessionKey);
  const cancelled = (): WeixinQrWaitResult => ({
    connected: false,
    cancelled: true,
    message: "连接流程已取消或替换。",
  });
  if (!login?.browser || !ownsLogin(login)) return cancelled();
  const pending = (message: string): WeixinQrWaitResult => ({
    connected: false,
    message,
    sessionKey: login.sessionKey,
    qrDataUrl: login.qrDataUrl,
    expiresAtMs: login.startedAt + ACTIVE_LOGIN_TTL_MS,
    verificationRequired: login.verificationRequired === true,
  });
  if (!isLoginFresh(login)) {
    removeLogin(login);
    return { connected: false, message: "二维码已过期，请重新生成。" };
  }
  if (login.polling) return pending("正在等待微信确认。");
  if (login.verificationRequired) return pending("输入手机微信显示的数字，以继续连接。");
  login.polling = true;
  try {
    const submittedCode = login.pendingVerifyCode;
    const response = await pollQRStatus(
      login.currentApiBaseUrl ?? FIXED_BASE_URL,
      login.qrcode,
      submittedCode,
      {
        timeoutMs: Math.max(
          1000,
          Math.min(
            opts.timeoutMs ?? 25_000,
            30_000,
            login.startedAt + ACTIVE_LOGIN_TTL_MS - Date.now(),
          ),
        ),
        abortSignal: opts.requestSignal
          ? AbortSignal.any([login.abortController.signal, opts.requestSignal])
          : login.abortController.signal,
      },
    );
    if (!ownsLogin(login)) return cancelled();
    opts.assertCurrent();
    if (!isLoginFresh(login)) {
      removeLogin(login);
      return { connected: false, message: "二维码已过期，请重新生成。" };
    }
    login.status = response.status;
    switch (response.status) {
      case "need_verifycode":
        login.pendingVerifyCode = undefined;
        login.verificationRequired = true;
        return pending(
          submittedCode
            ? "数字不匹配，请重新输入手机微信显示的数字。"
            : "输入手机微信显示的数字，以继续连接。",
        );
      case "expired":
      case "verify_code_blocked": {
        login.pendingVerifyCode = undefined;
        login.verificationRequired = false;
        login.qrRefreshCount = (login.qrRefreshCount ?? 1) + 1;
        if (login.qrRefreshCount > MAX_QR_REFRESH_COUNT) {
          removeLogin(login);
          return { connected: false, message: "二维码多次失效或验证失败，请重新连接。" };
        }
        const refreshSignal = opts.requestSignal
          ? AbortSignal.any([login.abortController.signal, opts.requestSignal])
          : login.abortController.signal;
        const qr = await fetchQRCode(FIXED_BASE_URL, DEFAULT_ILINK_BOT_TYPE, refreshSignal, true);
        if (!ownsLogin(login)) return cancelled();
        opts.assertCurrent();
        const image = await encodeBrowserQr(qr.qrcode_img_content);
        if (!ownsLogin(login)) return cancelled();
        opts.assertCurrent();
        login.qrcode = qr.qrcode;
        login.qrcodeUrl = qr.qrcode_img_content;
        login.qrDataUrl = image;
        login.offeredAccountIds = qr.offeredAccountIds;
        login.startedAt = Date.now();
        login.currentApiBaseUrl = FIXED_BASE_URL;
        return pending("二维码已更新，请重新扫描。");
      }
      case "binded_redirect": {
        // Without a provider account ID, later account deletion must not turn a
        // generation offered to A+B into apparent proof that A was scanned.
        const offered = login.offeredAccountIds ?? [];
        const providerId = response.ilink_bot_id?.trim();
        const matches = providerId
          ? offered.filter((id) => normalizeAccountId(id) === normalizeAccountId(providerId))
          : offered.length === 1
            ? offered
            : [];
        const matched = matches.length === 1 ? matches[0] : undefined;
        const saved =
          matched &&
          (!login.accountId ||
            normalizeAccountId(login.accountId) === normalizeAccountId(matched)) &&
          listIndexedWeixinAccountIds().includes(matched) &&
          Boolean(loadWeixinAccount(matched)?.token?.trim());
        if (!ownsLogin(login)) return cancelled();
        opts.assertCurrent();
        removeLogin(login);
        return saved
          ? {
              connected: true,
              alreadyConnected: true,
              accountId: normalizeAccountId(matched),
              message: "此账号已连接到微信。",
            }
          : {
              connected: false,
              alreadyConnected: true,
              message: "无法确认本次扫码对应的本机账号，请重新连接。",
            };
      }
      case "confirmed": {
        if (!response.ilink_bot_id || !response.bot_token) {
          removeLogin(login);
          return { connected: false, message: "微信未返回完整登录凭据，请重试。" };
        }
        if (
          login.accountId &&
          normalizeAccountId(response.ilink_bot_id) !== normalizeAccountId(login.accountId)
        ) {
          removeLogin(login);
          return {
            connected: false,
            message: "扫码确认的微信账号与所选账号不一致，请使用所选账号重新连接。",
          };
        }
        const result: WeixinQrWaitResult = {
          connected: true,
          botToken: response.bot_token,
          accountId: response.ilink_bot_id,
          baseUrl: response.baseurl,
          userId: response.ilink_user_id,
          message: "已将此 OpenClaw 连接到微信。",
        };
        // Persistence is synchronous, immediately after this exact owner's live check.
        if (!ownsLogin(login)) return cancelled();
        opts.assertCurrent();
        const accountId = opts.onConnected(result);
        removeLogin(login);
        return { connected: true, accountId, message: result.message };
      }
      case "scaned_but_redirect":
        if (response.redirect_host) {
          const host = response.redirect_host.toLowerCase();
          if (!/^[a-z0-9.-]+\.weixin\.qq\.com$/.test(host))
            throw new Error("Unexpected polling redirect");
          login.currentApiBaseUrl = `https://${host}`;
        }
        return pending("正在等待微信确认。");
      case "scaned":
        login.pendingVerifyCode = undefined;
        return pending("已扫码，请在手机微信确认。");
      default:
        return pending("请用手机微信扫描二维码。");
    }
  } catch {
    if (!ownsLogin(login)) return cancelled();
    removeLogin(login);
    opts.assertCurrent();
    throw new Error("微信连接未完成，二维码刷新或凭据保存失败，请重试。");
  } finally {
    login.polling = false;
  }
}

/**
 * 刷新二维码并展示给用户，返回是否成功。
 * 成功时更新 activeLogin 的 qrcode/qrcodeUrl/startedAt，并重置 scannedPrinted。
 */
async function refreshQRCode(
  activeLogin: ActiveLogin,
  botType: string,
  qrRefreshCount: number,
  onScannedReset: () => void,
): Promise<{ success: true } | { success: false; message: string }> {
  process.stdout.write(`\n⏳ 正在刷新二维码...(${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
  logger.info(`waitForWeixinLogin: refreshing QR code (${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})`);
  try {
    const qrResponse = await fetchQRCode(FIXED_BASE_URL, botType);
    if (!ownsLogin(activeLogin)) return { success: false, message: "连接流程已取消或替换。" };
    activeLogin.qrcode = qrResponse.qrcode;
    activeLogin.qrcodeUrl = qrResponse.qrcode_img_content;
    activeLogin.startedAt = Date.now();
    onScannedReset();
    logger.info(
      `waitForWeixinLogin: new QR code obtained qrcode=${redactToken(qrResponse.qrcode)}`,
    );
    process.stdout.write(`🔄 二维码已更新，请重新扫描。\n\n`);
    await displayQRCode(qrResponse.qrcode_img_content);
    return { success: true };
  } catch (refreshErr) {
    logger.error(`waitForWeixinLogin: failed to refresh QR code: ${String(refreshErr)}`);
    return { success: false, message: `刷新二维码失败: ${String(refreshErr)}` };
  }
}

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
    removeLogin(activeLogin);
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
      const statusResponse = await pollQRStatus(
        currentBaseUrl,
        activeLogin.qrcode,
        activeLogin.pendingVerifyCode,
      );
      if (!ownsLogin(activeLogin))
        return { connected: false, cancelled: true, message: "连接流程已取消或替换。" };
      logger.debug(
        `pollQRStatus: status=${statusResponse.status} hasBotToken=${Boolean(statusResponse.bot_token)} hasBotId=${Boolean(statusResponse.ilink_bot_id)}`,
      );
      activeLogin.status = statusResponse.status;

      switch (statusResponse.status) {
        case "wait":
          if (opts.verbose) {
            process.stdout.write(".");
          }
          break;
        case "scaned":
          // 若携带了配对码且服务端返回 scaned，说明验证码正确，清除暂存
          if (activeLogin.pendingVerifyCode) {
            logger.info("verify code accepted, resuming polling");
            activeLogin.pendingVerifyCode = undefined;
          }
          if (!scannedPrinted) {
            process.stdout.write("\n正在验证\n");
            scannedPrinted = true;
          }
          break;
        case "need_verifycode": {
          // 首次进入提示输入，再次进入（已有 pendingVerifyCode）说明上次输入错误
          const verifyPrompt = activeLogin.pendingVerifyCode
            ? "❌ 你输入的数字不匹配，请重新输入："
            : "输入手机微信显示的数字，以继续连接：";
          const code = await readVerifyCodeFromStdin(verifyPrompt);
          activeLogin.pendingVerifyCode = code;
          // 立即进入下一次轮询，不等待 1s
          continue;
        }
        case "expired": {
          qrRefreshCount++;
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            logger.warn(
              `waitForWeixinLogin: QR expired ${MAX_QR_REFRESH_COUNT} times, giving up sessionKey=${opts.sessionKey}`,
            );
            removeLogin(activeLogin);
            return {
              connected: false,
              message: "二维码多次失效，连接流程已停止。请稍后再试。",
            };
          }

          process.stdout.write(`\n⏳ 二维码已过期，正在刷新...\n`);
          const expiredRefreshResult = await refreshQRCode(
            activeLogin,
            opts.botType || DEFAULT_ILINK_BOT_TYPE,
            qrRefreshCount,
            () => {
              scannedPrinted = false;
            },
          );
          if (!expiredRefreshResult.success) {
            removeLogin(activeLogin);
            return { connected: false, message: expiredRefreshResult.message };
          }
          break;
        }
        case "verify_code_blocked": {
          logger.warn(
            `waitForWeixinLogin: verify code blocked, qrRefreshCount=${qrRefreshCount} sessionKey=${opts.sessionKey}`,
          );
          process.stdout.write("\n⛔ 多次输入错误，请稍后再试。\n");
          // 清除配对码暂存
          activeLogin.pendingVerifyCode = undefined;

          qrRefreshCount++;
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            logger.warn(
              `waitForWeixinLogin: verify_code_blocked and QR refresh limit reached, giving up sessionKey=${opts.sessionKey}`,
            );
            removeLogin(activeLogin);
            return {
              connected: false,
              message: "多次输入错误，连接流程已停止。请稍后再试。",
            };
          }

          const blockedRefreshResult = await refreshQRCode(
            activeLogin,
            opts.botType || DEFAULT_ILINK_BOT_TYPE,
            qrRefreshCount,
            () => {
              scannedPrinted = false;
            },
          );
          if (!blockedRefreshResult.success) {
            removeLogin(activeLogin);
            return { connected: false, message: blockedRefreshResult.message };
          }
          break;
        }
        case "binded_redirect": {
          logger.info(
            `waitForWeixinLogin: binded_redirect received, bot already bound sessionKey=${opts.sessionKey}`,
          );
          process.stdout.write("\n✅ 已连接过此 OpenClaw，无需重复连接。\n");
          removeLogin(activeLogin);
          return {
            connected: false,
            alreadyConnected: true,
            message: "已连接过此 OpenClaw，无需重复连接。",
          };
        }
        case "scaned_but_redirect": {
          const redirectHost = statusResponse.redirect_host;
          if (redirectHost) {
            const newBaseUrl = `https://${redirectHost}`;
            activeLogin.currentApiBaseUrl = newBaseUrl;
            logger.info(
              `waitForWeixinLogin: IDC redirect, switching polling host to ${redirectHost}`,
            );
          } else {
            logger.warn(
              `waitForWeixinLogin: received scaned_but_redirect but redirect_host is missing, continuing with current host`,
            );
          }
          break;
        }
        case "confirmed": {
          if (!statusResponse.ilink_bot_id) {
            removeLogin(activeLogin);
            logger.error("Login confirmed but ilink_bot_id missing from response");
            return {
              connected: false,
              message: "登录失败：服务器未返回 ilink_bot_id。",
            };
          }

          activeLogin.botToken = statusResponse.bot_token;
          removeLogin(activeLogin);

          logger.info(
            `✅ Login confirmed! ilink_bot_id=${statusResponse.ilink_bot_id} ilink_user_id=${redactToken(statusResponse.ilink_user_id)}`,
          );

          return {
            connected: true,
            botToken: statusResponse.bot_token,
            accountId: statusResponse.ilink_bot_id,
            baseUrl: statusResponse.baseurl,
            userId: statusResponse.ilink_user_id,
            message: "已将此 OpenClaw 连接到微信。",
          };
        }
      }
    } catch (err) {
      logger.error(`Error polling QR status: ${String(err)}`);
      removeLogin(activeLogin);
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
  removeLogin(activeLogin);
  return {
    connected: false,
    message: "登录超时，请重试。",
  };
}
