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
 * `selectApplicableRuntimeConfig` is the host's own resolution rule, and is what
 * `createRuntimeConfigReader` (used by the bundled channels) is built on: follow
 * the republished runtime config when the retained object is the host's, and keep
 * the retained object when it is a scoped config of our own. Evaluating it per
 * call — rather than caching the decision — also keeps working across gateway
 * reloads. It is available from the declared host minimum (OpenClaw 2026.5.12)
 * onwards.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "openclaw/plugin-sdk/runtime-config-snapshot";

/** Resolves the config to hand the host for the current call. */
export type LiveConfigResolver = () => OpenClawConfig;

/**
 * Bind the startup config snapshot to the host's current runtime config.
 *
 * @param startupConfig the `ctx.cfg` handed to `gateway.startAccount`
 */
export function createLiveConfigResolver(startupConfig: OpenClawConfig): LiveConfigResolver {
  return () =>
    selectApplicableRuntimeConfig({
      inputConfig: startupConfig,
      runtimeConfig: getRuntimeConfigSnapshot(),
      runtimeSourceConfig: getRuntimeConfigSourceSnapshot(),
    }) ?? startupConfig;
}
