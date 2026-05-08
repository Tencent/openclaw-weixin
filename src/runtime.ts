import type { PluginRuntime } from "openclaw/plugin-sdk/core";

import { logger } from "./util/logger.js";

export type PluginChannelRuntime = PluginRuntime["channel"];

// Store the runtime on globalThis under a Symbol.for() key so multiple module
// instances of this file (which can occur when the host plugin loader instantiates
// the package via different specifiers / cache scopes) all see the same value.
//
// Background: openclaw 2026.5.x can load this plugin under more than one ESM cache
// scope per gateway boot. With a module-local `let pluginRuntime`, register() sets
// the variable in instance A while channel start-account polls waitForWeixinRuntime()
// in instance B → polling never resolves → the channel exits every 10s with
// "Weixin runtime initialization timeout" and auto-restarts forever.
//
// A Symbol.for("...") key reuses one slot on globalThis across instances, so the
// runtime state is shared regardless of how the module was imported.
const RUNTIME_KEY: unique symbol = Symbol.for(
  "@tencent-weixin/openclaw-weixin.pluginRuntime",
) as unknown as typeof RUNTIME_KEY;

type RuntimeSlot = { value: PluginRuntime | null };
const globalScope = globalThis as unknown as Record<symbol, RuntimeSlot>;
function getSlot(): RuntimeSlot {
  let slot = globalScope[RUNTIME_KEY];
  if (!slot) {
    slot = { value: null };
    globalScope[RUNTIME_KEY] = slot;
  }
  return slot;
}

/**
 * Sets the global Weixin runtime (called from plugin register).
 */
export function setWeixinRuntime(next: PluginRuntime): void {
  getSlot().value = next;
  logger.info(`[runtime] setWeixinRuntime called, runtime set successfully`);
}

/**
 * Gets the global Weixin runtime (throws if not initialized).
 */
export function getWeixinRuntime(): PluginRuntime {
  const value = getSlot().value;
  if (!value) {
    throw new Error("Weixin runtime not initialized");
  }
  return value;
}

const WAIT_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Waits for the Weixin runtime to be initialized (async polling).
 */
export async function waitForWeixinRuntime(
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<PluginRuntime> {
  const start = Date.now();
  const slot = getSlot();
  while (!slot.value) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Weixin runtime initialization timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  return slot.value;
}

/**
 * Resolves `PluginRuntime["channel"]` for the long-poll monitor.
 *
 * Prefer the gateway-injected `channelRuntime` on `ChannelGatewayContext` when present (avoids
 * races with the module-global from `register()`). Fall back to the global set by `setWeixinRuntime()`,
 * then to a short wait for legacy hosts.
 */
export async function resolveWeixinChannelRuntime(params: {
  channelRuntime?: PluginChannelRuntime;
  waitTimeoutMs?: number;
}): Promise<PluginChannelRuntime> {
  if (params.channelRuntime) {
    logger.debug("[runtime] channelRuntime from gateway context");
    return params.channelRuntime;
  }
  const value = getSlot().value;
  if (value) {
    logger.debug("[runtime] channelRuntime from register() global");
    return value.channel;
  }
  logger.warn(
    "[runtime] no channelRuntime on ctx and no global runtime yet; waiting for register()",
  );
  const pr = await waitForWeixinRuntime(params.waitTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  return pr.channel;
}
