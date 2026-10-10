import { describe, expect, it } from "vitest";
import { weixinPlugin } from "./channel.js";

describe("Weixin channel status summary contract", () => {
  it.each([true, false, undefined])(
    "forwards runtime running=%s and preserves existing facts",
    async (running) => {
      const build = weixinPlugin.status?.buildChannelSummary;
      if (!build) throw new Error("Weixin status summary is not registered");
      const summary = await build({
        account: {
          accountId: "contract-account",
          enabled: true,
          configured: true,
          baseUrl: "https://example.test",
          cdnBaseUrl: "https://cdn.example.test",
        },
        cfg: {},
        defaultAccountId: "contract-account",
        snapshot: {
          accountId: "contract-account",
          configured: true,
          ...(running === undefined ? {} : { running }),
          lastError: "preserved error",
          lastInboundAt: 1000,
          lastOutboundAt: 2000,
        },
      });
      expect(summary).toEqual({
        configured: true,
        running: running ?? false,
        lastError: "preserved error",
        lastInboundAt: 1000,
        lastOutboundAt: 2000,
      });
      expect(summary).not.toHaveProperty("connected");
    },
  );
});
