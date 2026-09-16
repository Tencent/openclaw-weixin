import type { PluginRuntime } from "openclaw/plugin-sdk/core";

type DispatchReplyFromConfig = PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"];
type DispatchReplyParams = Parameters<DispatchReplyFromConfig>[0];

/**
 * Bind a channel turn to the Gateway's committed model-runtime owner.
 *
 * OpenClaw 2026.9.x rejects the legacy low-level dispatch path when the
 * caller's config object is not the exact published model-runtime owner. The
 * modern channel inbound pipeline sets this flag automatically; Weixin still
 * assembles its own dispatcher, so it must opt in explicitly until that path
 * is migrated to channelRuntime.inbound.dispatch.
 */
export function withPublishedModelRuntime(
  params: DispatchReplyParams,
): DispatchReplyParams & { usePublishedModelRuntime: true } {
  return {
    ...params,
    usePublishedModelRuntime: true,
  };
}
