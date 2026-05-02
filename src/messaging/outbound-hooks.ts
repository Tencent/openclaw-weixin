import {
  fireAndForgetHook,
  buildCanonicalSentMessageHookContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from "openclaw/plugin-sdk/hook-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";

import { logger } from "../util/logger.js";

const CHANNEL_ID = "openclaw-weixin";

/**
 * Run message_sending hook before sending.
 * Returns the (possibly modified) text content plus a cancelled flag.
 * Hook errors are caught and logged — sending proceeds regardless.
 */
export async function applyWeixinMessageSendingHook(params: {
  to: string;
  text: string;
  accountId?: string;
  mediaUrl?: string;
}): Promise<{ cancelled: boolean; text: string }> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("message_sending")) {
    return { cancelled: false, text: params.text };
  }
  try {
    const hookResult = await hookRunner.runMessageSending(
      {
        to: params.to,
        content: params.text,
        metadata: {
          channel: CHANNEL_ID,
          accountId: params.accountId,
          ...(params.mediaUrl ? { mediaUrls: [params.mediaUrl] } : {}),
        },
      },
      { channelId: CHANNEL_ID, accountId: params.accountId },
    );
    if (hookResult?.cancel) {
      return { cancelled: true, text: params.text };
    }
    return {
      cancelled: false,
      text: hookResult?.content ?? params.text,
    };
  } catch (err) {
    logger.warn(`message_sending hook error, proceeding with send: ${String(err)}`);
    return { cancelled: false, text: params.text };
  }
}

/**
 * Fire message_sent hook (fire-and-forget) after a send attempt.
 */
export function emitWeixinMessageSent(params: {
  to: string;
  content: string;
  success: boolean;
  error?: string;
  accountId?: string;
}): void {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("message_sent")) return;
  const canonical = buildCanonicalSentMessageHookContext({
    to: params.to,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: CHANNEL_ID,
    accountId: params.accountId,
    conversationId: params.to,
  });
  fireAndForgetHook(
    Promise.resolve(
      hookRunner!.runMessageSent(
        toPluginMessageSentEvent(canonical),
        toPluginMessageContext(canonical),
      ),
    ),
    "weixin: message_sent plugin hook failed",
  );
}
