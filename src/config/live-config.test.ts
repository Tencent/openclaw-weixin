import { describe, expect, it, vi } from "vitest";

import { createLiveConfigResolver } from "./live-config.js";

vi.mock("../util/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type Cfg = import("openclaw/plugin-sdk/core").OpenClawConfig;

const asCfg = (v: unknown) => v as Cfg;
const tagOf = (cfg: Cfg) => (cfg as unknown as { tag?: string }).tag;

/** Stand-in for the host module probed via dynamic import. */
type HostModule = Record<string, unknown>;

function resolverWithHost(host: HostModule, snapshot: Cfg) {
  return createLiveConfigResolver(snapshot, {
    loadModule: async (modulePath) => {
      if (modulePath === "openclaw/plugin-sdk/runtime-config-snapshot") return host;
      throw new Error(`module not found: ${modulePath}`);
    },
  });
}

describe("createLiveConfigResolver", () => {
  it("falls back to the startup snapshot when the host exposes no accessor", async () => {
    const snapshot = asCfg({ tag: "snapshot" });
    const resolve = await createLiveConfigResolver(snapshot, { probeSdk: false });
    expect(resolve()).toBe(snapshot);
  });

  it("prefers createRuntimeConfigReader and re-reads it per call", async () => {
    const snapshot = asCfg({ tag: "v1" });
    let current = snapshot;
    const resolve = await resolverWithHost(
      { createRuntimeConfigReader: (input: Cfg) => () => current ?? input },
      snapshot,
    );

    expect(resolve()).toBe(snapshot);
    // Host republished the config (config write / reload).
    current = asCfg({ tag: "v2" });
    expect(tagOf(resolve())).toBe("v2");
    current = asCfg({ tag: "v3" });
    expect(tagOf(resolve())).toBe("v3");
  });

  it("uses selectApplicableRuntimeConfig when no reader factory exists", async () => {
    const snapshot = asCfg({ tag: "snapshot" });
    const live = asCfg({ tag: "live" });
    const seen: unknown[] = [];
    const resolve = await resolverWithHost(
      {
        getRuntimeConfigSnapshot: () => live,
        getRuntimeConfigSourceSnapshot: () => snapshot,
        selectApplicableRuntimeConfig: (params: unknown) => {
          seen.push(params);
          return live;
        },
      },
      snapshot,
    );
    expect(resolve()).toBe(live);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("falls back to getRuntimeConfigSnapshot/getRuntimeConfig", async () => {
    const snapshot = asCfg({ tag: "snapshot" });
    const live = asCfg({ tag: "live" });
    const resolve = await resolverWithHost({ getRuntimeConfig: () => live }, snapshot);
    expect(resolve()).toBe(live);
  });

  it("ignores accessors that throw or return non-configs", async () => {
    const snapshot = asCfg({ tag: "snapshot" });
    const resolve = await resolverWithHost(
      {
        createRuntimeConfigReader: () => () => {
          throw new Error("not available in this phase");
        },
        getRuntimeConfigSnapshot: () => undefined,
        getRuntimeConfig: () => "nope",
      },
      snapshot,
    );
    expect(resolve()).toBe(snapshot);
  });

  it("falls back per call when a working accessor later returns nothing", async () => {
    const snapshot = asCfg({ tag: "snapshot" });
    const live = asCfg({ tag: "live" });
    let give = true;
    const resolve = await resolverWithHost(
      { createRuntimeConfigReader: () => () => (give ? live : undefined) },
      snapshot,
    );
    expect(resolve()).toBe(live);
    give = false;
    expect(resolve()).toBe(snapshot);
    give = true;
    expect(resolve()).toBe(live);
  });
});
