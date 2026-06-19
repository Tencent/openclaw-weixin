import { describe, expect, it } from "vitest";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import { resolveWeixinBlockStreamingEnabled } from "./process-message.js";

function config(openclawWeixin: unknown): OpenClawConfig {
  return { channels: { "openclaw-weixin": openclawWeixin } } as OpenClawConfig;
}

describe("resolveWeixinBlockStreamingEnabled", () => {
  it("defaults to false", () => {
    expect(resolveWeixinBlockStreamingEnabled(config({}), "acc1")).toBe(false);
  });

  it("uses channel-level blockStreaming", () => {
    expect(resolveWeixinBlockStreamingEnabled(config({ blockStreaming: true }), "acc1")).toBe(true);
  });

  it("lets account-level blockStreaming override channel-level value", () => {
    expect(
      resolveWeixinBlockStreamingEnabled(
        config({ blockStreaming: true, accounts: { acc1: { blockStreaming: false } } }),
        "acc1",
      ),
    ).toBe(false);
  });
});
