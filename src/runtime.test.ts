import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("./util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

async function loadRuntimeModule() {
  vi.resetModules();
  return await import("./runtime.js");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runtime helpers", () => {
  it("throws when global runtime is not initialized", async () => {
    const { getWeixinRuntime } = await loadRuntimeModule();
    expect(() => getWeixinRuntime()).toThrow("Weixin runtime not initialized");
  });

  it("sets and returns the global runtime", async () => {
    const { setWeixinRuntime, getWeixinRuntime } = await loadRuntimeModule();
    const runtime = { channel: { reply: {} } };
    setWeixinRuntime(runtime as never);
    expect(getWeixinRuntime()).toBe(runtime);
  });

  it("resolves an injected channelRuntime without reading the global runtime", async () => {
    const { resolveWeixinChannelRuntime } = await loadRuntimeModule();
    const channelRuntime = { reply: {} };
    await expect(
      resolveWeixinChannelRuntime({ channelRuntime: channelRuntime as never }),
    ).resolves.toBe(channelRuntime);
  });

  it("falls back to the global runtime channel", async () => {
    const { setWeixinRuntime, resolveWeixinChannelRuntime } = await loadRuntimeModule();
    const channel = { reply: {} };
    setWeixinRuntime({ channel } as never);
    await expect(resolveWeixinChannelRuntime({})).resolves.toBe(channel);
  });

  it("waits up to the default 30s timeout", async () => {
    vi.useFakeTimers();
    const { waitForWeixinRuntime } = await loadRuntimeModule();

    const waiting = waitForWeixinRuntime();
    const assertion = expect(waiting).rejects.toThrow(
      "Weixin runtime initialization timeout",
    );
    await vi.advanceTimersByTimeAsync(30_100);

    await assertion;
  });
});
