/**
 * Live (per-message) OpenClaw config resolution.
 *
 * `gateway.startAccount` hands the channel an `OpenClawConfig` snapshot in
 * `ctx.cfg`. Retaining that object for the lifetime of the long-poll loop is not
 * safe: the host republishes the config object on every config write / reload,
 * and calls carrying a superseded object are rejected — on hosts >= 2026.9.x the
 * reply pipeline then fails with `PreparedModelCatalogConfigReplacedError`
 * (`preparedModelRuntimeConfigsMatch` compares the caller's config against the
 * published prepared-model-catalog owner). The account is only restarted for
 * `channels.openclaw-weixin.*` changes (see `reload.configPrefixes`), so edits
 * anywhere else would otherwise leave the loop holding a stale object forever.
 *
 * This mirrors the host's `createRuntimeConfigReader` (used by the bundled
 * channels): decide ONCE, when the account starts, whether the startup config is
 * the host's own config; if so, always follow the host's current runtime snapshot,
 * otherwise keep the startup object (a scoped config of our own).
 *
 * The decision must not be re-evaluated per call against the original startup
 * object: after the first config write that changes content, the host's source
 * snapshot no longer matches that object, so a per-call check would fall back to
 * the stale startup config — exactly the failure this module exists to prevent.
 *
 * `createRuntimeConfigReader` is used when the host exports it; hosts that predate
 * it (down to the declared minimum, OpenClaw 2026.5.12) get an equivalent built on
 * `selectApplicableRuntimeConfig`, which those hosts do export.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import * as runtimeConfigSnapshot from "openclaw/plugin-sdk/runtime-config-snapshot";

/** Resolves the config to hand the host for the current call. */
export type LiveConfigResolver = () => OpenClawConfig;

type HostRuntimeConfigReader = (inputConfig: OpenClawConfig) => LiveConfigResolver;

/**
 * Sentinel handed to `selectApplicableRuntimeConfig` as the runtime config: it is
 * returned only when the host would follow its runtime config for `inputConfig`
 * given the current source snapshot.
 */
const FOLLOW_PROBE = Object.freeze({}) as OpenClawConfig;

/**
 * Bind the startup config snapshot to the host's current runtime config.
 *
 * @param startupConfig the `ctx.cfg` handed to `gateway.startAccount`
 */
export function createLiveConfigResolver(startupConfig: OpenClawConfig): LiveConfigResolver {
  const hostReader = (
    runtimeConfigSnapshot as { createRuntimeConfigReader?: HostRuntimeConfigReader }
  ).createRuntimeConfigReader;
  if (typeof hostReader === "function") {
    return hostReader(startupConfig);
  }

  const { getRuntimeConfigSnapshot, getRuntimeConfigSourceSnapshot, selectApplicableRuntimeConfig } =
    runtimeConfigSnapshot;
  const sourceConfig = getRuntimeConfigSourceSnapshot();
  const followsRuntimeConfig =
    getRuntimeConfigSnapshot() === startupConfig ||
    (sourceConfig != null &&
      selectApplicableRuntimeConfig({
        inputConfig: startupConfig,
        runtimeConfig: FOLLOW_PROBE,
        runtimeSourceConfig: sourceConfig,
      }) === FOLLOW_PROBE);

  return () => (followsRuntimeConfig ? getRuntimeConfigSnapshot() : null) ?? startupConfig;
}
