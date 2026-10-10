import { afterEach, describe, expect, it, vi } from "vitest";
const host = vi.hoisted(() => ({ scope: undefined as unknown }));
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => host.scope,
}));
import { captureWeixinWebLoginAuthority } from "./login-authority.js";

describe("captured host admin authority", () => {
  afterEach(() => {
    host.scope = undefined;
  });
  it("fails closed without a host request and retains the current client's revocable authority", async () => {
    await expect(captureWeixinWebLoginAuthority()).rejects.toThrow("已失效");
    const client = {
      connect: { role: "operator", scopes: ["operator.admin"] },
      invalidated: false,
    };
    let current = true;
    host.scope = { client, hasCurrentClientAuthority: () => current };
    const authority = await captureWeixinWebLoginAuthority();
    authority.assertCurrent();
    current = false;
    expect(authority.assertCurrent).toThrow("已失效");
    current = true;
    client.connect.scopes = ["operator.read"];
    expect(authority.assertCurrent).toThrow("已失效");
  });
  it("connection close aborts request work and prohibits credential effects even without a cancel RPC", async () => {
    const connection = new AbortController();
    host.scope = {
      client: { connect: { scopes: ["operator.admin"] }, connectionSignal: connection.signal },
      hasCurrentClientAuthority: () => true,
    };
    const authority = await captureWeixinWebLoginAuthority();
    connection.abort();
    expect(authority.signal?.aborted).toBe(true);
    expect(authority.assertCurrent).toThrow("已失效");
  });
  it("requires an updated host for a legacy scope without live authority", async () => {
    host.scope = { client: { connect: { role: "operator", scopes: ["operator.admin"] } } };
    await expect(captureWeixinWebLoginAuthority()).rejects.toThrow("Update OpenClaw");
  });
});
