import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWeixinAccountId } from "./auth/accounts.js";
import { weixinPlugin } from "./channel.js";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-session-route-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
});

afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
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
  it("certifies an explicit account and canonical Weixin user", async () => {
    const route = await resolveRoute({
      target: "openclaw-weixin:user:Alice@im.wechat",
      accountId: "Bot@One",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:openclaw-weixin:bot-one:direct:alice@im.wechat",
      recipientSessionExact: true,
      peer: { kind: "direct", id: "Alice@im.wechat" },
      to: "Alice@im.wechat",
    });
  });

  it("uses the only registered account instead of the default account", async () => {
    registerWeixinAccountId("bot-one");

    const route = await resolveRoute({ target: "alice@im.wechat" });

    expect(route).toMatchObject({
      sessionKey: "agent:main:openclaw-weixin:bot-one:direct:alice@im.wechat",
      recipientSessionExact: true,
    });
  });

  it("rejects targets that cannot identify an inbound Weixin session", async () => {
    await expect(resolveRoute({ target: "group:alice@im.wechat" })).resolves.toBeNull();
  });
});
