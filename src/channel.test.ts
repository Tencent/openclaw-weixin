import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripChannelTargetPrefix } from "openclaw/plugin-sdk/core";

import { weixinPlugin } from "./channel.js";

const state = vi.hoisted(() => ({ account: vi.fn(), send: vi.fn() }));
vi.mock("./auth/accounts.js", async (original) => ({
  ...(await original()),
  resolveWeixinAccount: state.account,
}));
vi.mock("./messaging/send.js", async (original) => ({
  ...(await original()),
  sendMessageWeixin: state.send,
}));
vi.mock("./messaging/outbound-hooks.js", () => ({
  applyWeixinMessageSendingHook: async ({ text }: { text: string }) => ({ text }),
  emitWeixinMessageSent: () => {},
}));
vi.mock("./util/logger.js", () => ({
  logger: { debug() {}, withAccount: () => ({ info() {}, warn() {}, error() {} }) },
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.account.mockReturnValue({
    accountId: "test-account",
    configured: true,
    baseUrl: "https://offline.invalid",
  });
  state.send.mockResolvedValue({ messageId: "sent" });
});

it("suppresses a core-recovered error notice when notifications are disabled", async () => {
  await expect(
    weixinPlugin.outbound!.sendText!({
      cfg: {},
      to: "owner@im.wechat",
      text: "old failure notice",
      accountId: "test-account",
      deliveryQueueId: "weixin-error-pending",
    }),
  ).resolves.toMatchObject({ outcome: "not_sent", messageId: "" });
  expect(state.account).not.toHaveBeenCalled();
  expect(state.send).not.toHaveBeenCalled();
});

it("checks persisted notice sender metadata when core omits the queue ID", async () => {
  await expect(
    weixinPlugin.outbound!.sendText!({
      cfg: {},
      to: "owner@im.wechat",
      text: "queued failure notice",
      accountId: "test-account",
      identity: { name: "openclaw-weixin:error-notice" },
    }),
  ).resolves.toMatchObject({ outcome: "not_sent" });
  expect(state.send).not.toHaveBeenCalled();
});

it.each(["ordinary", "enabled notice"])("still sends %s messages", async (kind) => {
  await expect(
    weixinPlugin.outbound!.sendText!({
      cfg: { channels: { "openclaw-weixin": { errorNotices: kind === "enabled notice" } } },
      to: "owner@im.wechat",
      text: "message",
      accountId: "test-account",
      ...(kind === "enabled notice" ? { identity: { name: "openclaw-weixin:error-notice" } } : {}),
    }),
  ).resolves.toMatchObject({ messageId: "sent" });
  expect(state.send).toHaveBeenCalledTimes(1);
});

describe("Weixin target chat type", () => {
  it.each(["Alice@im.wechat", "wxid_123-abc@im.wechat", " Alice@im.wechat "])(
    "classifies direct recipient %s",
    (to) => {
      expect(weixinPlugin.messaging?.inferTargetChatType?.({ to })).toBe("direct");
    },
  );

  it("classifies a channel-qualified owner after host prefix normalization", () => {
    const to = stripChannelTargetPrefix("openclaw-weixin:Alice@im.wechat", "openclaw-weixin");

    expect(to).toBe("Alice@im.wechat");
    expect(weixinPlugin.messaging?.inferTargetChatType?.({ to })).toBe("direct");
  });

  it.each([
    "",
    "owner",
    "Alice",
    "@im.wechat",
    "Alice@other",
    "Alice@im.wechat@im.wechat",
    "Alice Bob@im.wechat",
    "group:Alice@im.wechat",
    "channel:Alice@im.wechat",
    "telegram:Alice@im.wechat",
  ])("leaves unsupported target %s unclassified", (to) => {
    expect(weixinPlugin.messaging?.inferTargetChatType?.({ to })).toBeUndefined();
  });
});
