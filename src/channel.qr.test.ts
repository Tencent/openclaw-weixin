import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ scope: undefined as unknown }));
const network = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const accounts = vi.hoisted(() => ({
  save: vi.fn(),
  register: vi.fn(),
  stale: vi.fn(),
  stored: new Map<string, { token: string }>(),
}));
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => host.scope,
  getGlobalHookRunner: () => undefined,
}));
vi.mock("./api/api.js", () => ({
  apiGetFetch: network.get,
  apiPostFetch: network.post,
  notifyStart: vi.fn(),
  notifyStop: vi.fn(),
}));
vi.mock("./auth/accounts.js", () => ({
  loadWeixinAccount: (id: string) => accounts.stored.get(id),
  listIndexedWeixinAccountIds: () => [...accounts.stored.keys()],
  listWeixinAccountIds: () => [...accounts.stored.keys()],
  resolveWeixinAccount: vi.fn(),
  saveWeixinAccount: accounts.save,
  registerWeixinAccountId: accounts.register,
  clearStaleAccountsForUserId: accounts.stale,
  triggerWeixinChannelReload: vi.fn(),
  DEFAULT_BASE_URL: "https://ilinkai.weixin.qq.com",
}));
vi.mock("./util/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { weixinPlugin } from "./channel.js";
import { disposeWeixinLogins } from "./auth/login-qr.js";

beforeEach(() => {
  vi.clearAllMocks();
  accounts.stored.clear();
  network.post.mockResolvedValue(
    JSON.stringify({
      qrcode: "synthetic-login",
      qrcode_img_content: "https://weixin.qq.com/synthetic-login",
    }),
  );
});
afterEach(() => {
  disposeWeixinLogins();
  host.scope = undefined;
});

describe("registered Weixin browser QR adapters", () => {
  it("refuses old-host start and wait before QR requests or credential changes", async () => {
    host.scope = { client: { connect: { role: "operator", scopes: ["operator.admin"] } } };
    await expect(weixinPlugin.gateway!.loginWithQrStart!({})).rejects.toThrow("Update OpenClaw");
    await expect(
      weixinPlugin.gateway!.loginWithQrWait!({ sessionKey: "synthetic-login" } as never),
    ).rejects.toThrow("Update OpenClaw");
    expect(network.post).not.toHaveBeenCalled();
    expect(network.get).not.toHaveBeenCalled();
    expect(accounts.save).not.toHaveBeenCalled();
  });

  it("publishes PNG/session/expiry and persists only the confirmed account under live authority", async () => {
    host.scope = {
      client: { connect: { role: "operator", scopes: ["operator.admin"] } },
      hasCurrentClientAuthority: () => true,
    };
    const started = await weixinPlugin.gateway!.loginWithQrStart!({
      accountId: "synthetic-im-bot",
    });
    expect(started).toMatchObject({
      qrDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
      sessionKey: expect.any(String),
      expiresAtMs: expect.any(Number),
    });
    const sessionKey = (started as { sessionKey: string }).sessionKey;
    expect(sessionKey).not.toBe("synthetic-im-bot");
    network.get.mockResolvedValue(
      JSON.stringify({
        status: "confirmed",
        ilink_bot_id: "synthetic@im.bot",
        bot_token: "synthetic-token",
        ilink_user_id: "synthetic-user",
      }),
    );
    const connected = await weixinPlugin.gateway!.loginWithQrWait!({
      sessionKey,
      timeoutMs: 1000,
    } as never);
    expect(connected).toMatchObject({ connected: true, accountId: "synthetic-im-bot" });
    expect(connected).not.toHaveProperty("botToken");
    expect(accounts.save).toHaveBeenCalledWith("synthetic-im-bot", {
      token: "synthetic-token",
      baseUrl: undefined,
      userId: "synthetic-user",
    });
    expect(accounts.register).toHaveBeenCalledWith("synthetic-im-bot");
    expect(accounts.stale).toHaveBeenCalledOnce();
  });

  it("does not persist confirmation that arrives after the captured host authority was revoked", async () => {
    let current = true;
    host.scope = {
      client: { connect: { role: "operator", scopes: ["operator.admin"] } },
      hasCurrentClientAuthority: () => current,
    };
    const started = await weixinPlugin.gateway!.loginWithQrStart!({});
    const sessionKey = (started as { sessionKey: string }).sessionKey;
    network.get.mockImplementationOnce(async () => {
      current = false;
      return JSON.stringify({
        status: "confirmed",
        ilink_bot_id: "synthetic@im.bot",
        bot_token: "synthetic-token",
      });
    });
    await expect(weixinPlugin.gateway!.loginWithQrWait!({ sessionKey } as never)).rejects.toThrow(
      "已失效",
    );
    expect(accounts.save).not.toHaveBeenCalled();
    expect(accounts.register).not.toHaveBeenCalled();
  });

  it("refuses a confirmation for a different selected account before saving credentials", async () => {
    host.scope = {
      client: { connect: { scopes: ["operator.admin"] } },
      hasCurrentClientAuthority: () => true,
    };
    const started = await weixinPlugin.gateway!.loginWithQrStart!({
      accountId: "selected-account-a",
    });
    network.get.mockResolvedValue(
      JSON.stringify({
        status: "confirmed",
        ilink_bot_id: "other-account-b",
        bot_token: "synthetic-token-b",
      }),
    );
    expect(
      await weixinPlugin.gateway!.loginWithQrWait!({
        sessionKey: (started as { sessionKey: string }).sessionKey,
        accountId: "selected-account-a",
      } as never),
    ).toMatchObject({ connected: false, message: expect.stringContaining("不一致") });
    expect(accounts.save).not.toHaveBeenCalled();
    expect(accounts.register).not.toHaveBeenCalled();
    expect(accounts.stale).not.toHaveBeenCalled();
  });

  it.each([
    { providerId: undefined, requested: "account-a", expected: false },
    { providerId: "account-b", requested: "account-a", expected: false },
    { providerId: "account-a", requested: "account-a", expected: true },
    { providerId: "account-b", requested: undefined, expected: true },
  ])(
    "binds an already-connected multi-account result to its exact QR generation and selected target: %j",
    async ({ providerId, requested, expected }) => {
      host.scope = {
        client: { connect: { role: "operator", scopes: ["operator.admin"] } },
        hasCurrentClientAuthority: () => true,
      };
      accounts.stored.set("account-a", { token: "synthetic-a-token" });
      accounts.stored.set("account-b", { token: "synthetic-b-token" });
      const started = await weixinPlugin.gateway!.loginWithQrStart!({ accountId: requested });
      expect(JSON.parse(network.post.mock.calls[0][0].body).local_token_list).toEqual([
        "synthetic-b-token",
        "synthetic-a-token",
      ]);
      network.get.mockResolvedValue(
        JSON.stringify({ status: "binded_redirect", ilink_bot_id: providerId }),
      );
      const result = await weixinPlugin.gateway!.loginWithQrWait!({
        sessionKey: (started as { sessionKey: string }).sessionKey,
        accountId: requested,
      } as never);
      expect(result).toMatchObject({ connected: expected, alreadyConnected: true });
      if (expected) expect(result).toHaveProperty("accountId", providerId);
      expect(accounts.save).not.toHaveBeenCalled();
    },
  );

  it.each([
    { requested: undefined, expected: true },
    { requested: "account-b", expected: false },
  ])(
    "requires an unambiguous offered single account to match the selected target: %j",
    async ({ requested, expected }) => {
      host.scope = {
        client: { connect: { scopes: ["operator.admin"] } },
        hasCurrentClientAuthority: () => true,
      };
      accounts.stored.set("account-a", { token: "synthetic-a-token" });
      const started = await weixinPlugin.gateway!.loginWithQrStart!({ accountId: requested });
      network.get.mockResolvedValue(JSON.stringify({ status: "binded_redirect" }));
      const result = await weixinPlugin.gateway!.loginWithQrWait!({
        sessionKey: (started as { sessionKey: string }).sessionKey,
      } as never);
      expect(result).toMatchObject({ connected: expected });
      if (expected) expect(result).toHaveProperty("accountId", "account-a");
    },
  );

  it("rejects a provider identity whose token was never offered to this QR generation", async () => {
    host.scope = {
      client: { connect: { scopes: ["operator.admin"] } },
      hasCurrentClientAuthority: () => true,
    };
    const started = await weixinPlugin.gateway!.loginWithQrStart!({});
    accounts.stored.set("account-c", { token: "synthetic-new-c-token" });
    network.get.mockResolvedValue(
      JSON.stringify({ status: "binded_redirect", ilink_bot_id: "account-c" }),
    );
    expect(
      await weixinPlugin.gateway!.loginWithQrWait!({
        sessionKey: (started as { sessionKey: string }).sessionKey,
      } as never),
    ).toMatchObject({ connected: false });
  });

  it("does not convert an ambiguous generation to a single-account proof after deletion", async () => {
    host.scope = {
      client: { connect: { scopes: ["operator.admin"] } },
      hasCurrentClientAuthority: () => true,
    };
    accounts.stored.set("account-a", { token: "synthetic-a-token" });
    accounts.stored.set("account-b", { token: "synthetic-b-token" });
    const started = await weixinPlugin.gateway!.loginWithQrStart!({ accountId: "account-a" });
    accounts.stored.delete("account-b");
    network.get.mockResolvedValue(JSON.stringify({ status: "binded_redirect" }));
    expect(
      await weixinPlugin.gateway!.loginWithQrWait!({
        sessionKey: (started as { sessionKey: string }).sessionKey,
        accountId: "account-a",
      } as never),
    ).toMatchObject({ connected: false });
  });

  it("rejects credentials removed after QR generation, even when the provider identifies the account", async () => {
    host.scope = {
      client: { connect: { scopes: ["operator.admin"] } },
      hasCurrentClientAuthority: () => true,
    };
    accounts.stored.set("account-a", { token: "synthetic-a-token" });
    const started = await weixinPlugin.gateway!.loginWithQrStart!({});
    accounts.stored.clear();
    network.get.mockResolvedValue(
      JSON.stringify({ status: "binded_redirect", ilink_bot_id: "account-a" }),
    );
    expect(
      await weixinPlugin.gateway!.loginWithQrWait!({
        sessionKey: (started as { sessionKey: string }).sessionKey,
      } as never),
    ).toMatchObject({ connected: false });
  });

  it("captures new offered account IDs on refresh rather than accepting an account introduced after generation", async () => {
    host.scope = {
      client: { connect: { scopes: ["operator.admin"] } },
      hasCurrentClientAuthority: () => true,
    };
    accounts.stored.set("account-a", { token: "synthetic-a-token" });
    const started = await weixinPlugin.gateway!.loginWithQrStart!({});
    const sessionKey = (started as { sessionKey: string }).sessionKey;
    accounts.stored.clear();
    accounts.stored.set("account-b", { token: "synthetic-b-token" });
    network.get
      .mockResolvedValueOnce(JSON.stringify({ status: "expired" }))
      .mockResolvedValueOnce(
        JSON.stringify({ status: "binded_redirect", ilink_bot_id: "account-a" }),
      );
    await weixinPlugin.gateway!.loginWithQrWait!({ sessionKey } as never);
    accounts.stored.set("account-a", { token: "synthetic-rotated-a-token" });
    expect(await weixinPlugin.gateway!.loginWithQrWait!({ sessionKey } as never)).toMatchObject({
      connected: false,
    });
    expect(JSON.parse(network.post.mock.calls[1][0].body).local_token_list).toEqual([
      "synthetic-b-token",
    ]);
    expect(network.post.mock.calls[1][0]).toHaveProperty("timeoutMs", 30000);
  });
});
