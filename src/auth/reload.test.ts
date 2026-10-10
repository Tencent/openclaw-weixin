import { describe, expect, it, vi } from "vitest";

const mutateConfigFile = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/config-mutation", () => ({ mutateConfigFile }));

import { triggerWeixinChannelReload } from "./accounts.js";

describe("triggerWeixinChannelReload", () => {
  it("updates only the Weixin timestamp in the current config", async () => {
    const draft = {
      channels: {
        "openclaw-weixin": { enabled: true, routeTag: "existing" },
        telegram: { enabled: true },
      },
      agents: { defaults: { model: "example/model" } },
    };
    mutateConfigFile.mockImplementation(async ({ mutate, afterWrite }) => {
      expect(afterWrite).toEqual({ mode: "auto" });
      mutate(draft);
    });

    await triggerWeixinChannelReload();

    expect(draft.channels.telegram).toEqual({ enabled: true });
    expect(draft.agents.defaults.model).toBe("example/model");
    expect(draft.channels["openclaw-weixin"]).toMatchObject({
      enabled: true,
      routeTag: "existing",
      channelConfigUpdatedAt: expect.any(String),
    });
  });
});
