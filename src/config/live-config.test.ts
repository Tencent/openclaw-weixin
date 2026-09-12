import { describe, expect, it, vi } from "vitest";

import { createLiveConfigResolver } from "./live-config.js";

type Cfg = import("openclaw/plugin-sdk/core").OpenClawConfig;

/** Host runtime-config state, driven per test. */
const host = {
  snapshot: null as Cfg | null,
  source: null as Cfg | null,
};

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfigSnapshot: () => host.snapshot,
  getRuntimeConfigSourceSnapshot: () => host.source,
  // Mirrors the host rule: follow the republished config when the retained
  // object is the one the host published, otherwise keep the retained object.
  selectApplicableRuntimeConfig: ({
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
    return inputConfig === runtimeSourceConfig ? runtimeConfig : inputConfig;
  },
}));

const asCfg = (value: unknown) => value as Cfg;

describe("createLiveConfigResolver", () => {
  it("returns the startup config while the host has published none", () => {
    const startup = asCfg({ tag: "startup" });
    host.snapshot = null;
    host.source = null;
    expect(createLiveConfigResolver(startup)()).toBe(startup);
  });

  it("follows the host config republished after a config write", () => {
    const startup = asCfg({ tag: "v1" });
    host.snapshot = startup;
    host.source = startup;
    const resolve = createLiveConfigResolver(startup);
    expect(resolve()).toBe(startup);

    // Host reloaded: a new config object replaced the one we were handed.
    const republished = asCfg({ tag: "v2" });
    host.snapshot = republished;
    host.source = startup;
    expect(resolve()).toBe(republished);

    const again = asCfg({ tag: "v3" });
    host.snapshot = again;
    expect(resolve()).toBe(again);
  });

  it("keeps a scoped startup config instead of the host's own", () => {
    const scoped = asCfg({ tag: "scoped" });
    host.snapshot = asCfg({ tag: "host" });
    host.source = asCfg({ tag: "host-source" });
    expect(createLiveConfigResolver(scoped)()).toBe(scoped);
  });

  it("re-reads on every call rather than caching the decision", () => {
    const startup = asCfg({ tag: "startup" });
    host.snapshot = startup;
    host.source = startup;
    const resolve = createLiveConfigResolver(startup);

    const first = asCfg({ tag: "first" });
    host.snapshot = first;
    expect(resolve()).toBe(first);

    // Gateway shut the snapshot down (e.g. reload in progress).
    host.snapshot = null;
    expect(resolve()).toBe(startup);

    const second = asCfg({ tag: "second" });
    host.snapshot = second;
    expect(resolve()).toBe(second);
  });
});
