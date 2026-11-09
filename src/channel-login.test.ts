import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { loadWeixinAccount, registerWeixinAccountId, saveWeixinAccount } from "./auth/accounts.js";
import { weixinPlugin } from "./channel.js";

const state = vi.hoisted(() => ({
  mutateConfig: vi.fn(),
  startLogin: vi.fn(),
  waitLogin: vi.fn(),
  log: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/config-mutation", () => ({
  mutateConfigFile: state.mutateConfig,
}));
vi.mock("./auth/login-qr.js", () => ({
  DEFAULT_ILINK_BOT_TYPE: "3",
  QR_LOGIN_WAIT_MS: 480_000,
  startWeixinLoginWithQr: state.startLogin,
  waitForWeixinLogin: state.waitLogin,
  displayQRCode: vi.fn(),
}));
vi.mock("./util/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let stateDir: string;

beforeEach(() => {
  vi.resetAllMocks();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-login-completion-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  saveWeixinAccount("existing-im-bot", { token: "previous-token" });
  registerWeixinAccountId("existing-im-bot");
  state.startLogin.mockResolvedValue({
    sessionKey: "existing-im-bot",
    qrcodeUrl: "https://offline.invalid/bind",
    message: "Scan the QR code",
  });
  state.waitLogin.mockResolvedValue({
    connected: true,
    accountId: "fresh@im.bot",
    botToken: "new-token",
    baseUrl: "https://offline.invalid",
    message: "Connected",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["cli", "gateway"] as const)(
  "keeps the %s login alive until the channel reload config is committed",
  async (entry) => {
    const started = deferred();
    const release = deferred();
    const configPath = path.join(stateDir, "openclaw.json");
    const draft = { channels: { "openclaw-weixin": {} as Record<string, unknown> } };
    let completed = false;
    let mutation: Promise<void>;
    state.mutateConfig.mockImplementation(({ mutate }) => {
      mutation = release.promise.then(() => {
        mutate(draft);
        fs.writeFileSync(configPath, JSON.stringify(draft));
      });
      started.resolve();
      return mutation;
    });

    const login =
      entry === "cli"
        ? weixinPlugin.auth!.login!({
            cfg: {},
            accountId: "existing-im-bot",
            verbose: false,
            runtime: { log: state.log, error: vi.fn(), exit: vi.fn() },
          })
        : weixinPlugin.gateway!.loginWithQrWait!({ accountId: "existing-im-bot" });
    const task = login.then(() => {
      completed = true;
    });

    try {
      await started.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(loadWeixinAccount("fresh-im-bot")?.token).toBe("new-token");
      expect(completed).toBe(false);
      expect(state.log.mock.calls.some(([message]) => message.includes("已将此 OpenClaw"))).toBe(
        false,
      );

      release.resolve();
      await task;

      const saved = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(saved.channels["openclaw-weixin"].channelConfigUpdatedAt).toEqual(expect.any(String));
      expect(completed).toBe(true);
    } finally {
      release.resolve();
      await task;
      await mutation!;
    }
  },
);
