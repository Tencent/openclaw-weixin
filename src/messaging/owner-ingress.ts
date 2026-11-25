import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { MessageType } from "../api/types.js";
import type { WeixinMsgContext } from "./inbound.js";
import type { PreparedInboundMessage } from "./prepare-inbound.js";

type ChannelRuntime = PluginRuntime["channel"];

export async function buildWeixinInboundContext(
  runtime: ChannelRuntime,
  route: ReturnType<ChannelRuntime["routing"]["resolveAgentRoute"]>,
  ctx: WeixinMsgContext,
  sources: PreparedInboundMessage[],
  boundUserId: string | undefined,
) {
  // Older supported hosts expose the policy function but lack a registered ingress runtime.
  const inbound: ChannelRuntime["inbound"] & {
    ingress?: { resolveStable: typeof resolveStableChannelMessageIngress };
  } = runtime.inbound;
  // Only a user DM from the transport account bound by QR login carries this identity.
  // The host decides separately whether that identity is an OpenClaw owner.
  if (
    !inbound?.ingress?.resolveStable ||
    !boundUserId ||
    !sources.every(
      ({ message }) =>
        message.message_type === MessageType.USER &&
        !message.group_id &&
        message.from_user_id === boundUserId,
    )
  ) {
    return runtime.reply.finalizeInboundContext(ctx);
  }

  const conversation = { kind: "direct" as const, id: boundUserId };
  const admitted = [];
  for (const source of sources) {
    const result = await inbound.ingress.resolveStable({
      channelId: "openclaw-weixin",
      accountId: ctx.AccountId,
      identity: { key: "stableId", authentication: "verified", sensitivity: "pii" },
      subject: { stableId: source.message.from_user_id },
      conversation,
      dmPolicy: "allowlist",
      allowFrom: [boundUserId],
      useDefaultPairingStore: false,
      contextBinding: {
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        messageId: source.ctx.MessageSidFull ?? source.ctx.MessageSid,
        inboundEventKind: "user_request",
      },
    });
    if (result.ingress.admission !== "dispatch") return;
    admitted.push(result);
  }

  const last = sources[sources.length - 1].ctx;
  const paths = ctx.MediaPaths ?? (ctx.MediaPath ? [ctx.MediaPath] : []);
  return inbound.buildContext({
    channelIngress: admitted,
    channel: "openclaw-weixin",
    accountId: ctx.AccountId,
    messageId: last.MessageSidFull ?? last.MessageSid,
    messageIdFull: last.MessageSidFull,
    timestamp: ctx.Timestamp,
    from: ctx.From,
    sender: { id: boundUserId },
    conversation,
    route: { agentId: route.agentId, routeSessionKey: route.sessionKey },
    reply: { to: ctx.To, replyToId: ctx.ReplyToId },
    message: { rawBody: ctx.Body, commandBody: ctx.CommandBody },
    access: { commands: { authorized: ctx.CommandAuthorized === true } },
    media:
      ctx.media ??
      paths.map((path, i) => ({ path, contentType: ctx.MediaTypes?.[i] ?? ctx.MediaType })),
    extra: {
      ReplyToBody: ctx.ReplyToBody,
      ReplyToQuoteText: ctx.ReplyToQuoteText,
      ReplyToIsQuote: ctx.ReplyToIsQuote,
      ChannelPromptContext: ctx.ChannelPromptContext,
    },
    finalize: runtime.reply.finalizeInboundContext,
  });
}
