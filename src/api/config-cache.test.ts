import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetConfig } = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
}));

vi.mock("./api.js", () => ({
  getConfig: mockGetConfig,
}));

import { WeixinConfigManager } from "./config-cache.js";

let dateNowMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  dateNowMock = vi.spyOn(Date, "now");
});

afterEach(() => {
  dateNowMock.mockRestore();
});

describe("WeixinConfigManager", () => {
  it("fetches and caches config on first getForUser call", async () => {
    mockGetConfig.mockResolvedValueOnce({ ret: 0, typing_ticket: "ticket-1" });
    const logFn = vi.fn();
    const mgr = new WeixinConfigManager({ baseUrl: "https://api.com", token: "tok" }, logFn);
    const config = await mgr.getForUser("user1", "ctx");
    expect(config.typingTicket).toBe("ticket-1");
    expect(mockGetConfig).toHaveBeenCalledOnce();
    expect(logFn).toHaveBeenCalled();
  });

  it("returns cached config on subsequent calls within TTL", async () => {
    mockGetConfig.mockResolvedValueOnce({ ret: 0, typing_ticket: "ticket-1" });
    const mgr = new WeixinConfigManager({ baseUrl: "https://api.com" }, vi.fn());
    await mgr.getForUser("user1");
    const config = await mgr.getForUser("user1");
    expect(config.typingTicket).toBe("ticket-1");
    expect(mockGetConfig).toHaveBeenCalledOnce();
  });

  it("returns default config when getConfig fails", async () => {
    mockGetConfig.mockRejectedValueOnce(new Error("network error"));
    const mgr = new WeixinConfigManager({ baseUrl: "https://api.com" }, vi.fn());
    const config = await mgr.getForUser("user1");
    expect(config.typingTicket).toBe("");
  });

  it("returns default config when ret is not 0", async () => {
    mockGetConfig.mockResolvedValueOnce({ ret: -1, errmsg: "fail" });
    const mgr = new WeixinConfigManager({ baseUrl: "https://api.com" }, vi.fn());
    const config = await mgr.getForUser("user1");
    expect(config.typingTicket).toBe("");
  });

  it("uses exponential backoff on failure", async () => {
    const baseTime = 1000000;
    dateNowMock.mockReturnValue(baseTime);

    mockGetConfig.mockRejectedValueOnce(new Error("fail"));
    const mgr = new WeixinConfigManager({ baseUrl: "https://api.com" }, vi.fn());

    // First call fails → creates entry with nextFetchAt = baseTime + 2000
    await mgr.getForUser("user1");
    expect(mockGetConfig).toHaveBeenCalledTimes(1);

    // Time < nextFetchAt → should NOT refetch
    dateNowMock.mockReturnValue(baseTime + 1000);
    const config2 = await mgr.getForUser("user1");
    expect(config2.typingTicket).toBe("");
    expect(mockGetConfig).toHaveBeenCalledTimes(1);

    // Time >= nextFetchAt → refetches, but also fails
    dateNowMock.mockReturnValue(baseTime + 2500);
    mockGetConfig.mockRejectedValueOnce(new Error("fail again"));
    const config3 = await mgr.getForUser("user1");
    expect(config3.typingTicket).toBe("");
    expect(mockGetConfig).toHaveBeenCalledTimes(2);

    // Time >= nextFetchAt with doubled delay (4000ms) → refetches, succeeds
    dateNowMock.mockReturnValue(baseTime + 7000);
    mockGetConfig.mockResolvedValueOnce({ ret: 0, typing_ticket: "recovered" });
    const config4 = await mgr.getForUser("user1");
    expect(config4.typingTicket).toBe("recovered");
    expect(mockGetConfig).toHaveBeenCalledTimes(3);
  });

  it("refreshes config after TTL expires for successful entries", async () => {
    const baseTime = 1000000;
    dateNowMock.mockReturnValue(baseTime);
    // Make Math.random return 0 so nextFetchAt = now + 0 = now
    const randomMock = vi.spyOn(Math, "random").mockReturnValue(0);

    mockGetConfig.mockResolvedValueOnce({ ret: 0, typing_ticket: "ticket-1" });
    const mgr = new WeixinConfigManager({ baseUrl: "https://api.com" }, vi.fn());
    await mgr.getForUser("user1");

    // nextFetchAt = baseTime + 0 = baseTime, so any time >= baseTime triggers refresh
    dateNowMock.mockReturnValue(baseTime + 1);
    mockGetConfig.mockResolvedValueOnce({ ret: 0, typing_ticket: "ticket-2" });
    const config = await mgr.getForUser("user1");
    expect(config.typingTicket).toBe("ticket-2");
    expect(mockGetConfig).toHaveBeenCalledTimes(2);

    randomMock.mockRestore();
  });
});
