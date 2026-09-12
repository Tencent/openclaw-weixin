/**
 * Live (per-message) OpenClaw config resolution.
 *
 * `gateway.startAccount` hands us an `OpenClawConfig` snapshot in `ctx.cfg`. The
 * weixin monitor used to capture that object once and reuse it for the whole
 * lifetime of the long-poll loop. That breaks on hosts >= 2026.9.x: the host
 * republishes the config object on every config write / reload, and the prepared
 * model catalog rejects a call whose config no longer matches the published
 * owner — the inbound message arrives fine, then the reply fails with
 * `PreparedModelCatalogConfigReplacedError`.
 *
 * The channel account is only restarted for `channels.openclaw-weixin.*` changes
 * (see `reload.configPrefixes`), so edits elsewhere (agents, models, session)
 * silently leave us holding a superseded object. The host's own channels solve
 * this with `createRuntimeConfigReader(cfg)`, which binds a retained consumer to
 * the current runtime config while preserving scoped configs; we do the same and
 * re-read it for every inbound message.
 *
 * The accessor is resolved through a dynamic import with fallbacks instead of a
 * static import: our peer range starts at 2026.5.12 and a static import of a
 * module/export an older host does not publish would break plugin loading
 * outright.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import { logger } from "../util/logger.js";

/** Resolves the config that should be handed to the host for the current call. */
export type LiveConfigResolver = () => OpenClawConfig;

/** SDK modules that may expose the runtime-config accessors, best first. */
const SDK_MODULES = [
  "openclaw/plugin-sdk/runtime-config-snapshot",
  "openclaw/plugin-sdk/config-runtime",
] as const;

type UnknownRecord = Record<string, unknown>;

function isConfigLike(value: unknown): value is OpenClawConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFunction(value: unknown): ((...args: unknown[]) => unknown) | undefined {
  return typeof value === "function" ? (value as (...args: unknown[]) => unknown) : undefined;
}

/** Run `fn`, returning its result only when it looks like a config object. */
function callForConfig(fn: (...args: unknown[]) => unknown, ...args: unknown[]) {
  try {
    const value = fn(...args);
    return isConfigLike(value) ? value : undefined;
  } catch (err) {
    logger.debug(`live-config: accessor threw: ${String(err)}`);
    return undefined;
  }
}

/**
 * Build a per-call accessor from one SDK module, in order of preference:
 *
 * 1. `createRuntimeConfigReader(snapshot)` — the host's own retained-consumer
 *    helper: follows the republished config, keeps scoped configs untouched.
 * 2. `selectApplicableRuntimeConfig(...)` — same decision, evaluated per call.
 * 3. `getRuntimeConfigSnapshot() ?? getRuntimeConfig()` — what the bundled
 *    channels fall back to when they hold no input config.
 */
function bindModuleAccessor(
  mod: UnknownRecord,
  snapshot: OpenClawConfig,
  modulePath: string,
): (() => OpenClawConfig | undefined) | undefined {
  const createReader = asFunction(mod.createRuntimeConfigReader);
  if (createReader) {
    try {
      const reader = asFunction(createReader(snapshot));
      if (reader && callForConfig(reader)) {
        logger.info(`live-config: using ${modulePath}#createRuntimeConfigReader`);
        return () => callForConfig(reader);
      }
    } catch (err) {
      logger.debug(`live-config: createRuntimeConfigReader unusable: ${String(err)}`);
    }
  }

  const selectApplicable = asFunction(mod.selectApplicableRuntimeConfig);
  const getSnapshot = asFunction(mod.getRuntimeConfigSnapshot);
  const getSourceSnapshot = asFunction(mod.getRuntimeConfigSourceSnapshot);
  if (selectApplicable && getSnapshot) {
    const accessor = () =>
      callForConfig(selectApplicable, {
        inputConfig: snapshot,
        runtimeConfig: getSnapshot() ?? null,
        runtimeSourceConfig: getSourceSnapshot?.() ?? null,
      });
    if (accessor()) {
      logger.info(`live-config: using ${modulePath}#selectApplicableRuntimeConfig`);
      return accessor;
    }
  }

  const getRuntimeConfig = asFunction(mod.getRuntimeConfig);
  if (getSnapshot || getRuntimeConfig) {
    const accessor = () =>
      (getSnapshot ? callForConfig(getSnapshot) : undefined) ??
      (getRuntimeConfig ? callForConfig(getRuntimeConfig) : undefined);
    if (accessor()) {
      logger.info(`live-config: using ${modulePath}#getRuntimeConfigSnapshot/getRuntimeConfig`);
      return accessor;
    }
  }

  return undefined;
}

/** Loads an SDK module by path; overridable so tests need not resolve host modules. */
export type ModuleLoader = (modulePath: string) => Promise<unknown>;

const defaultModuleLoader: ModuleLoader = (modulePath) => import(modulePath);

/** Probe the plugin SDK for a usable runtime-config accessor. */
async function resolveSdkAccessor(
  snapshot: OpenClawConfig,
  load: ModuleLoader,
): Promise<(() => OpenClawConfig | undefined) | undefined> {
  for (const modulePath of SDK_MODULES) {
    let mod: UnknownRecord;
    try {
      mod = (await load(modulePath)) as UnknownRecord;
    } catch (err) {
      logger.debug(`live-config: ${modulePath} unavailable: ${String(err)}`);
      continue;
    }
    const accessor = bindModuleAccessor(mod, snapshot, modulePath);
    if (accessor) return accessor;
  }
  return undefined;
}

/**
 * Build a resolver that returns the host's current config on every call.
 *
 * @param snapshot the startup `ctx.cfg`; also the last-resort fallback
 * @param opts     `probeSdk: false` skips the SDK probe, `loadModule` overrides
 *                 how SDK modules are loaded (both for tests)
 */
export async function createLiveConfigResolver(
  snapshot: OpenClawConfig,
  opts?: { probeSdk?: boolean; loadModule?: ModuleLoader },
): Promise<LiveConfigResolver> {
  const accessor =
    opts?.probeSdk === false
      ? undefined
      : await resolveSdkAccessor(snapshot, opts?.loadModule ?? defaultModuleLoader);

  if (!accessor) {
    logger.warn(
      `live-config: host exposes no runtime-config accessor; keeping the startup config snapshot. ` +
        `On hosts that republish config (>= 2026.9.x) replies may fail with ` +
        `PreparedModelCatalogConfigReplacedError after a config change — restart the gateway to recover.`,
    );
    return () => snapshot;
  }

  let warnedFallback = false;
  return () => {
    const live = accessor();
    if (live) return live;
    if (!warnedFallback) {
      warnedFallback = true;
      logger.warn(`live-config: accessor returned no config; using the startup snapshot`);
    }
    return snapshot;
  };
}
