import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

const mocks = vi.hoisted(() => ({
  mutateConfigFile: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/config-mutation", () => ({
  mutateConfigFile: mocks.mutateConfigFile,
}));
vi.mock("../util/logger.js", () => ({
  logger: { info: vi.fn(), warn: mocks.warn },
}));

import { triggerWeixinChannelReload } from "./accounts.js";

describe("triggerWeixinChannelReload", () => {
  beforeEach(() => vi.resetAllMocks());

  it("preserves current source config and lets the host plan the reload", async () => {
    const draft: OpenClawConfig = {
      channels: {
        "openclaw-weixin": { accounts: { bot: { enabled: true } }, routeTag: "existing" },
        telegram: { enabled: false },
      },
      gateway: { port: 12345 },
    };
    mocks.mutateConfigFile.mockImplementation(async ({ mutate }) => mutate(draft));

    await triggerWeixinChannelReload();

    expect(mocks.mutateConfigFile).toHaveBeenCalledWith({
      afterWrite: { mode: "auto" },
      mutate: expect.any(Function),
    });
    expect(draft).toEqual({
      channels: {
        "openclaw-weixin": {
          accounts: { bot: { enabled: true } },
          routeTag: "existing",
          channelConfigUpdatedAt: expect.any(String),
        },
        telegram: { enabled: false },
      },
      gateway: { port: 12345 },
    });
  });

  it("records a failed reload without discarding saved credentials", async () => {
    mocks.mutateConfigFile.mockRejectedValue(new Error("config conflict"));
    await expect(triggerWeixinChannelReload()).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("config conflict"));
  });
});
