import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import {
  buildChannelInboundEventContext,
  dispatchChannelInboundTurn,
} from "openclaw/plugin-sdk/channel-inbound";

import type { WeixinMessage } from "../api/types.js";
import { MessageItemType } from "../api/types.js";

const mocks = vi.hoisted(() => ({
  sendMessageWeixin: vi.fn().mockResolvedValue({ messageId: "sent" }),
}));

vi.mock("openclaw/plugin-sdk/command-auth", () => ({
  resolveSenderCommandAuthorizationWithRuntime: vi.fn().mockResolvedValue({
    senderAllowedForCommands: true,
    commandAuthorized: true,
  }),
  resolveDirectDmAuthorizationOutcome: vi.fn().mockReturnValue("allowed"),
}));

vi.mock("../auth/accounts.js", () => ({
  loadWeixinAccount: vi.fn().mockReturnValue({ userId: "sender@im.wechat" }),
}));

vi.mock("./error-notice.js", () => ({
  sendWeixinErrorNotice: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageWeixin: mocks.sendMessageWeixin,
}));

import { processOneMessage } from "./process-message.js";

function createRuntime(): PluginRuntime {
  const runtime = {
    channel: {
      commands: {},
      media: {},
      routing: {},
      inbound: { buildContext: buildChannelInboundEventContext },
    },
  } as PluginRuntime;
  runtime.channel.routing.resolveAgentRoute = vi.fn().mockReturnValue({
    agentId: "main",
    accountId: "account-1",
    sessionKey: "agent:main:openclaw-weixin:direct:sender",
    mainSessionKey: "agent:main:main",
  });
  runtime.channel.inbound.dispatch = vi.fn(
    async (params) =>
      dispatchChannelInboundTurn({
        ...params,
        replyResolver: async (_ctx, opts) => {
          if (opts?.disableBlockStreaming !== true) {
            await opts?.onBlockReply?.({ text: "First intermediate block" });
            await opts?.onBlockReply?.({ text: "Second intermediate block" });
          }
          return { text: "Final content" };
        },
      }),
  );
  return runtime;
}

describe("processOneMessage block streaming", () => {
  let stateDir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendMessageWeixin.mockResolvedValue({ messageId: "sent" });
    stateDir = mkdtempSync(path.join(tmpdir(), "weixin-dispatch-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it.each([true, false])("preserves block streaming when enabled=%s", async (enabled) => {
    const message: WeixinMessage = {
      message_id: 1,
      from_user_id: "sender@im.wechat",
      to_user_id: "bot@im.bot",
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: "Do several steps" },
        },
      ],
    };
    const config = {
      session: { store: path.join(stateDir, "sessions.json") },
      channels: {
        "openclaw-weixin": {
          replyProgressMessages: false,
          blockStreaming: enabled,
        },
      },
    } as OpenClawConfig;

    await processOneMessage(message, {
      accountId: "account-1",
      config,
      channelRuntime: createRuntime().channel,
      baseUrl: "https://api.example.com",
      cdnBaseUrl: "https://cdn.example.com",
      log: vi.fn(),
      errLog: vi.fn(),
    });

    expect(mocks.sendMessageWeixin.mock.calls.map(([request]) => request.text)).toEqual(
      enabled
        ? ["First intermediate block", "Second intermediate block", "Final content"]
        : ["Final content"],
    );
  });
});
