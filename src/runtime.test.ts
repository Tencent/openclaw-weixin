import { afterEach, describe, expect, it, vi } from "vitest";

// runtime.ts pulls in logger which in turn reaches for fs/stream paths. Stub
// the logger so these thin unit tests don't race with real log writes.
vi.mock("./util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// biome-ignore lint/suspicious/noExplicitAny: tests treat PluginRuntime shape as opaque
type AnyRuntime = any;

const MOCK_RUNTIME: AnyRuntime = {
  channel: { id: "openclaw-weixin" },
};

async function loadRuntime() {
  vi.resetModules();
  return import("./runtime.js");
}

describe("weixin runtime singleton", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("setWeixinRuntime + getWeixinRuntime round-trip", async () => {
    const mod = await loadRuntime();
    mod.setWeixinRuntime(MOCK_RUNTIME);
    expect(mod.getWeixinRuntime()).toBe(MOCK_RUNTIME);
  });

  it("getWeixinRuntime throws before initialization", async () => {
    const mod = await loadRuntime();
    expect(() => mod.getWeixinRuntime()).toThrow(/not initialized/);
  });

  it("waitForWeixinRuntime returns immediately when already set", async () => {
    const mod = await loadRuntime();
    mod.setWeixinRuntime(MOCK_RUNTIME);
    const result = await mod.waitForWeixinRuntime(100);
    expect(result).toBe(MOCK_RUNTIME);
  });

  it("waitForWeixinRuntime times out when never set", async () => {
    const mod = await loadRuntime();
    await expect(mod.waitForWeixinRuntime(50)).rejects.toThrow(/timeout/);
  });

  it("resolveWeixinChannelRuntime prefers the channelRuntime param when provided", async () => {
    const mod = await loadRuntime();
    const injected = { id: "from-ctx" };
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const result = await mod.resolveWeixinChannelRuntime({ channelRuntime: injected as any });
    expect(result).toBe(injected);
  });

  it("resolveWeixinChannelRuntime falls back to the module-global when no ctx is passed", async () => {
    const mod = await loadRuntime();
    mod.setWeixinRuntime(MOCK_RUNTIME);
    const result = await mod.resolveWeixinChannelRuntime({});
    expect(result).toBe(MOCK_RUNTIME.channel);
  });
});
