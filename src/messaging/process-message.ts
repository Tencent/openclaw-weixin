import path from "node:path";
import { randomUUID } from "node:crypto";

import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

import { sendTyping } from "../api/api.js";
import type { WeixinMessage } from "../api/types.js";
import { MessageItemType, TypingStatus } from "../api/types.js";
import { loadWeixinAccount } from "../auth/accounts.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { resolveReplyProgressMessagesEnabled } from "../config/reply-progress.js";
import { resolveErrorNoticesEnabled } from "../config/error-notices.js";
import { resolveMediaDownloadPolicy } from "../config/media-download.js";
import { logger } from "../util/logger.js";
import { redactBody, redactToken } from "../util/redact.js";

import { isDebugMode } from "./debug-mode.js";
import { sendWeixinErrorNotice } from "./error-notice.js";
import { applyWeixinMessageSendingHook, emitWeixinMessageSent } from "./outbound-hooks.js";
import {
  downloadedMediaEntry,
  setContextToken,
  weixinMessageToMsgContext,
  getContextTokenFromMsgContext,
  getWeixinMessageId,
} from "./inbound.js";
import { sendWeixinMediaFile } from "./send-media.js";
import { StreamingMarkdownFilter } from "./markdown-filter.js";
import { sendMessageWeixin } from "./send.js";
import { WeixinReplyProgressSender } from "./reply-progress-sender.js";
import { withPublishedModelRuntime } from "./dispatch-options.js";
import { resolveWeixinInboundAuthorization } from "./authorization.js";
import { loadTypingCallbacksFactory } from "./typing.js";
import { getQuoteStore } from "./quote-store.js";
import { getInboundSources, mergeInboundMessages } from "./inbound-sources.js";
import {
  prepareInboundMessage,
  combinePreparedMedia,
  preparedQuoteBodies,
} from "./prepare-inbound.js";
import type { PreparedInboundMessage } from "./prepare-inbound.js";
import { handleSlashCommand } from "./slash-commands.js";

const MEDIA_OUTBOUND_TEMP_DIR = path.join(
  resolvePreferredOpenClawTmpDir(),
  "weixin/media/outbound-temp",
);

/** Dependencies for processOneMessage, injected by the monitor loop. */
export type ProcessMessageDeps = {
  accountId: string;
  config: import("openclaw/plugin-sdk/core").OpenClawConfig;
  channelRuntime: PluginRuntime["channel"];
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  typingTicket?: string;
  /** Channel lifetime, forwarded to the core dispatch owner. */
  abortSignal?: AbortSignal;
  /** Persist admission immediately before an irreversible command or agent run. */
  beforeExecute?: () => void;
  /** Settle one failed source without ending its healthy merged neighbors. */
  onPreparationFailure?: (message: WeixinMessage, error: unknown) => void;
  log: (msg: string) => void;
  errLog: (m: string) => void;
};

/** Extract text body from item_list (for slash command detection). */
function extractTextBody(itemList?: import("../api/types.js").MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

/**
 * Process a single inbound message: route → download media → dispatch reply.
 * Extracted from the monitor loop to keep monitoring and message handling separate.
 */
export async function processOneMessage(
  full: WeixinMessage,
  deps: ProcessMessageDeps,
): Promise<void> {
  if (!deps?.channelRuntime) {
    logger.error(
      `processOneMessage: channelRuntime is undefined, skipping message from=${full.from_user_id}`,
    );
    deps.errLog("processOneMessage: channelRuntime is undefined, skip");
    return;
  }

  deps.abortSignal?.throwIfAborted();
  const receivedAt = Date.now();
  const debug = isDebugMode(deps.accountId);
  const debugTrace: string[] = [];
  const debugTs: Record<string, number> = { received: receivedAt };

  let textBody = extractTextBody(full.item_list);
  const senderId = full.from_user_id ?? "";
  const ownerId = loadWeixinAccount(deps.accountId)?.userId?.trim();
  let { senderAllowed, commandAuthorized } = await resolveWeixinInboundAuthorization({
    senderId,
    ownerId,
    rawBody: textBody.trim(),
    config: deps.config,
    commands: deps.channelRuntime.commands,
  });

  if (!senderAllowed) {
    logger.info(`authorization: dropping message from=${senderId} outcome=unauthorized`);
    return;
  }

  if (getInboundSources(full).length === 1 && textBody.startsWith("/")) {
    const slashResult = await handleSlashCommand(
      textBody,
      {
        to: full.from_user_id ?? "",
        contextToken: full.context_token,
        baseUrl: deps.baseUrl,
        token: deps.token,
        accountId: deps.accountId,
        commandAuthorized: commandAuthorized === true,
        beforeExecute: deps.beforeExecute,
        abortSignal: deps.abortSignal,
        log: deps.log,
        errLog: deps.errLog,
      },
      receivedAt,
      full.create_time_ms,
    );
    if (slashResult.handled) {
      logger.info(`[weixin] Slash command handled, skipping AI pipeline`);
      return;
    }
  }

  if (debug) {
    const itemTypes = full.item_list?.map((i) => i.type).join(",") ?? "none";
    debugTrace.push(
      "── 收消息 ──",
      `│ seq=${full.seq ?? "?"} msgId=${full.message_id ?? "?"} from=${full.from_user_id ?? "?"}`,
      `│ body="${textBody.slice(0, 40)}${textBody.length > 40 ? "…" : ""}" (len=${textBody.length}) itemTypes=[${itemTypes}]`,
      `│ sessionId=${full.session_id ?? "?"} contextToken=${full.context_token ? "present" : "none"}`,
    );
  }

  let ctx = weixinMessageToMsgContext(full, deps.accountId, {});
  let rawBody = ctx.Body?.trim() ?? "";
  ctx.CommandBody = rawBody;
  ctx.CommandAuthorized = commandAuthorized;
  logger.debug(
    `authorization: senderId=${senderId} commandAuthorized=${String(commandAuthorized)} senderAllowed=${String(senderAllowed)}`,
  );

  if (debug) {
    debugTrace.push(
      "── 鉴权 & 路由 ──",
      `│ auth: cmdAuthorized=${String(commandAuthorized)} senderAllowed=${String(senderAllowed)}`,
    );
  }

  let contextToken = getContextTokenFromMsgContext(ctx);
  const runId = randomUUID();
  const downloadPolicy = resolveMediaDownloadPolicy(deps.config);
  let failureNoticeSent = false;
  let failureNotice: ReturnType<typeof sendWeixinErrorNotice> | undefined;
  let visibleFinalDelivered = false;
  let deliveryFailure: unknown;
  const quoteStore = getQuoteStore();
  const prepared: PreparedInboundMessage[] = [];
  let preparationFailures = 0;
  let mediaDownloadMs = 0;
  try {
    if (contextToken) {
      setContextToken(deps.accountId, full.from_user_id ?? "", contextToken);
    }
    const sources = getInboundSources(full);
    const mediaDownloadStart = Date.now();
    for (const source of sources) {
      deps.abortSignal?.throwIfAborted();
      try {
        prepared.push(await prepareInboundMessage(source, deps));
      } catch (error) {
        if (deps.abortSignal?.aborted || sources.length === 1) throw error;
        deps.onPreparationFailure?.(source, error);
        preparationFailures++;
        deps.errLog(
          `weixin source preparation failed: messageId=${getWeixinMessageId(source) ?? "unknown"} error=${String(error)}`,
        );
      }
    }
    deps.abortSignal?.throwIfAborted();
    if (!prepared.length) return;
    mediaDownloadMs = Date.now() - mediaDownloadStart;
    full = mergeInboundMessages(
      prepared.map((item) => item.message),
      preparedQuoteBodies(prepared),
    );
    textBody = extractTextBody(full.item_list);
    // Filtering can change the command body; recompute its authorization from surviving input.
    if (preparationFailures) {
      ({ commandAuthorized } = await resolveWeixinInboundAuthorization({
        senderId,
        ownerId,
        rawBody: textBody.trim(),
        config: deps.config,
        commands: deps.channelRuntime.commands,
      }));
    }
    ctx =
      prepared.length === 1 ? prepared[0].ctx : weixinMessageToMsgContext(full, deps.accountId, {});
    if (prepared.length > 1) combinePreparedMedia(ctx, prepared);
    rawBody = ctx.Body?.trim() ?? "";
    ctx.CommandBody = rawBody;
    ctx.CommandAuthorized = commandAuthorized;
    contextToken = getContextTokenFromMsgContext(ctx);
    if (contextToken) setContextToken(deps.accountId, senderId, contextToken);
    const downloadedItems = new Map(prepared.flatMap((item) => [...item.downloadedItems]));
    if (debug)
      debugTrace.push(
        `│ mediaDownload: sources=${prepared.length} cost=${mediaDownloadMs}ms failed=${preparationFailures}`,
      );

    // Keep each original ID/body and its own attachments, never the merged envelope's ID.
    for (const source of getInboundSources(full)) {
      const inboundMessageId = getWeixinMessageId(source);
      if (!inboundMessageId) continue;
      const attachments = (source.item_list ?? []).flatMap((item) => {
        const downloaded = downloadedItems.get(item);
        const entry = downloaded && downloadedMediaEntry(item, downloaded);
        return entry
          ? [
              {
                sourceMediaPath: entry.path,
                mediaMime: entry.contentType,
                mediaName: entry.fileName,
              },
            ]
          : [];
      });
      try {
        await quoteStore?.put({
          accountId: deps.accountId,
          conversationId: senderId,
          messageId: inboundMessageId,
          direction: "inbound",
          body: weixinMessageToMsgContext(source, deps.accountId).Body,
          media: attachments,
          createdAt: source.create_time_ms ?? Date.now(),
        });
      } catch (err) {
        logger.warn(
          `quote cache: failed to save inbound message id=${inboundMessageId}: ${String(err)}`,
        );
      }
    }

    const route = deps.channelRuntime.routing.resolveAgentRoute({
      cfg: deps.config,
      channel: "openclaw-weixin",
      accountId: deps.accountId,
      peer: { kind: "direct", id: ctx.To },
    });
    logger.debug(
      `resolveAgentRoute: agentId=${route.agentId ?? "(none)"} sessionKey=${route.sessionKey ?? "(none)"} mainSessionKey=${route.mainSessionKey ?? "(none)"}`,
    );
    if (!route.agentId) {
      logger.error(
        `resolveAgentRoute: no agentId resolved for peer=${ctx.To} accountId=${deps.accountId} — message will not be dispatched`,
      );
    }

    if (debug) {
      debugTrace.push(
        `│ route: agent=${route.agentId ?? "none"} session=${route.sessionKey ?? "none"}`,
      );
      debugTs.preDispatch = Date.now();
    }
    // Propagate the resolved session key into ctx so dispatchReplyFromConfig uses
    // the correct session (matching the dmScope from config) instead of falling back
    // to agent:main:main.
    ctx.SessionKey = route.sessionKey;
    const storePath = deps.channelRuntime.session.resolveStorePath(deps.config.session?.store, {
      agentId: route.agentId,
    });
    const finalized = deps.channelRuntime.reply.finalizeInboundContext(
      ctx as Parameters<typeof deps.channelRuntime.reply.finalizeInboundContext>[0],
    );

    logger.info(
      `inbound: from=${finalized.From} to=${finalized.To} bodyLen=${(finalized.Body ?? "").length} hasMedia=${Boolean(finalized.MediaPath ?? finalized.MediaUrl)}`,
    );
    logger.debug(`inbound context: ${redactBody(JSON.stringify(finalized))}`);

    await deps.channelRuntime.session.recordInboundSession({
      storePath,
      sessionKey: route.sessionKey,
      ctx: finalized as Parameters<
        typeof deps.channelRuntime.session.recordInboundSession
      >[0]["ctx"],
      updateLastRoute: {
        sessionKey: route.mainSessionKey,
        channel: "openclaw-weixin",
        to: ctx.To,
        accountId: deps.accountId,
      },
      onRecordError: (err) => deps.errLog(`recordInboundSession: ${String(err)}`),
    });
    logger.debug(
      `recordInboundSession: done storePath=${storePath} sessionKey=${route.sessionKey ?? "(none)"}`,
    );

    deps.abortSignal?.throwIfAborted();
    const replyProgressSender = resolveReplyProgressMessagesEnabled(deps.config)
      ? new WeixinReplyProgressSender({
          runId,
          to: ctx.To,
          accountId: deps.accountId,
          opts: {
            baseUrl: deps.baseUrl,
            token: deps.token,
            abortSignal: deps.abortSignal,
            contextToken,
            accountId: deps.accountId,
          },
        })
      : undefined;
    const humanDelay = deps.channelRuntime.reply.resolveHumanDelayConfig(
      deps.config,
      route.agentId,
    );

    const hasTypingTicket = Boolean(deps.typingTicket);
    const createTypingCallbacks = await loadTypingCallbacksFactory();
    const typingCallbacks = createTypingCallbacks({
      start: hasTypingTicket
        ? () =>
            sendTyping({
              baseUrl: deps.baseUrl,
              token: deps.token,
              abortSignal: deps.abortSignal,
              body: {
                ilink_user_id: ctx.To,
                typing_ticket: deps.typingTicket!,
                status: TypingStatus.TYPING,
              },
            })
        : async () => {},
      stop: hasTypingTicket
        ? () =>
            sendTyping({
              baseUrl: deps.baseUrl,
              token: deps.token,
              abortSignal: deps.abortSignal,
              body: {
                ilink_user_id: ctx.To,
                typing_ticket: deps.typingTicket!,
                status: TypingStatus.CANCEL,
              },
            })
        : async () => {},
      onStartError: (err) => deps.log(`[weixin] typing send error: ${String(err)}`),
      onStopError: (err) => deps.log(`[weixin] typing cancel error: ${String(err)}`),
      keepaliveIntervalMs: 5000,
    });

    /** Delivery records populated synchronously at deliver() entry, safe to read in finally. */
    const debugDeliveries: Array<{ textLen: number; media: string; preview: string; ts: number }> =
      [];

    const { dispatcher, replyOptions, markDispatchIdle } =
      deps.channelRuntime.reply.createReplyDispatcherWithTyping({
        humanDelay,
        typingCallbacks,
        deliver: async (payload, info) => {
          deps.abortSignal?.throwIfAborted();
          deliveryFailure = undefined;
          const rawText = payload.text ?? "";
          let text = (() => {
            const f = new StreamingMarkdownFilter();
            return f.feed(rawText) + f.flush();
          })();
          const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.[0];
          logger.debug(`outbound payload: ${redactBody(JSON.stringify(payload))}`);
          logger.info(
            `outbound: to=${ctx.To} contextToken=${redactToken(contextToken)} textLen=${text.length} mediaUrl=${mediaUrl ? "present" : "none"}`,
          );

          if (debug) {
            debugDeliveries.push({
              textLen: text.length,
              media: mediaUrl ? "present" : "none",
              preview: `${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`,
              ts: Date.now(),
            });
          }

          const sendingResult = await applyWeixinMessageSendingHook({
            to: ctx.To,
            text,
            accountId: deps.accountId,
            mediaUrl,
            runId,
          });
          if (sendingResult.cancelled) {
            logger.info(`outbound: cancelled by message_sending hook to=${ctx.To}`);
            return;
          }
          text = sendingResult.text;
          deps.abortSignal?.throwIfAborted();

          try {
            if (mediaUrl) {
              let filePath: string;
              if (!mediaUrl.includes("://") || mediaUrl.startsWith("file://")) {
                if (mediaUrl.startsWith("file://")) {
                  filePath = new URL(mediaUrl).pathname;
                } else if (!path.isAbsolute(mediaUrl)) {
                  filePath = path.resolve(mediaUrl);
                  logger.debug(`outbound: resolved relative path ${mediaUrl} -> ${filePath}`);
                } else {
                  filePath = mediaUrl;
                }
                logger.debug(`outbound: local file path resolved filePath=${filePath}`);
              } else if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
                logger.debug(`outbound: downloading remote mediaUrl=${mediaUrl.slice(0, 80)}...`);
                filePath = await downloadRemoteImageToTemp(mediaUrl, MEDIA_OUTBOUND_TEMP_DIR, {
                  ...downloadPolicy,
                  abortSignal: deps.abortSignal,
                });
                logger.debug(`outbound: remote image downloaded to filePath=${filePath}`);
              } else {
                logger.warn(
                  `outbound: unrecognized mediaUrl scheme, sending text only mediaUrl=${mediaUrl.slice(0, 80)}`,
                );
                await sendMessageWeixin({
                  to: ctx.To,
                  text,
                  opts: {
                    baseUrl: deps.baseUrl,
                    token: deps.token,
                    abortSignal: deps.abortSignal,
                    contextToken,
                    runId,
                    accountId: deps.accountId,
                  },
                });
                visibleFinalDelivered ||= info.kind === "final" && text.trim().length > 0;
                emitWeixinMessageSent({
                  to: ctx.To,
                  content: text,
                  success: true,
                  accountId: deps.accountId,
                  runId,
                });
                logger.info(`outbound: text sent to=${ctx.To}`);
                return;
              }
              await sendWeixinMediaFile({
                filePath,
                to: ctx.To,
                text,
                opts: {
                  baseUrl: deps.baseUrl,
                  token: deps.token,
                  abortSignal: deps.abortSignal,
                  contextToken,
                  runId,
                  accountId: deps.accountId,
                },
                cdnBaseUrl: deps.cdnBaseUrl,
              });
              visibleFinalDelivered ||= info.kind === "final";
              emitWeixinMessageSent({
                to: ctx.To,
                content: text,
                success: true,
                accountId: deps.accountId,
                runId,
              });
              logger.info(`outbound: media sent OK to=${ctx.To}`);
            } else {
              logger.debug(`outbound: sending text message to=${ctx.To}`);
              await sendMessageWeixin({
                to: ctx.To,
                text,
                opts: {
                  baseUrl: deps.baseUrl,
                  token: deps.token,
                  abortSignal: deps.abortSignal,
                  contextToken,
                  runId,
                  accountId: deps.accountId,
                },
              });
              visibleFinalDelivered ||= info.kind === "final" && text.trim().length > 0;
              emitWeixinMessageSent({
                to: ctx.To,
                content: text,
                success: true,
                accountId: deps.accountId,
                runId,
              });
              logger.info(`outbound: text sent OK to=${ctx.To}`);
            }
          } catch (err) {
            deliveryFailure = err;
            emitWeixinMessageSent({
              to: ctx.To,
              content: text,
              success: false,
              error: String(err),
              accountId: deps.accountId,
              runId,
            });
            logger.error(
              `outbound: FAILED to=${ctx.To} mediaUrl=${mediaUrl ?? "none"} err=${String(err)} stack=${(err as Error).stack ?? ""}`,
            );
            throw err;
          }
        },
        onError: (err, info) => {
          if (
            deps.abortSignal?.aborted ||
            failureNoticeSent ||
            (visibleFinalDelivered && err !== deliveryFailure)
          )
            return;
          deps.errLog(`weixin reply ${info.kind}: ${String(err)}`);
          if (!resolveErrorNoticesEnabled(deps.config)) return;
          failureNoticeSent = true;
          const errMsg = err instanceof Error ? err.message : String(err);
          let notice: string;
          if (errMsg.includes("remote media download failed") || errMsg.includes("fetch")) {
            notice = `⚠️ 媒体文件下载失败，请检查链接是否可访问。`;
          } else if (
            errMsg.includes("getUploadUrl") ||
            errMsg.includes("CDN upload") ||
            errMsg.includes("upload_param")
          ) {
            notice = `⚠️ 媒体文件上传失败，请稍后重试。`;
          } else {
            notice = "⚠️ 本次回复未能正常送达。";
          }
          failureNotice = sendWeixinErrorNotice({
            config: deps.config,
            abortSignal: deps.abortSignal,
            to: ctx.To,
            contextToken,
            message: notice,
            baseUrl: deps.baseUrl,
            token: deps.token,
            runId,
            accountId: deps.accountId,
            errLog: deps.errLog,
          });
        },
      });

    logger.debug(`dispatchReplyFromConfig: starting agentId=${route.agentId ?? "(none)"}`);
    try {
      deps.abortSignal?.throwIfAborted();
      deps.beforeExecute?.();
      await deps.channelRuntime.reply.withReplyDispatcher({
        dispatcher,
        run: () =>
          deps.channelRuntime.reply.dispatchReplyFromConfig(
            withPublishedModelRuntime({
              ctx: finalized,
              cfg: deps.config,
              dispatcher,
              replyOptions: {
                ...replyOptions,
                ...(replyProgressSender?.replyOptions ?? {}),
                disableBlockStreaming: true,
                abortSignal: deps.abortSignal,
              },
            }),
          ),
      });
      logger.debug(`dispatchReplyFromConfig: done agentId=${route.agentId ?? "(none)"}`);
    } finally {
      markDispatchIdle();
      await replyProgressSender?.finalize();

      logger.info(
        `debug-check: accountId=${deps.accountId} debug=${String(debug)} hasContextToken=${Boolean(contextToken)}`,
      );

      if (debug && contextToken && !deps.abortSignal?.aborted) {
        const dispatchDoneAt = Date.now();
        const eventTs = full.create_time_ms ?? 0;
        const platformDelay = eventTs > 0 ? `${receivedAt - eventTs}ms` : "N/A";
        const inboundProcessMs = (debugTs.preDispatch ?? receivedAt) - receivedAt;
        const aiMs = dispatchDoneAt - (debugTs.preDispatch ?? receivedAt);
        const totalTime =
          eventTs > 0 ? `${dispatchDoneAt - eventTs}ms` : `${dispatchDoneAt - receivedAt}ms`;

        if (debugDeliveries.length > 0) {
          debugTrace.push("── 回复 ──");
          for (const d of debugDeliveries) {
            debugTrace.push(`│ textLen=${d.textLen} media=${d.media}`, `│ text="${d.preview}"`);
          }
          const firstTs = debugDeliveries[0].ts;
          debugTrace.push(`│ deliver耗时: ${dispatchDoneAt - firstTs}ms`);
        } else {
          debugTrace.push("── 回复 ──", "│ (deliver未捕获)");
        }

        debugTrace.push(
          "── 耗时 ──",
          `├ 平台→插件: ${platformDelay}`,
          `├ 入站处理(auth+route+media): ${inboundProcessMs}ms (mediaDownload: ${mediaDownloadMs}ms)`,
          `├ AI生成+回复: ${aiMs}ms`,
          `├ 总耗时: ${totalTime}`,
          `└ eventTime: ${eventTs > 0 ? new Date(eventTs).toISOString() : "N/A"}`,
        );

        const timingText = `⏱ Debug 全链路\n${debugTrace.join("\n")}`;

        logger.info(`debug-timing: sending to=${ctx.To}`);
        try {
          await sendMessageWeixin({
            to: ctx.To,
            text: timingText,
            opts: {
              baseUrl: deps.baseUrl,
              token: deps.token,
              abortSignal: deps.abortSignal,
              contextToken,
              runId,
              accountId: deps.accountId,
            },
          });
          logger.info(`debug-timing: sent OK`);
        } catch (debugErr) {
          logger.error(`debug-timing: send FAILED err=${String(debugErr)}`);
        }
      }
    }
  } catch (err) {
    logger.error(`inbound processing failed: ${String(err)}`);
    // Only a cancelled channel is silent. Internal AbortError/TimeoutError is a failure.
    if (
      !failureNoticeSent &&
      (!visibleFinalDelivered || err === deliveryFailure) &&
      !deps.abortSignal?.aborted &&
      resolveErrorNoticesEnabled(deps.config)
    ) {
      failureNoticeSent = true;
      await sendWeixinErrorNotice({
        config: deps.config,
        abortSignal: deps.abortSignal,
        to: ctx.To,
        contextToken,
        message: "⚠️ 本次请求处理失败，未能正常返回结果。",
        baseUrl: deps.baseUrl,
        token: deps.token,
        runId,
        accountId: deps.accountId,
        errLog: deps.errLog,
      });
    }
    throw err;
  } finally {
    // Keep dispatcher error delivery owned until the notice has settled.
    try {
      await failureNotice;
    } finally {
      try {
        if (
          preparationFailures &&
          !failureNoticeSent &&
          !deps.abortSignal?.aborted &&
          resolveErrorNoticesEnabled(deps.config)
        ) {
          await sendWeixinErrorNotice({
            config: deps.config,
            abortSignal: deps.abortSignal,
            to: senderId,
            contextToken,
            message: `⚠️ 有 ${preparationFailures} 条消息未能完成处理。`,
            baseUrl: deps.baseUrl,
            token: deps.token,
            runId,
            accountId: deps.accountId,
            errLog: deps.errLog,
          });
        }
      } finally {
        for (const item of prepared) item.release();
      }
    }
  }
}
