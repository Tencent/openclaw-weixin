import { beforeEach, describe, expect, it, vi } from "vitest";

type Cfg = import("openclaw/plugin-sdk/core").OpenClawConfig;

/** Host runtime-config state, driven per test. */
const host = {
  snapshot: null as Cfg | null,
  source: null as Cfg | null,
  /** Whether the mocked host exports `createRuntimeConfigReader` (>= newer hosts). */
  exportsReader: false,
};

/** Stand-in for the host's structural `configSnapshotsMatch`. */
const sameContent = (a: Cfg, b: Cfg) => a === b || JSON.stringify(a) === JSON.stringify(b);

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => {
  const selectApplicableRuntimeConfig = ({
    inputConfig,
    runtimeConfig,
    runtimeSourceConfig,
  }: {
    inputConfig?: Cfg;
    runtimeConfig?: Cfg | null;
    runtimeSourceConfig?: Cfg | null;
  }) => {
    if (!runtimeConfig) return inputConfig;
    if (!inputConfig) return runtimeConfig;
    if (inputConfig === runtimeConfig) return inputConfig;
    if (!runtimeSourceConfig) return runtimeConfig;
    return sameContent(inputConfig, runtimeSourceConfig) ? runtimeConfig : inputConfig;
  };
  // Mirrors the host: the follow decision is latched when the reader is created.
  const createRuntimeConfigReader = (inputConfig: Cfg) => {
    const follows =
      host.snapshot === inputConfig ||
      (host.source !== null && sameContent(inputConfig, host.source));
    return () => (follows ? host.snapshot : null) ?? inputConfig;
  };
  return {
    getRuntimeConfigSnapshot: () => host.snapshot,
    getRuntimeConfigSourceSnapshot: () => host.source,
    selectApplicableRuntimeConfig,
    get createRuntimeConfigReader() {
      return host.exportsReader ? createRuntimeConfigReader : undefined;
    },
  };
});

const { createLiveConfigResolver } = await import("./live-config.js");

const asCfg = (value: unknown) => value as Cfg;

/** Simulate a host config write: a new runtime object and a new source object. */
function publish(tag: string, extra: Record<string, unknown> = {}) {
  const runtime = asCfg({ tag, ...extra });
  host.snapshot = runtime;
  host.source = asCfg({ tag, ...extra });
  return runtime;
}

describe.each([
  ["hosts without createRuntimeConfigReader (fallback)", false],
  ["hosts exporting createRuntimeConfigReader", true],
])("createLiveConfigResolver on %s", (_label, exportsReader) => {
  beforeEach(() => {
    host.snapshot = null;
    host.source = null;
    host.exportsReader = exportsReader;
  });

  it("returns the startup config while the host has published none", () => {
    const startup = asCfg({ tag: "startup" });
    expect(createLiveConfigResolver(startup)()).toBe(startup);
  });

  it("follows the host config across successive writes that change content", () => {
    const startup = publish("v1");
    const resolve = createLiveConfigResolver(startup);
    expect(resolve()).toBe(startup);

    // Regression: the first content-changing write replaces the source snapshot,
    // which no longer matches the startup object. The resolver must keep following.
    const v2 = publish("v2", { controlUi: { allowedOrigins: ["https://example.com"] } });
    expect(resolve()).toBe(v2);

    const v3 = publish("v3", { tools: { profile: "full" } });
    expect(resolve()).toBe(v3);
  });

  it("follows when started with a same-content copy of the host source", () => {
    publish("v1");
    const resolve = createLiveConfigResolver(asCfg({ tag: "v1" }));
    const v2 = publish("v2", { changed: true });
    expect(resolve()).toBe(v2);
  });

  it("keeps a scoped startup config instead of the host's own", () => {
    publish("host");
    const scoped = asCfg({ tag: "scoped" });
    const resolve = createLiveConfigResolver(scoped);
    expect(resolve()).toBe(scoped);
    publish("host-v2", { changed: true });
    expect(resolve()).toBe(scoped);
  });

  it("falls back to the startup config while a reload has cleared the snapshot", () => {
    const startup = publish("v1");
    const resolve = createLiveConfigResolver(startup);

    host.snapshot = null;
    host.source = null;
    expect(resolve()).toBe(startup);

    const v2 = publish("v2", { changed: true });
    expect(resolve()).toBe(v2);
  });
});
