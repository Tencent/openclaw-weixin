import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigRouteTag } = vi.hoisted(() => ({
  loadConfigRouteTag: vi.fn((): string | undefined => undefined),
}));

vi.mock("./accounts.js", () => ({
  loadConfigAcctwebBaseUrl: () => undefined,
  loadConfigAcctwebProxy: () => undefined,
  loadConfigRouteTag: () => loadConfigRouteTag(),
}));

import { ProxyAgent } from "undici";

import {
  BotSpamTicketError,
  cradleHostname,
  fetchBotSpamTicket,
  parseBotSpamAuthStatus,
  parseBotSpamTicketContext,
  queryBotSpamAuthResult,
  resolveAcctwebOrigin,
  resolveAcctwebProxy,
  waitForBotSpamAuth,
} from "./bot-spam-ticket.js";

const TICKET = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const AUTH_URL = `liteapp://wxalite41747693cb27020d46b1ee0c8c29e3f3/pages/realname-verify/entry?bot_spam_ticket=${TICKET}`;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

describe("cradleHostname", () => {
  it("prefixes the route tag with g", () => {
    expect(cradleHostname("10086")).toBe("g10086");
    expect(cradleHostname("g10086")).toBe("g10086");
    expect(cradleHostname(undefined)).toBeUndefined();
  });
});

describe("resolveAcctwebOrigin", () => {
  it("keeps the public origin when unset", () => {
    expect(resolveAcctwebOrigin(undefined)).toBe("https://weixin110.qq.com");
    expect(resolveAcctwebOrigin("  ")).toBe("https://weixin110.qq.com");
  });

  it("uses the configured host and port and drops any CGI path", () => {
    expect(resolveAcctwebOrigin("http://10.1.2.3:8088")).toBe("http://10.1.2.3:8088");
    expect(resolveAcctwebOrigin("http://10.1.2.3:8088/security/acct/botrealnameverifycgi")).toBe(
      "http://10.1.2.3:8088",
    );
  });

  it("rejects a non-http origin", () => {
    expect(() => resolveAcctwebOrigin("ftp://10.1.2.3:8088")).toThrow(
      "绑定接口地址配置无效，连接已停止。",
    );
  });
});

describe("resolveAcctwebProxy", () => {
  it("sends directly when unset", () => {
    expect(resolveAcctwebProxy(undefined)).toBeUndefined();
    expect(resolveAcctwebProxy("  ")).toBeUndefined();
  });

  it("keeps the proxy origin and drops a path", () => {
    expect(resolveAcctwebProxy("http://10.1.2.3:8088")).toBe("http://10.1.2.3:8088");
    expect(resolveAcctwebProxy("http://10.1.2.3:8088/ignored")).toBe("http://10.1.2.3:8088");
  });

  it("rejects a non-http proxy", () => {
    expect(() => resolveAcctwebProxy("ftp://10.1.2.3:8088")).toThrow(
      "绑定代理地址配置无效，连接已停止。",
    );
  });
});

describe("fetchBotSpamTicket", () => {
  afterEach(() => {
    loadConfigRouteTag.mockReset();
    loadConfigRouteTag.mockReturnValue(undefined);
    vi.restoreAllMocks();
  });

  it("returns the server ticket unchanged", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        bot_spam_ticket: TICKET,
        auth_url: AUTH_URL,
        expire_time: 1_800_000_000,
      }),
    );
    const got = await fetchBotSpamTicket({
      pluginVersion: "2.4.10",
      fetchImpl,
      nowSec: 1_700_000_000,
    });
    expect(got).toEqual({
      botSpamTicket: TICKET,
      authUrl: AUTH_URL,
      expireTimeSec: 1_800_000_000,
    });
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.origin).toBe("https://weixin110.qq.com");
    expect(url.pathname).toBe("/security/acct/botrealnameverifycgi");
    expect(url.searchParams.get("step")).toBe("get_auth_url");
    expect(url.searchParams.get("plugin_version")).toBe("2.4.10");
    expect(url.searchParams.get("_cradle_hostname")).toBeNull();
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: "GET",
      headers: { Accept: "application/json" },
    });
  });

  it("calls the office-network origin on port 8088 when configured", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        bot_spam_ticket: TICKET,
        auth_url: AUTH_URL,
        expire_time: 1_800_000_000,
      }),
    );
    await fetchBotSpamTicket({
      pluginVersion: "3.0.0-dev-001",
      fetchImpl,
      nowSec: 1_700_000_000,
      acctwebOrigin: "http://10.1.2.3:8088",
    });
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.origin).toBe("http://10.1.2.3:8088");
    expect(url.pathname).toBe("/security/acct/botrealnameverifycgi");
    expect(url.searchParams.get("step")).toBe("get_auth_url");
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty("dispatcher");
  });

  it("sends the public origin through an HTTP proxy", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        bot_spam_ticket: TICKET,
        auth_url: AUTH_URL,
        expire_time: 1_800_000_000,
      }),
    );
    await fetchBotSpamTicket({
      pluginVersion: "3.0.0-dev-003",
      fetchImpl,
      nowSec: 1_700_000_000,
      acctwebProxy: "http://10.1.2.3:8088",
    });
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.origin).toBe("https://weixin110.qq.com");
    expect(url.pathname).toBe("/security/acct/botrealnameverifycgi");
    expect(fetchImpl.mock.calls[0][1]?.dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it("reads the ticket from a data envelope when expire_time is a string", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ret: 0,
        data: {
          bot_spam_ticket: TICKET,
          auth_url: AUTH_URL,
          expire_time: "1800000000",
        },
      }),
    );
    const got = await fetchBotSpamTicket({
      pluginVersion: "3.0.0-dev-003",
      fetchImpl,
      nowSec: 1_700_000_000,
    });
    expect(got).toEqual({
      botSpamTicket: TICKET,
      authUrl: AUTH_URL,
      expireTimeSec: 1_800_000_000,
    });
  });

  it("appends _cradle_hostname when a route tag is configured", async () => {
    loadConfigRouteTag.mockReturnValue("10086");
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        bot_spam_ticket: TICKET,
        auth_url: AUTH_URL,
        expire_time: 1_800_000_000,
      }),
    );
    await fetchBotSpamTicket({
      pluginVersion: "3.0.0-dev-001",
      fetchImpl,
      nowSec: 1_700_000_000,
    });
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.origin).toBe("https://weixin110.qq.com");
    expect(url.searchParams.get("_cradle_hostname")).toBe("g10086");
  });

  it("rejects a non-zero ret even if a ticket is present", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ret: 1,
        bot_spam_ticket: TICKET,
        auth_url: AUTH_URL,
        expire_time: 1_800_000_000,
      }),
    );
    await expect(
      fetchBotSpamTicket({
        pluginVersion: "2.4.10",
        fetchImpl,
        nowSec: 1_700_000_000,
      }),
    ).rejects.toBeInstanceOf(BotSpamTicketError);
  });

  it("rejects an expired ticket", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        bot_spam_ticket: TICKET,
        auth_url: AUTH_URL,
        expire_time: 1_600_000_000,
      }),
    );
    await expect(
      fetchBotSpamTicket({
        pluginVersion: "2.4.10",
        fetchImpl,
        nowSec: 1_700_000_000,
      }),
    ).rejects.toBeInstanceOf(BotSpamTicketError);
  });
});

describe("waitForBotSpamAuth", () => {
  it("keeps polling while pending and returns on pass", async () => {
    const query = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const sleep = vi.fn(async () => {});
    const got = await waitForBotSpamAuth({
      ticket: { botSpamTicket: TICKET, authUrl: AUTH_URL, expireTimeSec: 1_800_000_000 },
      nowMs: () => 1_700_000_000_000,
      sleep,
      query,
      deadlineMs: 1_700_000_600_000,
    });
    expect(got.botSpamTicket).toBe(TICKET);
    expect(query).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("stops on auth failure without refreshing", async () => {
    const refreshTicket = vi.fn();
    await expect(
      waitForBotSpamAuth({
        ticket: { botSpamTicket: TICKET, authUrl: AUTH_URL, expireTimeSec: 1_800_000_000 },
        nowMs: () => 1_700_000_000_000,
        sleep: async () => {},
        query: async () => 2,
        refreshTicket,
        deadlineMs: 1_700_000_600_000,
      }),
    ).rejects.toThrow("实名授权未通过，无法连接。");
    expect(refreshTicket).not.toHaveBeenCalled();
  });

  it("refreshes once on invalid ticket and then fails", async () => {
    const next = {
      botSpamTicket: "aabbccddeeff00112233445566778899",
      authUrl: AUTH_URL,
      expireTimeSec: 1_800_000_100,
    };
    const query = vi.fn().mockResolvedValue(3);
    const refreshTicket = vi.fn(async () => next);
    const onTicketReplaced = vi.fn(async () => {});
    await expect(
      waitForBotSpamAuth({
        ticket: { botSpamTicket: TICKET, authUrl: AUTH_URL, expireTimeSec: 1_800_000_000 },
        nowMs: () => 1_700_000_000_000,
        sleep: async () => {},
        query,
        refreshTicket,
        onTicketReplaced,
        deadlineMs: 1_700_000_600_000,
      }),
    ).rejects.toThrow("绑定凭证无效，请重新开始连接。");
    expect(refreshTicket).toHaveBeenCalledOnce();
    expect(onTicketReplaced).toHaveBeenCalledWith(next);
  });
});

describe("queryBotSpamAuthResult", () => {
  it("reads auth_status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ auth_status: 1 }));
    await expect(queryBotSpamAuthResult({ botSpamTicket: TICKET, fetchImpl })).resolves.toBe(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(`bot_spam_ticket=${TICKET}`);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("step=query_auth_result");
  });

  it("reads auth_status from a data envelope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ret: 0, data: { auth_status: 1 } }));
    await expect(queryBotSpamAuthResult({ botSpamTicket: TICKET, fetchImpl })).resolves.toBe(1);
  });
});

describe("real-name response validation and recovery", () => {
  const validTicket = {
    bot_spam_ticket: TICKET,
    auth_url: AUTH_URL,
    expire_time: 1_800_000_000,
  };
  const ticket = { botSpamTicket: TICKET, authUrl: AUTH_URL, expireTimeSec: 1_800_000_000 };

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    null,
    {},
    { ...validTicket, bot_spam_ticket: "invalid" },
    { ...validTicket, auth_url: "" },
    { ...validTicket, expire_time: undefined },
    { ...validTicket, expire_time: "tomorrow" },
    { ...validTicket, expire_time: "9".repeat(400) },
    { ...validTicket, errcode: 1 },
  ])("rejects unusable binding credentials: %j", (raw) => {
    expect(() => parseBotSpamTicketContext(raw, 1_700_000_000)).toThrow(BotSpamTicketError);
  });

  it.each([null, {}, { ret: 1, auth_status: 1 }, { auth_status: 4 }, { auth_status: "invalid" }])(
    "rejects an invalid authorization response instead of accepting it: %j",
    (raw) => {
      expect(() => parseBotSpamAuthStatus(raw)).toThrow(BotSpamTicketError);
    },
  );

  it.each([0, 1, 2, 3] as const)("accepts documented authorization status %s", (status) => {
    expect(parseBotSpamAuthStatus({ auth_status: status })).toBe(status);
    expect(parseBotSpamAuthStatus({ data: { auth_status: String(status) } })).toBe(status);
  });

  it.each([resolveAcctwebOrigin, resolveAcctwebProxy])(
    "rejects malformed endpoint configuration before requesting a ticket",
    (resolve) => {
      expect(() => resolve("not a URL")).toThrow(BotSpamTicketError);
    },
  );

  it.each(["http", "json", "network", "body"])(
    "turns %s failure into a binding error without leaking the response",
    async (kind) => {
      const fetchImpl = vi.fn(async () => {
        if (kind === "network") throw new Error("private transport detail");
        if (kind === "http") return jsonResponse({ detail: "private response" }, 503);
        return {
          ok: true,
          text: async () => {
            if (kind === "body") throw new Error("private body read failure");
            return "not JSON";
          },
        } as Response;
      });
      await expect(fetchBotSpamTicket({ pluginVersion: "test", fetchImpl })).rejects.toThrow(
        "无法获取绑定凭证，连接已停止。",
      );
    },
  );

  it("uses the default direct transport without a custom fetch implementation", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validTicket));
    vi.stubGlobal("fetch", fetchImpl);
    await expect(fetchBotSpamTicket({ pluginVersion: "test" })).resolves.toEqual(ticket);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty("dispatcher");
  });

  it("preserves a successful response if proxy cleanup fails", async () => {
    const close = vi
      .spyOn(ProxyAgent.prototype, "close")
      .mockRejectedValueOnce(new Error("closed"));
    await expect(
      fetchBotSpamTicket({
        pluginVersion: "test",
        acctwebProxy: "http://127.0.0.1:8088",
        fetchImpl: async () => jsonResponse(validTicket),
      }),
    ).resolves.toEqual(ticket);
    expect(close).toHaveBeenCalledOnce();
  });

  it("bounds pending authorization using the default clock, wait and deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const pending = expect(waitForBotSpamAuth({ ticket })).rejects.toThrow(
      "实名授权超时，请重新开始连接。",
    );
    await vi.advanceTimersByTimeAsync(480_001);
    await pending;
  });

  it("stops before querying when the ticket has expired", async () => {
    const query = vi.fn();
    await expect(
      waitForBotSpamAuth({ ticket, nowMs: () => ticket.expireTimeSec * 1000, query }),
    ).rejects.toThrow("实名授权超时，请重新开始连接。");
    expect(query).not.toHaveBeenCalled();
  });

  it("recovers from transient query failures while keeping the authorization deadline", async () => {
    let now = 1_700_000_000_000;
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary network error"))
      .mockRejectedValueOnce(new Error("temporary network error"))
      .mockRejectedValueOnce(new Error("temporary network error"))
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    await expect(
      waitForBotSpamAuth({
        ticket,
        query,
        nowMs: () => now,
        sleep: async () => {
          now += 16_000;
        },
      }),
    ).resolves.toEqual(ticket);
    expect(query).toHaveBeenCalledTimes(5);
  });

  it("rejects invalid tickets immediately when refresh is unavailable", async () => {
    await expect(
      waitForBotSpamAuth({ ticket, nowMs: () => 1_700_000_000_000, query: async () => 3 }),
    ).rejects.toThrow("绑定凭证无效，请重新开始连接。");
  });

  it.each([
    new Error("private refresh error"),
    new BotSpamTicketError("绑定凭证无效，请重新开始连接。"),
  ])("stops after a failed ticket refresh without polling again", async (error) => {
    const query = vi.fn(async () => 3 as const);
    await expect(
      waitForBotSpamAuth({
        ticket,
        nowMs: () => 1_700_000_000_000,
        query,
        refreshTicket: async () => {
          throw error;
        },
      }),
    ).rejects.toThrow("绑定凭证无效，请重新开始连接。");
    expect(query).toHaveBeenCalledOnce();
  });
});
