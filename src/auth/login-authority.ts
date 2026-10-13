import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";

/**
 * Optional public request-lifetime fields verified in published OpenClaw 2026.9.9.
 * The plugin's 2026.8.1 development SDK predates them. Keep CLI compatibility,
 * but never grant browser login authority when the host lacks the live predicate.
 */
type PublishedCurrentClient = NonNullable<
  Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0]["client"]
> & {
  invalidated?: boolean;
  connectionSignal?: AbortSignal;
};

export type PublishedWeixinLoginRequest = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0] & {
  client: PublishedCurrentClient | null;
  hasCurrentClientAuthority?: () => boolean;
};

type PublishedWeixinLoginScope = NonNullable<
  ReturnType<typeof getPluginRuntimeGatewayRequestScope>
> & {
  client?: PublishedCurrentClient | null;
  signal?: AbortSignal;
  hasCurrentClientAuthority?: () => boolean;
};

export const WEIXIN_PAGE_LOGIN_UPDATE_HOST =
  "Browser Weixin login requires an OpenClaw host with current-client request authority. Update OpenClaw, or use channels login in the CLI.";

export function hasWeixinPageLoginAuthoritySupport(request: {
  hasCurrentClientAuthority?: () => boolean;
}): boolean {
  return typeof request.hasCurrentClientAuthority === "function";
}

/** Capture the host's existing request authority rather than trusting a QR key. */
export async function captureWeixinWebLoginAuthority(): Promise<{
  assertCurrent: () => void;
  signal?: AbortSignal;
}> {
  // This published accessor is kept off plugin startup and CLI registration.
  const { getPluginRuntimeGatewayRequestScope } =
    await import("openclaw/plugin-sdk/plugin-runtime");
  const scope: PublishedWeixinLoginScope | undefined = getPluginRuntimeGatewayRequestScope();
  if (scope && !hasWeixinPageLoginAuthoritySupport(scope))
    throw new Error(WEIXIN_PAGE_LOGIN_UPDATE_HOST);
  const client = scope?.client;
  const assertCurrent = () => {
    if (
      !scope ||
      !client ||
      client.invalidated ||
      client.connectionSignal?.aborted ||
      scope.signal?.aborted ||
      (client.connect.role ?? "operator") !== "operator" ||
      !client.connect.scopes?.includes("operator.admin") ||
      scope.hasCurrentClientAuthority?.() !== true
    ) {
      throw new Error("微信连接的管理员权限或连接已失效，请重新打开页面连接。");
    }
  };
  assertCurrent();
  const signals = [scope?.signal, client?.connectionSignal].filter(
    (value): value is AbortSignal => value !== undefined,
  );
  return { assertCurrent, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) };
}
