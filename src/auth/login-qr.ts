import { randomUUID } from "node:crypto";

import { apiGetFetch, apiPostFetch, getPluginVersion } from "../api/api.js";
import {
  listIndexedWeixinAccountIds,
  loadConfigPromptBindOwner,
  loadConfigVerifyPin,
  loadWeixinAccount,
} from "./accounts.js";
import {
  PROMPT_BIND,
  PROMPT_REALNAME,
  readOwnerChoice,
  type BindOwnerMode,
} from "./bind-owner-prompt.js";
import {
  BotSpamTicketError,
  REALNAME_AUTH_WAIT_MS,
  fetchBotSpamTicket,
  queryBotSpamAuthResult,
  waitForBotSpamAuth,
  type BotSpamTicketContext,
} from "./bot-spam-ticket.js";
import { logger } from "../util/logger.js";
import { redactToken, redactUrl } from "../util/redact.js";

export const QR_LOGIN_WAIT_MS = REALNAME_AUTH_WAIT_MS;
const TICKET_RE = /^[0-9a-fA-F]{32}$/;
const TICKET_REFRESH_MARGIN_SEC = 60;

export type LoginIo = {
  readLine?: () => Promise<string>;
  write?: (chunk: string) => void;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  fetchImpl?: typeof fetch;
};

type ActiveLogin = {
  sessionKey: string;
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
    | "confirmed_but_need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
  error?: string;
  /** The current effective polling base URL; may be updated on IDC redirect. */
  currentApiBaseUrl?: string;
  /** 待提交的配对码，用户输入后暂存，下次轮询时携带 */
  pendingVerifyCode?: string;
  bindOwnerMode: BindOwnerMode;
  /** Present only for other-owner binds. Self binds omit the spam ticket. */
  botSpamTicket?: string;
  ticketExpireTimeSec?: number;
  /** 1 asks the security backend to require the phone PIN. 0 leaves the decision to security. */
  verifyPin: 0 | 1;
};

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
    | "confirmed_but_need_verifycode"
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

/** 获取本地已登录账号的 bot token 列表，最多返回最新的 10 个。 */
function getLocalBotTokenList(): string[] {
  const accountIds = listIndexedWeixinAccountIds();
  const tokens: string[] = [];
  // 从最新注册的账号开始取（列表末尾为最新）
  for (let i = accountIds.length - 1; i >= 0 && tokens.length < 10; i--) {
    const data = loadWeixinAccount(accountIds[i]);
    const token = data?.token?.trim();
    if (token) {
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * UTF-8 JSON, then standard base64. Later plugin fields are added to this
 * object before encoding, so the wire field stays one opaque string.
 */
export function encodeBotSpamBusinessData(data: { verify_pin: 0 | 1 }): string {
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64");
}

/** Any status containing this marker asks the operator to type the phone PIN. */
export function statusNeedsVerifyCode(status: string): boolean {
  return status.includes("need_verifycode");
}

/**
 * Dev switch for `bot_spam_business_data.verify_pin`.
 * An explicit boolean wins. Otherwise `--verify-pin`,
 * `OPENCLAW_WEIXIN_VERIFY_PIN=1` / `true`, or
 * `channels.openclaw-weixin.verifyPin: true` selects 1.
 */
export function resolveVerifyPinFlag(input?: {
  verifyPin?: boolean;
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  configVerifyPin?: boolean;
}): 0 | 1 {
  if (input?.verifyPin !== undefined) {
    return input.verifyPin ? 1 : 0;
  }
  const argv = input?.argv ?? process.argv;
  if (argv.includes("--verify-pin")) {
    return 1;
  }
  const raw = (input?.env ?? process.env).OPENCLAW_WEIXIN_VERIFY_PIN?.trim().toLowerCase();
  if (raw === "1" || raw === "true") {
    return 1;
  }
  if (input?.configVerifyPin === true) {
    return 1;
  }
  return 0;
}

async function fetchQRCode(
  apiBaseUrl: string,
  botType: string,
  botSpamTicket: string | undefined,
  verifyPin: 0 | 1,
  fetchImpl?: typeof fetch,
): Promise<QRCodeResponse> {
  logger.info(`NewFetching QR code from: ${apiBaseUrl} bot_type=${botType}`);
  const localTokenList = getLocalBotTokenList();
  logger.info(`newfetchQRCode: local_token_list count=${localTokenList.length}`);
  const payload: {
    local_token_list: string[];
    bot_spam_ticket?: string;
    bot_spam_business_data?: string;
  } = {
    local_token_list: localTokenList,
  };
  if (verifyPin === 1) {
    payload.bot_spam_business_data = encodeBotSpamBusinessData({ verify_pin: 1 });
    logger.info("fetchQRCode: bot_spam_business_data.verify_pin=1");
  } else {
    logger.info("fetchQRCode: omit bot_spam_business_data");
  }
  if (botSpamTicket !== undefined) {
    if (!TICKET_RE.test(botSpamTicket)) {
      throw new BotSpamTicketError("无法获取绑定凭证，连接已停止。");
    }
    payload.bot_spam_ticket = botSpamTicket;
    logger.info(`fetchQRCode: bot_spam_ticket=${redactToken(botSpamTicket)}`);
  } else {
    logger.info("fetchQRCode: omit bot_spam_ticket");
  }
  const body = JSON.stringify(payload);
  if (fetchImpl) {
    const url = `${apiBaseUrl.replace(/\/$/, "")}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`fetchQRCode ${response.status}: ${rawText}`);
    }
    return JSON.parse(rawText) as QRCodeResponse;
  }
  const rawText = await apiPostFetch({
    baseUrl: apiBaseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body,
    label: "fetchQRCode",
  });
  return JSON.parse(rawText) as QRCodeResponse;
}

function readStdinLine(): Promise<string> {
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

/** 从 stdin 读取一行用户输入，输出提示语后等待回车确认，返回 trim 后的字符串。 */
async function readVerifyCodeFromStdin(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return readStdinLine();
}

async function pollQRStatus(
  apiBaseUrl: string,
  qrcode: string,
  verifyCode?: string,
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
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: "pollQRStatus",
    });
    logger.debug(`pollQRStatus: body=${rawText.substring(0, 200)}`);
    return JSON.parse(rawText) as StatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.debug(
        `pollQRStatus: client-side timeout after ${QR_LONG_POLL_TIMEOUT_MS}ms, returning wait`,
      );
      return { status: "wait" };
    }
    // 网关超时（如 Cloudflare 524）或其他网络错误，视为等待状态继续轮询
    logger.warn(`pollQRStatus: network/gateway error, will retry: ${String(err)}`);
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
  bindOwnerMode?: BindOwnerMode;
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
  /** The user ID of the person who scanned the QR code; used as the account owner. */
  userId?: string;
  message: string;
};

export async function startWeixinLoginWithQr(opts: {
  verbose?: boolean;
  force?: boolean;
  accountId?: string;
  apiBaseUrl: string;
  botType?: string;
  /** When set, overrides argv and `OPENCLAW_WEIXIN_VERIFY_PIN`. */
  verifyPin?: boolean;
  io?: LoginIo;
}): Promise<WeixinQrStartResult> {
  const sessionKey = opts.accountId || randomUUID();
  void opts.force;
  const io = opts.io ?? {};
  const write = io.write ?? ((chunk: string) => process.stdout.write(chunk));
  const readLine = io.readLine ?? readStdinLine;
  const nowMs = io.nowMs ?? (() => Date.now());
  const sleep = io.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  logger.info(`startWeixinLoginWithQr: discard previous session sessionKey=${sessionKey}`);
  activeLogins.delete(sessionKey);

  try {
    const botType = opts.botType || DEFAULT_ILINK_BOT_TYPE;
    const verifyPin = resolveVerifyPinFlag({
      verifyPin: opts.verifyPin,
      configVerifyPin: loadConfigVerifyPin(),
    });
    const promptBindOwner = loadConfigPromptBindOwner();
    const bindOwnerMode = promptBindOwner ? await readOwnerChoice({ readLine, write }) : "self";
    logger.info(
      `Starting Weixin login with bot_type=${botType} bindOwnerMode=${bindOwnerMode} promptBindOwner=${promptBindOwner} verify_pin=${verifyPin}`,
    );
    let ticket: BotSpamTicketContext | undefined;
    if (bindOwnerMode === "other") {
      const nowSec = Math.floor(nowMs() / 1000);
      ticket = await fetchBotSpamTicket({
        pluginVersion: getPluginVersion(),
        fetchImpl: io.fetchImpl,
        nowSec,
        accountId: opts.accountId,
      });
      ticket = await authorizeOtherOwner({
        ticket,
        write,
        nowMs,
        sleep,
        fetchImpl: io.fetchImpl,
        accountId: opts.accountId,
      });
    } else {
      logger.info("bindOwnerMode=self, skip get_auth_url and bot_spam_ticket");
    }
    const qrResponse = await fetchQRCode(
      FIXED_BASE_URL,
      botType,
      ticket?.botSpamTicket,
      verifyPin,
      io.fetchImpl,
    );
    logger.info(
      `QR code received, qrcode=${redactToken(qrResponse.qrcode)} imgContentLen=${qrResponse.qrcode_img_content?.length ?? 0}`,
    );
    logger.info(`二维码链接: ${qrResponse.qrcode_img_content}`);

    const login: ActiveLogin = {
      sessionKey,
      id: randomUUID(),
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      startedAt: nowMs(),
      bindOwnerMode,
      botSpamTicket: ticket?.botSpamTicket,
      ticketExpireTimeSec: ticket?.expireTimeSec,
      verifyPin,
    };
    activeLogins.set(sessionKey, login);

    return {
      qrcodeUrl: qrResponse.qrcode_img_content,
      message: PROMPT_BIND,
      sessionKey,
      bindOwnerMode,
    };
  } catch (err) {
    if (err instanceof BotSpamTicketError) {
      logger.warn(`startWeixinLoginWithQr stopped: ${err.message}`);
      return { message: err.message, sessionKey };
    }
    logger.error(`Failed to start Weixin login: ${String(err)}`);
    return {
      message: `Failed to start login: ${String(err)}`,
      sessionKey,
    };
  }
}

async function authorizeOtherOwner(opts: {
  ticket: BotSpamTicketContext;
  write: (chunk: string) => void;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  accountId?: string;
}): Promise<BotSpamTicketContext> {
  const showRealnameQr = async (ticket: BotSpamTicketContext) => {
    logger.info(
      `showing realname qr ticket=${redactToken(ticket.botSpamTicket)} auth_url=${redactUrl(ticket.authUrl)} expire_time=${ticket.expireTimeSec}`,
    );
    opts.write(PROMPT_REALNAME);
    await displayQRCode(ticket.authUrl);
  };
  await showRealnameQr(opts.ticket);
  return waitForBotSpamAuth({
    ticket: opts.ticket,
    nowMs: opts.nowMs,
    sleep: opts.sleep,
    deadlineMs: Math.min(opts.nowMs() + QR_LOGIN_WAIT_MS, opts.ticket.expireTimeSec * 1000),
    query: (botSpamTicket) =>
      queryBotSpamAuthResult({
        botSpamTicket,
        fetchImpl: opts.fetchImpl,
        accountId: opts.accountId,
      }),
    refreshTicket: () =>
      fetchBotSpamTicket({
        pluginVersion: getPluginVersion(),
        fetchImpl: opts.fetchImpl,
        nowSec: Math.floor(opts.nowMs() / 1000),
        accountId: opts.accountId,
      }),
    onTicketReplaced: showRealnameQr,
  });
}

const MAX_QR_REFRESH_COUNT = 3;

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
  const nowSec = Math.floor(Date.now() / 1000);
  if (
    activeLogin.botSpamTicket !== undefined &&
    (activeLogin.ticketExpireTimeSec ?? 0) - nowSec <= TICKET_REFRESH_MARGIN_SEC
  ) {
    logger.warn(
      `refreshQRCode stopped: ticket expires within ${TICKET_REFRESH_MARGIN_SEC}s expire_time=${activeLogin.ticketExpireTimeSec} nowSec=${nowSec}`,
    );
    return { success: false, message: "绑定凭证即将过期，请重新开始连接。" };
  }
  try {
    const qrResponse = await fetchQRCode(
      FIXED_BASE_URL,
      botType,
      activeLogin.botSpamTicket,
      activeLogin.verifyPin,
    );
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

  const timeoutMs = Math.max(opts.timeoutMs ?? QR_LOGIN_WAIT_MS, 1000);
  const deadline = Date.now() + timeoutMs;
  let scannedPrinted = false;
  let qrRefreshCount = 1;

  // Initialize the effective polling base URL; may be updated on IDC redirect.
  activeLogin.currentApiBaseUrl = FIXED_BASE_URL;

  logger.info("Starting to poll QR code status...");
  let lastQrStatus = "";

  while (Date.now() < deadline) {
    try {
      const currentBaseUrl = activeLogin.currentApiBaseUrl ?? FIXED_BASE_URL;
      const statusResponse = await pollQRStatus(
        currentBaseUrl,
        activeLogin.qrcode,
        activeLogin.pendingVerifyCode,
      );
      logger.debug(
        `pollQRStatus: status=${statusResponse.status} hasBotToken=${Boolean(statusResponse.bot_token)} hasBotId=${Boolean(statusResponse.ilink_bot_id)}`,
      );
      if (statusResponse.status !== lastQrStatus) {
        logger.info(
          `pollQRStatus: status=${statusResponse.status} hasBotToken=${Boolean(statusResponse.bot_token)} hasBotId=${Boolean(statusResponse.ilink_bot_id)} redirect_host=${statusResponse.redirect_host ?? ""}`,
        );
        lastQrStatus = statusResponse.status;
      }
      activeLogin.status = statusResponse.status;

      if (statusNeedsVerifyCode(statusResponse.status)) {
        logger.info(
          `qr status requires verify code status=${statusResponse.status} retry=${Boolean(activeLogin.pendingVerifyCode)}`,
        );
        const verifyPrompt = activeLogin.pendingVerifyCode
          ? "❌ 你输入的数字不匹配，请重新输入："
          : "输入手机微信显示的数字，以继续连接：";
        const code = await readVerifyCodeFromStdin(verifyPrompt);
        logger.info(`verify code submitted len=${code.length}`);
        activeLogin.pendingVerifyCode = code;
        continue;
      }

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
        case "expired": {
          qrRefreshCount++;
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            logger.warn(
              `waitForWeixinLogin: QR expired ${MAX_QR_REFRESH_COUNT} times, giving up sessionKey=${opts.sessionKey}`,
            );
            activeLogins.delete(opts.sessionKey);
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
            activeLogins.delete(opts.sessionKey);
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
            activeLogins.delete(opts.sessionKey);
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
            activeLogins.delete(opts.sessionKey);
            return { connected: false, message: blockedRefreshResult.message };
          }
          break;
        }
        case "binded_redirect": {
          logger.info(
            `waitForWeixinLogin: binded_redirect received, bot already bound sessionKey=${opts.sessionKey}`,
          );
          process.stdout.write("\n✅ 已连接过此 OpenClaw，无需重复连接。\n");
          activeLogins.delete(opts.sessionKey);
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
            message: "已将此 OpenClaw 连接到微信。",
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
