/**
 * Runtime host-version compatibility check for openclaw-weixin.
 *
 * OpenClaw uses a date-based version format: YYYY.M.DD (e.g. 2026.3.22).
 * This module parses that format and validates the running host is within
 * the supported range for this plugin version.
 */

import { logger } from "./util/logger.js";

export const SUPPORTED_HOST_MIN = "2026.3.22";

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
  return compareVersions(host, min) >= 0;
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
