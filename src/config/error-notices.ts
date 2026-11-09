import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

export const WEIXIN_ERROR_NOTICE_PREFIX = "weixin-error-";
export const WEIXIN_ERROR_NOTICE_SENDER = "openclaw-weixin:error-notice";

/** User-visible failure notices require an explicit channel opt-in. */
export function resolveErrorNoticesEnabled(cfg: OpenClawConfig | undefined): boolean {
  const section = cfg?.channels?.["openclaw-weixin"] as { errorNotices?: boolean } | undefined;
  return section?.errorNotices === true;
}
