import { describe, expect, it, vi } from "vitest";
const owner = vi.hoisted(() => ({ control: vi.fn(() => ({ ok: true })), dispose: vi.fn() }));
vi.mock("./login-qr.js", () => ({
  controlWeixinLogin: owner.control,
  disposeWeixinLogins: owner.dispose,
}));
import { registerWeixinLoginControl } from "./login-control.js";

describe("registered Weixin login control boundary", () => {
  function register() {
    const registerGatewayMethod = vi.fn();
    const lifecycle = { registerRuntimeLifecycle: vi.fn() };
    registerWeixinLoginControl({ registerGatewayMethod, lifecycle } as never);
    return { registerGatewayMethod, lifecycle, handler: registerGatewayMethod.mock.calls[0][1] };
  }
  it("declares admin scope and rejects non-admin, revoked, and expired authority before owner mutation", () => {
    owner.control.mockClear();
    const { handler, registerGatewayMethod, lifecycle } = register();
    expect(registerGatewayMethod.mock.calls[0][0]).toBe("weixin.login.control");
    expect(registerGatewayMethod.mock.calls[0][2]).toEqual({
      scope: "operator.admin",
      profileAccess: "independent",
    });
    expect(lifecycle.registerRuntimeLifecycle.mock.calls[0][0].cleanup).toBeTypeOf("function");
    for (const client of [
      null,
      { connect: { scopes: ["operator.read"] } },
      { invalidated: true, connect: { scopes: ["operator.admin"] } },
    ]) {
      const respond = vi.fn();
      handler({ params: { action: "cancel", sessionKey: "session" }, client, respond });
      expect(respond.mock.calls[0][0]).toBe(false);
    }
    handler({
      params: { action: "cancel", sessionKey: "session" },
      client: { connect: { scopes: ["operator.admin"] } },
      hasCurrentClientAuthority: () => false,
      respond: vi.fn(),
    });
    expect(owner.control).not.toHaveBeenCalled();
  });
  it("validates input and forwards exact login identity/code under current admin authority", () => {
    owner.control.mockClear();
    const { handler } = register();
    const client = { connect: { role: "operator", scopes: ["operator.admin"] } };
    for (const params of [
      { action: "verify", sessionKey: "session", code: "123", extra: true },
      { action: "verify", sessionKey: "session", code: "abc" },
      { action: "cancel", sessionKey: "" },
    ]) {
      handler({ params, client, respond: vi.fn() });
    }
    expect(owner.control).not.toHaveBeenCalled();
    const respond = vi.fn();
    handler({
      params: { action: "verify", sessionKey: "exact-session", code: "0123" },
      client,
      hasCurrentClientAuthority: () => true,
      respond,
    });
    expect(owner.control).toHaveBeenCalledWith({
      action: "verify",
      sessionKey: "exact-session",
      code: "0123",
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("reads page-login capability without touching the login owner or disposal", () => {
    owner.control.mockClear();
    owner.dispose.mockClear();
    const { handler } = register();
    const respond = vi.fn();
    handler({
      params: { action: "capabilities" },
      client: { connect: { role: "operator", scopes: ["operator.admin"] } },
      hasCurrentClientAuthority: () => true,
      respond,
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true, supportsPageLogin: true });
    expect(owner.control).not.toHaveBeenCalled();
    expect(owner.dispose).not.toHaveBeenCalled();
  });

  it("reports unsupported page login on legacy hosts without granting control authority", () => {
    owner.control.mockClear();
    owner.dispose.mockClear();
    const { handler } = register();
    const client = { connect: { role: "operator", scopes: ["operator.admin"] } };
    const respond = vi.fn();
    handler({ params: { action: "capabilities" }, client, respond });
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      supportsPageLogin: false,
      message: expect.stringContaining("Update OpenClaw"),
    });
    const controlResponse = vi.fn();
    handler({
      params: { action: "cancel", sessionKey: "session" },
      client,
      respond: controlResponse,
    });
    expect(controlResponse.mock.calls[0][0]).toBe(false);
    expect(owner.control).not.toHaveBeenCalled();
    expect(owner.dispose).not.toHaveBeenCalled();
  });

  it("cleans up login operations on host cleanup without cancelling another session's reset", () => {
    owner.dispose.mockClear();
    const { lifecycle } = register();
    const registration = lifecycle.registerRuntimeLifecycle.mock.calls[0][0];
    registration.cleanup({ reason: "reset", sessionKey: "unrelated-session" });
    expect(owner.dispose).not.toHaveBeenCalled();
    registration.cleanup({ reason: "restart" });
    expect(owner.dispose).toHaveBeenCalledOnce();
  });

  it("rejects capability probes with any additional field", () => {
    owner.control.mockClear();
    const { handler } = register();
    for (const extra of [
      { sessionKey: "session" },
      { sessionKey: undefined },
      { code: "1234" },
      { extra: true },
    ]) {
      const respond = vi.fn();
      handler({
        params: { action: "capabilities", ...extra },
        client: { connect: { scopes: ["operator.admin"] } },
        respond,
      });
      expect(respond.mock.calls[0][0]).toBe(false);
    }
    expect(owner.control).not.toHaveBeenCalled();
  });

  it("requires current admin authority and an unaborted request for capability reads", () => {
    owner.control.mockClear();
    const { handler } = register();
    const aborted = new AbortController();
    aborted.abort();
    for (const context of [
      { client: null },
      { client: { connect: { scopes: ["operator.read"] } } },
      { client: { invalidated: true, connect: { scopes: ["operator.admin"] } } },
      { client: { connect: { scopes: ["operator.admin"] }, connectionSignal: aborted.signal } },
      {
        client: { connect: { scopes: ["operator.admin"] } },
        hasCurrentClientAuthority: () => false,
      },
      { client: { connect: { scopes: ["operator.admin"] } }, signal: aborted.signal },
    ]) {
      const respond = vi.fn();
      handler({ params: { action: "capabilities" }, ...context, respond });
      expect(respond.mock.calls[0][0]).toBe(false);
    }
    expect(owner.control).not.toHaveBeenCalled();
  });
});
