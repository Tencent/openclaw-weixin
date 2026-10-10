import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWeixinAccountId, saveWeixinAccount } from "./auth/accounts.js";
import { weixinPlugin } from "./channel.js";
import { clearContextTokensForAccount, setContextToken } from "./messaging/inbound.js";

const { sendMessageApi, uploadFileToWeixin } = vi.hoisted(() => ({
  sendMessageApi: vi.fn(),
  uploadFileToWeixin: vi.fn(),
}));

vi.mock("./api/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/api.js")>()),
  sendMessage: sendMessageApi,
}));
vi.mock("./cdn/upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cdn/upload.js")>()),
  uploadFileToWeixin,
}));
vi.mock("./util/logger.js", () => {
  const logger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withAccount: () => logger,
  };
  return { logger };
});

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-session-route-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
});

afterEach(() => {
  clearContextTokensForAccount("bot-one");
  clearContextTokensForAccount("bot-two");
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = previousStateDir;
});

async function resolveRoute(params: { target: string; accountId?: string }) {
  const resolver = weixinPlugin.messaging?.resolveOutboundSessionRoute;
  if (!resolver) throw new Error("expected outbound session route resolver");
  return await resolver({
    cfg: { session: { dmScope: "per-account-channel-peer" } },
    agentId: "main",
    target: params.target,
    accountId: params.accountId,
  });
}

describe("Weixin outbound session route", () => {
  it("resolves an explicit account and canonical Weixin user", async () => {
    const route = await resolveRoute({
      target: "openclaw-weixin:user:Alice@im.wechat",
      accountId: "Bot@One",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:openclaw-weixin:bot-one:direct:alice@im.wechat",
      recipientSessionExact: false,
      peer: { kind: "direct", id: "Alice@im.wechat" },
      to: "Alice@im.wechat",
    });
  });

  it("uses the only registered account instead of the default account", async () => {
    registerWeixinAccountId("bot-one");

    const route = await resolveRoute({ target: "alice@im.wechat" });

    expect(route).toMatchObject({
      sessionKey: "agent:main:openclaw-weixin:bot-one:direct:alice@im.wechat",
      recipientSessionExact: false,
    });
  });

  it("does not certify case-distinct recipients as exact sessions", async () => {
    const upper = await resolveRoute({ target: "Alice@im.wechat", accountId: "bot-one" });
    const lower = await resolveRoute({ target: "alice@im.wechat", accountId: "bot-one" });
    expect(upper).toMatchObject({ to: "Alice@im.wechat", recipientSessionExact: false });
    expect(lower).toMatchObject({ to: "alice@im.wechat", recipientSessionExact: false });
  });

  it("rejects targets that cannot identify an inbound Weixin session", async () => {
    await expect(resolveRoute({ target: "group:alice@im.wechat" })).resolves.toBeNull();
  });
});

describe("Weixin outbound target normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const accountId of ["bot-one", "bot-two"]) {
      registerWeixinAccountId(accountId);
      saveWeixinAccount(accountId, { token: `synthetic-${accountId}` });
    }
    setContextToken("bot-one", "Alice@im.wechat", "fixture-alice-context");
    setContextToken("bot-two", "Bob@im.wechat", "fixture-bob-context");
    sendMessageApi.mockResolvedValue({ ret: 0 });
    uploadFileToWeixin.mockResolvedValue({
      filekey: "fixture-file",
      downloadEncryptedQueryParam: "fixture-query",
      aeskey: "0123456789abcdef0123456789abcdef",
      fileSize: 16,
      fileSizeCiphertext: 32,
    });
  });

  it.each([
    { to: "Alice@im.wechat" },
    { to: "user:Alice@im.wechat" },
    { to: "dm:Alice@im.wechat" },
    { to: "openclaw-weixin:user:Alice@im.wechat" },
    { to: "user:Alice@im.wechat", accountId: "bot-one" },
    { to: "user:Alice@im.wechat", accountId: "Bot@One" },
  ])(
    "selects the account and cached context before sending text to $to",
    async ({ to, accountId }) => {
      const sendText = weixinPlugin.outbound?.sendText;
      if (!sendText) throw new Error("expected text sender");
      await sendText({ cfg: {}, to, accountId, text: "fixture reply" });
      expect(sendMessageApi).toHaveBeenCalledOnce();
      expect(sendMessageApi.mock.calls[0][0]).toMatchObject({
        token: "synthetic-bot-one",
        body: { msg: { to_user_id: "Alice@im.wechat", context_token: "fixture-alice-context" } },
      });
      expect(weixinPlugin.messaging?.normalizeTarget?.(to)).toBe("Alice@im.wechat");
    },
  );

  it.each([undefined, "/tmp/fixture-image.png"])(
    "normalizes media delivery with mediaUrl=%s",
    async (mediaUrl) => {
      const sendMedia = weixinPlugin.outbound?.sendMedia;
      if (!sendMedia) throw new Error("expected media sender");
      await sendMedia({ cfg: {}, to: "user:Alice@im.wechat", text: "fixture caption", mediaUrl });
      expect(sendMessageApi).toHaveBeenCalled();
      for (const [request] of sendMessageApi.mock.calls) {
        expect(request.body.msg).toMatchObject({
          to_user_id: "Alice@im.wechat",
          context_token: "fixture-alice-context",
        });
      }
      if (mediaUrl) {
        expect(uploadFileToWeixin).toHaveBeenCalledWith(
          expect.objectContaining({ toUserId: "Alice@im.wechat" }),
        );
      } else {
        expect(uploadFileToWeixin).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["group:Alice@im.wechat", "channel:Alice@im.wechat", "not-a-weixin-recipient"])(
    "rejects unsupported target %s before sending or uploading",
    async (to) => {
      const { sendText, sendMedia } = weixinPlugin.outbound ?? {};
      if (!sendText || !sendMedia) throw new Error("expected outbound senders");
      await expect(
        sendText({ cfg: {}, accountId: "bot-one", to, text: "fixture" }),
      ).rejects.toThrow("direct");
      await expect(
        sendMedia({
          cfg: {},
          accountId: "bot-one",
          to,
          text: "fixture",
          mediaUrl: "/tmp/fixture.png",
        }),
      ).rejects.toThrow("direct");
      expect(sendMessageApi).not.toHaveBeenCalled();
      expect(uploadFileToWeixin).not.toHaveBeenCalled();
    },
  );
});
