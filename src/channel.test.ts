import { describe, expect, it } from "vitest";
import { stripChannelTargetPrefix } from "openclaw/plugin-sdk/core";

import { weixinPlugin } from "./channel.js";

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
