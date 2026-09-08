import { isSilentReplyText } from "openclaw/plugin-sdk/reply-runtime";

/**
 * True when outbound text is an OpenClaw silent-reply token (`NO_REPLY` /
 * `no_reply`, case-insensitive exact match) and must not be delivered as a
 * user-visible WeChat message.
 *
 * Mirrors the host silent-token gate used on other OpenClaw delivery paths.
 * Media-only deliveries should still proceed after clearing the silent text.
 */
export function isSilentOutboundText(text: string | undefined): boolean {
  return isSilentReplyText(text);
}
