import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { controlWeixinLogin, disposeWeixinLogins } from "./login-qr.js";
import {
  hasWeixinPageLoginAuthoritySupport,
  WEIXIN_PAGE_LOGIN_UPDATE_HOST,
} from "./login-authority.js";
import type { PublishedWeixinLoginRequest } from "./login-authority.js";

/** Admin-only capability reads and controls for the same QR login owner. */
export function registerWeixinLoginControl(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    "weixin.login.control",
    (request) => {
      const {
        params,
        client,
        hasCurrentClientAuthority,
        signal,
        sessionMutationCommitGuard,
        respond,
      }: PublishedWeixinLoginRequest = request;
      try {
        if (
          !client ||
          client.invalidated ||
          client.connectionSignal?.aborted ||
          (client.connect.role ?? "operator") !== "operator" ||
          !client.connect.scopes?.includes("operator.admin") ||
          (hasCurrentClientAuthority !== undefined && hasCurrentClientAuthority() !== true)
        ) {
          throw new Error("微信连接需要当前有效的管理员权限。");
        }
        signal?.throwIfAborted();
        sessionMutationCommitGuard?.();
        const { action, sessionKey, code } = params;
        if (action === "capabilities") {
          if (Object.keys(params).length !== 1) throw new Error("微信连接控制参数无效。");
          const supported = hasWeixinPageLoginAuthoritySupport({ hasCurrentClientAuthority });
          respond(true, {
            ok: true,
            supportsPageLogin: supported,
            ...(!supported ? { message: WEIXIN_PAGE_LOGIN_UPDATE_HOST } : {}),
          });
          return;
        }
        if (!hasWeixinPageLoginAuthoritySupport({ hasCurrentClientAuthority }))
          throw new Error(WEIXIN_PAGE_LOGIN_UPDATE_HOST);
        if (
          (action !== "cancel" && action !== "verify") ||
          typeof sessionKey !== "string" ||
          !sessionKey.trim() ||
          sessionKey.length > 200 ||
          Object.keys(params).some((key) => !["action", "sessionKey", "code"].includes(key)) ||
          (action === "cancel" && code !== undefined) ||
          (action === "verify" && (typeof code !== "string" || !/^\d{1,10}$/.test(code)))
        ) {
          throw new Error("微信连接控制参数无效。");
        }
        respond(
          true,
          controlWeixinLogin({ action, sessionKey, ...(typeof code === "string" ? { code } : {}) }),
        );
      } catch (error) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: error instanceof Error ? error.message : "微信连接操作失败。",
        });
      }
    },
    { scope: "operator.admin", profileAccess: "independent" },
  );
  // cleanup is the published lifecycle contract in the baseline SDK. Session
  // resets must not cancel another administrator's account-login operation.
  api.lifecycle.registerRuntimeLifecycle({
    id: "weixin-web-login",
    cleanup: ({ sessionKey }) => {
      if (!sessionKey) disposeWeixinLogins();
    },
  });
}
