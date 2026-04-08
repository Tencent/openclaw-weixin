import { describe, expect, it, vi } from "vitest";

vi.mock("./util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

async function loadModule() {
  vi.resetModules();
  return await import("./runtime.js");
}

describe("runtime", () => {
  it("throws when runtime has not been initialized", async () => {
    const { getWeixinRuntime } = await loadModule();
    expect(() => getWeixinRuntime()).toThrow("Weixin runtime not initialized");
  });

  it("returns the runtime after initialization", async () => {
    const { setWeixinRuntime, getWeixinRuntime } = await loadModule();
    const runtime = { channel: { id: "chan-a" } } as any;

    setWeixinRuntime(runtime);

    expect(getWeixinRuntime()).toBe(runtime);
  });

  it("waits until runtime is initialized", async () => {
    const { waitForWeixinRuntime, setWeixinRuntime } = await loadModule();
    const runtime = { channel: { id: "chan-b" } } as any;

    const promise = waitForWeixinRuntime(500);
    setTimeout(() => setWeixinRuntime(runtime), 10);

    await expect(promise).resolves.toBe(runtime);
  });

  it("times out when runtime is never initialized", async () => {
    const { waitForWeixinRuntime } = await loadModule();
    await expect(waitForWeixinRuntime(1)).rejects.toThrow("Weixin runtime initialization timeout");
  });

  it("prefers channelRuntime from params when provided", async () => {
    const { resolveWeixinChannelRuntime, setWeixinRuntime } = await loadModule();
    const globalRuntime = { channel: { id: "global" } } as any;
    const directChannel = { id: "direct" } as any;

    setWeixinRuntime(globalRuntime);

    await expect(
      resolveWeixinChannelRuntime({ channelRuntime: directChannel, waitTimeoutMs: 1 }),
    ).resolves.toBe(directChannel);
  });

  it("falls back to global runtime channel when no direct channelRuntime exists", async () => {
    const { resolveWeixinChannelRuntime, setWeixinRuntime } = await loadModule();
    const globalRuntime = { channel: { id: "global-only" } } as any;

    setWeixinRuntime(globalRuntime);

    await expect(resolveWeixinChannelRuntime({})).resolves.toBe(globalRuntime.channel);
  });

  it("waits for runtime inside resolveWeixinChannelRuntime when needed", async () => {
    const { resolveWeixinChannelRuntime, setWeixinRuntime } = await loadModule();
    const runtime = { channel: { id: "late" } } as any;

    const promise = resolveWeixinChannelRuntime({ waitTimeoutMs: 500 });
    setTimeout(() => setWeixinRuntime(runtime), 10);

    await expect(promise).resolves.toBe(runtime.channel);
  });
});
