import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import {
  createReplyDispatcherWithTyping,
  dispatchInboundMessage,
} from "openclaw/plugin-sdk/reply-runtime";

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

vi.mock("./outbound-hooks.js", () => ({
  applyWeixinMessageSendingHook: vi.fn(async ({ text }: { text: string }) => ({
    cancelled: false,
    text,
  })),
  emitWeixinMessageSent: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageWeixin: mocks.sendMessageWeixin,
}));

import { processOneMessage } from "./process-message.js";

function createRuntime(): PluginRuntime {
  const runtime = createPluginRuntimeMock() as PluginRuntime;
  runtime.channel.reply.createReplyDispatcherWithTyping = createReplyDispatcherWithTyping;
  runtime.channel.routing.resolveAgentRoute = vi.fn().mockReturnValue({
    agentId: "main",
    accountId: "account-1",
    sessionKey: "agent:main:openclaw-weixin:direct:sender",
    mainSessionKey: "agent:main:main",
  });
  runtime.channel.reply.dispatchReplyFromConfig = vi.fn(
    async ({ ctx, cfg, dispatcher, replyOptions }) =>
      dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions,
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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendMessageWeixin.mockResolvedValue({ messageId: "sent" });
  });

  it("delivers intermediate blocks in order before final content by default", async () => {
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
      channels: {
        "openclaw-weixin": {
          replyProgressMessages: false,
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

    expect(mocks.sendMessageWeixin.mock.calls.map(([request]) => request.text)).toEqual([
      "First intermediate block",
      "Second intermediate block",
      "Final content",
    ]);
  });
});
