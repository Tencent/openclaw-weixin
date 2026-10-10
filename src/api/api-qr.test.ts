import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logs = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../util/logger.js", () => ({ logger: logs }));
vi.mock("../auth/accounts.js", () => ({
  loadConfigBotAgent: () => undefined,
  loadConfigRouteTag: () => undefined,
}));
import { apiGetFetch } from "./api.js";

const fetchFixture = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchFixture);
  fetchFixture.mockReset();
  Object.values(logs).forEach((log) => log.mockClear());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("browser QR HTTP boundary", () => {
  it("aborts a pending status request on cancellation and releases its timeout and listener", async () => {
    const external = new AbortController();
    const remove = vi.spyOn(external.signal, "removeEventListener");
    fetchFixture.mockImplementationOnce(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const request = apiGetFetch({
      baseUrl: "https://api.example.test",
      endpoint: "qr?qrcode=synthetic&verify_code=012345",
      timeoutMs: 30000,
      abortSignal: external.signal,
      label: "pollQRStatus",
    });
    external.abort();
    await expect(request).rejects.toThrow("Weixin QR status request failed");
    expect(fetchFixture.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not expose a phone verification code from transport errors", async () => {
    fetchFixture.mockRejectedValueOnce(new Error("https://api.example.test/qr?verify_code=012345"));
    await expect(
      apiGetFetch({
        baseUrl: "https://api.example.test",
        endpoint: "qr?verify_code=012345",
        label: "pollQRStatus",
      }),
    ).rejects.toThrow("Weixin QR status request failed");
    expect(JSON.stringify(Object.values(logs).flatMap((log) => log.mock.calls))).not.toContain(
      "012345",
    );
  });
});
