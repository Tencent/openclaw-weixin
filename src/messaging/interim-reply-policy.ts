import type { ReplyPayload, ReplyDispatchKind } from "openclaw/plugin-sdk/reply-runtime";

/**
 * WeChat messages cannot be edited or retracted after they are sent. Block
 * commentary emitted between tool calls (assistant narration) is sent verbatim
 * and then merged into the final reply again by the host, so the user would
 * see the same content twice. WeChat therefore uses final-only delivery for
 * these interim blocks: text-only block payloads are suppressed, while
 * anything that is not re-merged into the final reply is still delivered
 * (final payloads, media, errors, tool summaries, approval prompts).
 */
export function isInterimTextOnlyWeixinReply(
  payload: ReplyPayload,
  info?: { kind?: ReplyDispatchKind },
): boolean {
  if (info?.kind !== "block") return false;
  if (!payload.text) return false;
  if (payload.isError === true) return false;
  if (payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0) return false;
  if (hasExecApprovalChannelData(payload)) return false;
  return true;
}

function hasExecApprovalChannelData(payload: ReplyPayload): boolean {
  return payload.channelData?.execApproval != null;
}
