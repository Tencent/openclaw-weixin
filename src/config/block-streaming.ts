import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

type WeixinBlockStreamingConfig = {
  blockStreaming?: boolean;
  accounts?: Record<string, { blockStreaming?: boolean }>;
};

export function resolveWeixinBlockStreamingEnabled(
  cfg: OpenClawConfig,
  accountId: string,
): boolean {
  const section = cfg.channels?.["openclaw-weixin"] as WeixinBlockStreamingConfig | undefined;
  return section?.accounts?.[accountId]?.blockStreaming ?? section?.blockStreaming ?? true;
}
