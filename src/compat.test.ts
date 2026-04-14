import { describe, it, expect } from "vitest";

import {
  parseOpenClawVersion,
  compareVersions,
  isHostVersionSupported,
  assertHostCompatibility,
  SUPPORTED_HOST_MIN,
} from "./compat.js";

describe("parseOpenClawVersion", () => {
  it("parses a standard version", () => {
    expect(parseOpenClawVersion("2026.3.22")).toEqual({ year: 2026, month: 3, day: 22 });
  });

  it("parses a version with pre-release suffix", () => {
    expect(parseOpenClawVersion("2026.3.22-beta.1")).toEqual({ year: 2026, month: 3, day: 22 });
  });

  it("returns null for malformed strings", () => {
    expect(parseOpenClawVersion("")).toBeNull();
    expect(parseOpenClawVersion("abc")).toBeNull();
    expect(parseOpenClawVersion("2026.3")).toBeNull();
    expect(parseOpenClawVersion("2026.3.22.1")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions({ year: 2026, month: 3, day: 22 }, { year: 2026, month: 3, day: 22 })).toBe(0);
  });

  it("compares by year first", () => {
    expect(compareVersions({ year: 2025, month: 12, day: 31 }, { year: 2026, month: 1, day: 1 })).toBe(-1);
  });

  it("compares by month then day", () => {
    expect(compareVersions({ year: 2026, month: 3, day: 22 }, { year: 2026, month: 3, day: 21 })).toBe(1);
    expect(compareVersions({ year: 2026, month: 3, day: 22 }, { year: 2026, month: 4, day: 1 })).toBe(-1);
  });
});

describe("isHostVersionSupported", () => {
  it("accepts the minimum version", () => {
    expect(isHostVersionSupported(SUPPORTED_HOST_MIN)).toBe(true);
  });

  it("rejects the day before the minimum", () => {
    expect(isHostVersionSupported("2026.3.21")).toBe(false);
  });

  it("accepts a version above the minimum", () => {
    expect(isHostVersionSupported("2026.3.30")).toBe(true);
  });

  it("accepts a future version", () => {
    expect(isHostVersionSupported("2026.4.0")).toBe(true);
    expect(isHostVersionSupported("2027.1.1")).toBe(true);
  });

  it("rejects garbage input", () => {
    expect(isHostVersionSupported("not-a-version")).toBe(false);
  });
});

describe("assertHostCompatibility", () => {
  it("does not throw for a supported version", () => {
    expect(() => assertHostCompatibility("2026.3.22")).not.toThrow();
  });

  it("does not throw when version is undefined (graceful skip)", () => {
    expect(() => assertHostCompatibility(undefined)).not.toThrow();
  });

  it("throws for an unsupported version with a helpful message", () => {
    expect(() => assertHostCompatibility("2026.1.5")).toThrowError(
      new RegExp(`This version of openclaw-weixin requires.*${SUPPORTED_HOST_MIN}`),
    );
  });
});
