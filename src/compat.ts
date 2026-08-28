/**
 * Runtime host-version compatibility check for openclaw-weixin.
 *
 * OpenClaw uses a date-based version format: YYYY.M.DD (e.g. 2026.3.22).
 * This module parses that format and validates the running host is within
 * the supported range for this plugin version.
 */

import { logger } from "./util/logger.js";

export const SUPPORTED_HOST_MIN = "2026.8.1-beta.3";

export interface OpenClawVersion {
  year: number;
  month: number;
  day: number;
}

/**
 * Parse an OpenClaw date version string (e.g. "2026.3.22") into components.
 * Returns null for unparseable strings.
 */
export function parseOpenClawVersion(version: string): OpenClawVersion | null {
  // Strip any pre-release suffix (e.g. "2026.3.22-beta.1" -> "2026.3.22")
  const base = version.trim().split("-")[0];
  const parts = base.split(".");
  if (parts.length !== 3) return null;
  const [year, month, day] = parts.map(Number);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return null;
  return { year, month, day };
}

/**
 * Compare two parsed versions.  Returns -1 | 0 | 1.
 */
export function compareVersions(a: OpenClawVersion, b: OpenClawVersion): -1 | 0 | 1 {
  for (const key of ["year", "month", "day"] as const) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  return 0;
}

/**
 * Check whether a host version string is >= SUPPORTED_HOST_MIN.
 */
export function isHostVersionSupported(hostVersion: string): boolean {
  const host = parseOpenClawVersion(hostVersion);
  if (!host) return false;
  const min = parseOpenClawVersion(SUPPORTED_HOST_MIN)!;
  const releaseComparison = compareVersions(host, min);
  if (releaseComparison !== 0) return releaseComparison > 0;

  const prerelease = hostVersion.trim().split("+")[0].split("-").slice(1).join("-");
  if (!prerelease) return true;
  const actual = prerelease.split(".");
  const required = SUPPORTED_HOST_MIN.split("-")[1].split(".");
  for (let i = 0; i < Math.max(actual.length, required.length); i++) {
    if (actual[i] === undefined) return false;
    if (required[i] === undefined) return true;
    if (actual[i] === required[i]) continue;
    const aNumeric = /^\d+$/.test(actual[i]);
    const bNumeric = /^\d+$/.test(required[i]);
    if (aNumeric && bNumeric) return Number(actual[i]) > Number(required[i]);
    if (aNumeric !== bNumeric) return !aNumeric;
    return actual[i] > required[i];
  }
  return true;
}

/**
 * Fail-fast guard.  Call at the very start of `register()` to prevent the
 * plugin from loading on an incompatible host.
 *
 * @throws {Error} with a human-readable message when the host is out of range.
 */
export function assertHostCompatibility(hostVersion: string | undefined): void {
  if (!hostVersion || hostVersion === "unknown") {
    logger.warn(
      `[compat] Could not determine host OpenClaw version; skipping compatibility check.`,
    );
    return;
  }
  if (isHostVersionSupported(hostVersion)) {
    logger.info(`[compat] Host OpenClaw ${hostVersion} >= ${SUPPORTED_HOST_MIN}, OK.`);
    return;
  }
  throw new Error(
    `This version of openclaw-weixin requires OpenClaw >=${SUPPORTED_HOST_MIN}, ` +
    `but found ${hostVersion}. ` +
    `Please upgrade OpenClaw, or install the compatible track for older hosts:\n` +
    `  npx @tencent-weixin/openclaw-weixin-cli install`,
  );
}
