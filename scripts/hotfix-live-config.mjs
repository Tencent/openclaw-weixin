#!/usr/bin/env node
/**
 * Hotfix for installed @tencent-weixin/openclaw-weixin builds (<= 2.4.9-beta.0)
 * running on OpenClaw >= 2026.9.x.
 *
 * Problem: the monitor loop reuses the `ctx.cfg` snapshot captured when the
 * account started. Newer hosts republish the config object on every config
 * write / reload, and the prepared model catalog rejects a call whose config no
 * longer matches the published owner — inbound messages arrive, then the reply
 * fails with `PreparedModelCatalogConfigReplacedError`.
 *
 * Fix: patch `dist/monitor/monitor.js` so each inbound message re-reads the
 * host's current runtime config (the same accessors the bundled channels use)
 * and falls back to the startup snapshot when the host has none.
 *
 * Usage:
 *   node scripts/hotfix-live-config.mjs [--plugin-dir <dir>] [--check|--revert]
 *
 * The original file is copied to `<file>.weixin-livecfg.bak` before patching;
 * `--revert` restores it. Re-run after upgrading/reinstalling the plugin.
 */

import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const PKG = "@tencent-weixin/openclaw-weixin";
const TARGET_RELS = [
  path.join("dist", "src", "monitor", "monitor.js"),
  path.join("dist", "monitor", "monitor.js"),
];
const BACKUP_SUFFIX = ".weixin-livecfg.bak";
const MARKER = "__weixinLiveConfig";

/** Matches the single `processOneMessage` call site, whatever the emitted indentation is. */
const ANCHOR = /(await processOneMessage\(\s*full\s*,\s*\{\s*accountId,\s*)config,/;

const HELPER = `
// --- weixin live-config hotfix (scripts/hotfix-live-config.mjs) ---
let __weixinCfgRuntime = null;
for (const __weixinCfgModule of [
    "openclaw/plugin-sdk/runtime-config-snapshot",
    "openclaw/plugin-sdk/config-runtime",
]) {
    try {
        __weixinCfgRuntime = await import(__weixinCfgModule);
        if (__weixinCfgRuntime?.getRuntimeConfigSnapshot || __weixinCfgRuntime?.getRuntimeConfig) break;
        __weixinCfgRuntime = null;
    }
    catch {
        __weixinCfgRuntime = null;
    }
}
/** Returns the host's current config, or the startup snapshot when unavailable. */
function ${MARKER}(snapshot) {
    try {
        const runtimeConfig = __weixinCfgRuntime?.getRuntimeConfigSnapshot?.() ?? null;
        const select = __weixinCfgRuntime?.selectApplicableRuntimeConfig;
        if (select && runtimeConfig) {
            const picked = select({
                inputConfig: snapshot,
                runtimeConfig,
                runtimeSourceConfig: __weixinCfgRuntime?.getRuntimeConfigSourceSnapshot?.() ?? null,
            });
            if (picked && typeof picked === "object")
                return picked;
        }
        const live = runtimeConfig ?? __weixinCfgRuntime?.getRuntimeConfig?.();
        if (live && typeof live === "object")
            return live;
    }
    catch {
        // fall through to the startup snapshot
    }
    return snapshot;
}
// --- end weixin live-config hotfix ---
`;

function parseArgs(argv) {
  const args = { mode: "apply", pluginDir: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") args.mode = "check";
    else if (arg === "--revert") args.mode = "revert";
    else if (arg === "--plugin-dir") args.pluginDir = argv[(i += 1)];
    else if (arg === "-h" || arg === "--help") args.mode = "help";
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/** Candidate install roots, in the order we search them. */
function candidateDirs(explicit) {
  if (explicit) return [path.resolve(explicit)];
  const home = homedir();
  const roots = [
    process.cwd(),
    path.join(home, ".openclaw"),
    path.join(home, ".openclaw", "plugins"),
    path.join(home, ".local", "share", "openclaw"),
    "/usr/local/lib",
    "/usr/lib",
    "/opt/homebrew/lib",
  ];
  const dirs = [];
  for (const root of roots) {
    dirs.push(path.join(root, "node_modules", PKG));
    dirs.push(path.join(root, PKG));
  }
  return dirs;
}

function resolveTarget(explicit) {
  for (const dir of candidateDirs(explicit)) {
    for (const rel of TARGET_RELS) {
      const target = path.join(dir, rel);
      if (existsSync(target)) return target;
    }
  }
  throw new Error(
    `could not find ${PKG}/${TARGET_RELS[0]}.\n` +
      `Pass the install directory explicitly:\n` +
      `  node scripts/hotfix-live-config.mjs --plugin-dir /path/to/${PKG}`,
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "help") {
    console.log(
      `Usage: node scripts/hotfix-live-config.mjs [--plugin-dir <dir>] [--check|--revert]`,
    );
    return;
  }

  const target = resolveTarget(args.pluginDir);
  const backup = `${target}${BACKUP_SUFFIX}`;
  const source = readFileSync(target, "utf8");
  const patched = source.includes(MARKER);

  if (args.mode === "check") {
    console.log(`target : ${target}`);
    console.log(`patched: ${patched ? "yes" : "no"}`);
    console.log(`backup : ${existsSync(backup) ? backup : "(none)"}`);
    return;
  }

  if (args.mode === "revert") {
    if (!existsSync(backup)) throw new Error(`no backup to restore: ${backup}`);
    copyFileSync(backup, target);
    console.log(`reverted ${target} from ${backup}`);
    console.log(`Restart the gateway: openclaw gateway restart`);
    return;
  }

  if (patched) {
    console.log(`already patched: ${target}`);
    return;
  }

  const occurrences = source.match(new RegExp(ANCHOR, "g"))?.length ?? 0;
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly 1 processOneMessage call site in ${target}, found ${occurrences}. ` +
        `This build differs from the one this hotfix targets — do not patch it blindly.`,
    );
  }

  copyFileSync(target, backup);
  const output = `${source.replace(ANCHOR, `$1config: ${MARKER}(config),`)}${HELPER}`;
  writeFileSync(target, output, "utf8");
  console.log(`patched  ${target}`);
  console.log(`backup   ${backup}`);
  console.log(`Restart the gateway to load it: openclaw gateway restart`);
  console.log(`Revert with: node scripts/hotfix-live-config.mjs --revert`);
}

try {
  main();
} catch (err) {
  console.error(`hotfix failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
