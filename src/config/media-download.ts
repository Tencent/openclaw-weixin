import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

export const DEFAULT_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
export const MAX_DOWNLOAD_TIMEOUT_MS = 2_147_483_647;

export type MediaDownloadPolicy = {
  timeoutMs: number;
  idleTimeoutMs: number;
};

/** Zero disables the total deadline; inactivity remains bounded. */
export function resolveMediaDownloadPolicy(cfg: OpenClawConfig): MediaDownloadPolicy {
  const section = cfg.channels?.["openclaw-weixin"] as
    | { mediaDownload?: Partial<MediaDownloadPolicy> }
    | undefined;
  return {
    timeoutMs: section?.mediaDownload?.timeoutMs ?? 0,
    idleTimeoutMs: section?.mediaDownload?.idleTimeoutMs ?? DEFAULT_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS,
  };
}
