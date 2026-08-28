import { describe, expect, it } from "vitest";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import { resolveWeixinBlockStreamingEnabled } from "./block-streaming.js";

function config(openclawWeixin: unknown): OpenClawConfig {
  return { channels: { "openclaw-weixin": openclawWeixin } } as OpenClawConfig;
}

describe("resolveWeixinBlockStreamingEnabled", () => {
  it("defaults to enabled", () => {
    expect(resolveWeixinBlockStreamingEnabled({} as OpenClawConfig, "account-1")).toBe(true);
    expect(resolveWeixinBlockStreamingEnabled(config({}), "account-1")).toBe(true);
  });

  it("uses the channel setting", () => {
    expect(
      resolveWeixinBlockStreamingEnabled(config({ blockStreaming: false }), "account-1"),
    ).toBe(false);
  });

  it("lets the account setting override the channel setting", () => {
    expect(
      resolveWeixinBlockStreamingEnabled(
        config({
          blockStreaming: false,
          accounts: { "account-1": { blockStreaming: true } },
        }),
        "account-1",
      ),
    ).toBe(true);
  });
});
