import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const savedAccounts = vi.hoisted(() => new Map<string, { token: string }>());
const logs = vi.hoisted(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../api/api.js", () => ({ apiGetFetch: network.get, apiPostFetch: network.post }));
vi.mock("./accounts.js", () => ({
  listIndexedWeixinAccountIds: () => [...savedAccounts.keys()],
  loadWeixinAccount: (id: string) => savedAccounts.get(id) ?? null,
}));
vi.mock("qrcode-terminal", () => ({ default: { generate: vi.fn() } }));
vi.mock("../util/logger.js", () => ({ logger: logs }));

import {
  controlWeixinLogin,
  disposeWeixinLogins,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  waitForWeixinLoginBrowser,
} from "./login-qr.js";
import { redactBody } from "../util/redact.js";

const privatePayload = "https://weixin.qq.com/private-qr-session";
const confirmed = JSON.stringify({
  status: "confirmed",
  ilink_bot_id: "bot@im.bot",
  bot_token: "private-token",
  ilink_user_id: "user",
});
async function start(accountId?: string, force = false) {
  return await startWeixinLoginWithQr({
    accountId,
    force,
    browser: true,
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
  });
}
function wait(sessionKey: string, save = vi.fn(() => "bot-im-bot")) {
  return waitForWeixinLoginBrowser({
    sessionKey,
    timeoutMs: 1000,
    onConnected: save,
    assertCurrent: () => {},
  });
}

describe("browser QR login identity and lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
    network.post
      .mockReset()
      .mockResolvedValue(
        JSON.stringify({ qrcode: "private-session", qrcode_img_content: privatePayload }),
      );
    network.get.mockReset();
    savedAccounts.clear();
    Object.values(logs).forEach((log) => log.mockClear());
  });
  afterEach(() => {
    disposeWeixinLogins();
    vi.useRealTimers();
  });

  it("renders a real bounded PNG and preserves a fresh login between polling slices", async () => {
    const login = await start();
    expect(login.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(login.qrDataUrl!.length).toBeLessThanOrEqual(16384);
    const png = Buffer.from(login.qrDataUrl!.split(",")[1], "base64");
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    network.get.mockResolvedValue(JSON.stringify({ status: "wait" }));
    const first = await wait(login.sessionKey);
    const second = await wait(login.sessionKey);
    expect(first).toMatchObject({
      connected: false,
      qrDataUrl: login.qrDataUrl,
      sessionKey: login.sessionKey,
      expiresAtMs: login.expiresAtMs,
    });
    expect(second.qrDataUrl).toBe(login.qrDataUrl);
    expect(network.get.mock.calls[0][0].timeoutMs).toBe(1000);
    expect(JSON.stringify(Object.values(logs).flatMap((log) => log.mock.calls))).not.toContain(
      privatePayload,
    );
  });

  it("redacts QR payloads, verification codes, and local token lists from API logs", () => {
    const logged = redactBody(
      JSON.stringify({
        qrcode: "private-session",
        qrcode_img_content: privatePayload,
        verify_code: "123456",
        local_token_list: ["private-local-token"],
      }),
      500,
    );
    expect(logged).not.toContain(privatePayload);
    expect(logged).not.toContain("private-session");
    expect(logged).not.toContain("123456");
    expect(logged).not.toContain("private-local-token");
  });

  it("returns the refreshed QR immediately after upstream expiry", async () => {
    const login = await start();
    network.get.mockResolvedValue(JSON.stringify({ status: "expired" }));
    network.post.mockResolvedValue(
      JSON.stringify({ qrcode: "replacement", qrcode_img_content: `${privatePayload}/new` }),
    );
    vi.setSystemTime(Date.now() + 1000);
    const refreshed = await wait(login.sessionKey);
    expect(refreshed.connected).toBe(false);
    expect(refreshed.sessionKey).toBe(login.sessionKey);
    expect(refreshed.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(refreshed.qrDataUrl).not.toBe(login.qrDataUrl);
    expect(refreshed.expiresAtMs).toBeGreaterThan(login.expiresAtMs!);
  });

  it("returns verification-required without reading stdin, then submits only the entered code", async () => {
    const login = await start();
    const resume = vi.spyOn(process.stdin, "resume");
    network.get.mockResolvedValueOnce(JSON.stringify({ status: "need_verifycode" }));
    expect(await wait(login.sessionKey)).toMatchObject({
      verificationRequired: true,
      connected: false,
    });
    expect(resume).not.toHaveBeenCalled();
    controlWeixinLogin({ action: "verify", sessionKey: login.sessionKey, code: "123456" });
    network.get.mockResolvedValueOnce(confirmed);
    const save = vi.fn(() => "bot-im-bot");
    expect(await wait(login.sessionKey, save)).toMatchObject({
      connected: true,
      accountId: "bot-im-bot",
    });
    expect(network.get.mock.calls[1][0].endpoint).toContain("verify_code=123456");
    expect(save).toHaveBeenCalledOnce();
    expect(JSON.stringify(Object.values(logs).flatMap((log) => log.mock.calls))).not.toContain(
      "123456",
    );
    resume.mockRestore();
  });

  it("cancellation aborts a pending poll and fences its later confirmed response", async () => {
    const login = await start();
    let deliver!: (body: string) => void;
    network.get.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          deliver = resolve;
        }),
    );
    const save = vi.fn(() => "bot-im-bot");
    const pending = wait(login.sessionKey, save);
    const signal = network.get.mock.calls[0][0].abortSignal as AbortSignal;
    controlWeixinLogin({ action: "cancel", sessionKey: login.sessionKey });
    expect(signal.aborted).toBe(true);
    deliver(confirmed);
    expect(await pending).toMatchObject({ connected: false, cancelled: true });
    expect(save).not.toHaveBeenCalled();
  });

  it("a stale same-account poll cannot save or delete a replacement login", async () => {
    const old = await start("selected-account");
    let deliver!: (body: string) => void;
    network.get.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          deliver = resolve;
        }),
    );
    const save = vi.fn(() => "bot-im-bot");
    const stale = wait(old.sessionKey, save);
    const replacement = await start("selected-account", true);
    expect(replacement.sessionKey).not.toBe(old.sessionKey);
    deliver(confirmed);
    expect(await stale).toMatchObject({ cancelled: true });
    expect(save).not.toHaveBeenCalled();
    controlWeixinLogin({ action: "cancel", sessionKey: old.sessionKey });
    network.get.mockResolvedValue(JSON.stringify({ status: "wait" }));
    expect(await wait(replacement.sessionKey)).toMatchObject({ qrDataUrl: replacement.qrDataUrl });
  });

  it("cancellation and replacement fence pending QR generation before publication", async () => {
    let deliver!: (body: string) => void;
    network.post.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          deliver = resolve;
        }),
    );
    const staleStart = start("selected-account", true);
    const replacement = await start("selected-account", true);
    deliver(JSON.stringify({ qrcode: "stale", qrcode_img_content: `${privatePayload}/stale` }));
    expect(await staleStart).toMatchObject({ cancelled: true });
    network.get.mockResolvedValue(JSON.stringify({ status: "wait" }));
    expect(await wait(replacement.sessionKey)).toMatchObject({ qrDataUrl: replacement.qrDataUrl });
  });

  it("reports persistence failure and removes the failed login instead of claiming connection", async () => {
    const login = await start();
    network.get.mockResolvedValue(confirmed);
    const save = vi.fn(() => {
      throw new Error("disk full/private-path");
    });
    await expect(wait(login.sessionKey, save)).rejects.toThrow("凭据保存失败");
    expect(await wait(login.sessionKey)).toMatchObject({ connected: false, cancelled: true });
  });

  it("rechecks captured authority after an awaited poll before credential persistence", async () => {
    const login = await start();
    let live = true;
    let deliver!: (body: string) => void;
    network.get.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          deliver = resolve;
        }),
    );
    const save = vi.fn(() => "bot-im-bot");
    const pending = waitForWeixinLoginBrowser({
      sessionKey: login.sessionKey,
      onConnected: save,
      assertCurrent: () => {
        if (!live) throw new Error("authority expired");
      },
    });
    live = false;
    deliver(confirmed);
    await expect(pending).rejects.toThrow("authority expired");
    expect(save).not.toHaveBeenCalled();
    expect(await wait(login.sessionKey)).toMatchObject({ cancelled: true });
  });

  it("socket disconnect aborts a pending poll and prevents later credential persistence", async () => {
    const login = await start();
    const connection = new AbortController();
    let deliver!: (body: string) => void;
    network.get.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          deliver = resolve;
        }),
    );
    const save = vi.fn(() => "bot-im-bot");
    const pending = waitForWeixinLoginBrowser({
      sessionKey: login.sessionKey,
      onConnected: save,
      requestSignal: connection.signal,
      assertCurrent: () => {
        if (connection.signal.aborted) throw new Error("connection closed");
      },
    });
    connection.abort();
    expect(network.get.mock.calls[0][0].abortSignal.aborted).toBe(true);
    deliver(confirmed);
    await expect(pending).rejects.toThrow("connection closed");
    expect(save).not.toHaveBeenCalled();
  });

  it("already-connected succeeds only with local credentials and does not save", async () => {
    const save = vi.fn(() => "bot-im-bot");
    network.get.mockResolvedValue(JSON.stringify({ status: "binded_redirect" }));
    const missing = await start();
    expect(await wait(missing.sessionKey, save)).toMatchObject({
      connected: false,
      alreadyConnected: true,
    });
    savedAccounts.set("bot-im-bot", { token: "synthetic-local-token" });
    const existing = await start();
    expect(await wait(existing.sessionKey, save)).toMatchObject({
      connected: true,
      alreadyConnected: true,
      accountId: "bot-im-bot",
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("total expiry and plugin disposal terminate pending sessions", async () => {
    const expired = await start();
    vi.setSystemTime(Date.now() + 300_001);
    expect(await wait(expired.sessionKey)).toMatchObject({
      connected: false,
      message: "二维码已过期，请重新生成。",
    });
    expect(network.get).not.toHaveBeenCalled();
    const active = await start();
    disposeWeixinLogins();
    expect(await wait(active.sessionKey)).toMatchObject({ cancelled: true });
  });

  it("retains CLI QR payload and confirmed credential result", async () => {
    const login = await startWeixinLoginWithQr({
      accountId: "cli-account",
      apiBaseUrl: "https://ilinkai.weixin.qq.com",
    });
    expect(login).toMatchObject({ sessionKey: "cli-account", qrcodeUrl: privatePayload });
    expect(login.qrDataUrl).toBeUndefined();
    expect(network.post.mock.calls[0][0]).not.toHaveProperty("timeoutMs");
    network.get.mockResolvedValue(confirmed);
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(
        await waitForWeixinLogin({
          sessionKey: login.sessionKey,
          apiBaseUrl: "https://ilinkai.weixin.qq.com",
          timeoutMs: 1000,
        }),
      ).toMatchObject({ connected: true, botToken: "private-token", accountId: "bot@im.bot" });
    } finally {
      output.mockRestore();
    }
  });

  it("applies a bounded QR creation timeout only in the browser and retains CLI refresh behavior", async () => {
    await start();
    expect(network.post.mock.calls[0][0]).toHaveProperty("timeoutMs", 30000);
    network.get
      .mockResolvedValueOnce(JSON.stringify({ status: "expired" }))
      .mockResolvedValueOnce(confirmed);
    const cli = await startWeixinLoginWithQr({
      accountId: "cli-refresh",
      apiBaseUrl: "https://ilinkai.weixin.qq.com",
    });
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const waiting = waitForWeixinLogin({
        sessionKey: cli.sessionKey,
        apiBaseUrl: "https://ilinkai.weixin.qq.com",
        timeoutMs: 10000,
      });
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await waiting).toMatchObject({ connected: true });
      expect(
        network.post.mock.calls.slice(1).every(([params]) => !Object.hasOwn(params, "timeoutMs")),
      ).toBe(true);
      expect(network.post).toHaveBeenCalledTimes(3);
    } finally {
      output.mockRestore();
    }
  });
});
