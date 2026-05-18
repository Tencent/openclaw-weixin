import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  SESSION_EXPIRED_ERRCODE,
  pauseSession,
  clearSessionPause,
  isSessionPaused,
  getRemainingPauseMs,
  assertSessionActive,
  _resetForTest,
} from "./session-guard.js";

vi.mock("../util/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

describe("session-guard", () => {
  beforeEach(() => {
    _resetForTest();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports SESSION_EXPIRED_ERRCODE as -14", () => {
    expect(SESSION_EXPIRED_ERRCODE).toBe(-14);
  });

  it("isSessionPaused returns false when no pause set", () => {
    expect(isSessionPaused("acc1")).toBe(false);
  });

  it("getRemainingPauseMs returns 0 when no pause set", () => {
    expect(getRemainingPauseMs("acc1")).toBe(0);
  });

  it("pauseSession activates a 1-hour pause", () => {
    pauseSession("acc1");
    expect(isSessionPaused("acc1")).toBe(true);

    const remaining = getRemainingPauseMs("acc1");
    expect(remaining).toBeGreaterThan(59 * 60 * 1000);
    expect(remaining).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("pause expires after 1 hour", () => {
    pauseSession("acc1");
    expect(isSessionPaused("acc1")).toBe(true);

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(isSessionPaused("acc1")).toBe(false);
    expect(getRemainingPauseMs("acc1")).toBe(0);
  });

  it("pause is still active at 59 minutes", () => {
    pauseSession("acc1");
    vi.advanceTimersByTime(59 * 60 * 1000);
    expect(isSessionPaused("acc1")).toBe(true);
    expect(getRemainingPauseMs("acc1")).toBeGreaterThan(0);
  });

  it("pauses are per-account", () => {
    pauseSession("acc1");
    expect(isSessionPaused("acc1")).toBe(true);
    expect(isSessionPaused("acc2")).toBe(false);
  });

  it("assertSessionActive does not throw when not paused", () => {
    expect(() => assertSessionActive("acc1")).not.toThrow();
  });

  it("assertSessionActive throws when paused", () => {
    pauseSession("acc1");
    expect(() => assertSessionActive("acc1")).toThrow(/session paused/);
    expect(() => assertSessionActive("acc1")).toThrow(String(SESSION_EXPIRED_ERRCODE));
  });

  it("assertSessionActive stops throwing after pause expires", () => {
    pauseSession("acc1");
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(() => assertSessionActive("acc1")).not.toThrow();
  });

  it("re-pause resets the timer", () => {
    pauseSession("acc1");
    vi.advanceTimersByTime(50 * 60 * 1000);
    expect(isSessionPaused("acc1")).toBe(true);

    pauseSession("acc1");
    vi.advanceTimersByTime(50 * 60 * 1000);
    expect(isSessionPaused("acc1")).toBe(true);

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(isSessionPaused("acc1")).toBe(false);
  });

  it("pauseSession honors a custom durationMs (#155 backoff)", () => {
    pauseSession("acc1", 5_000);
    expect(isSessionPaused("acc1")).toBe(true);
    expect(getRemainingPauseMs("acc1")).toBeLessThanOrEqual(5_000);

    vi.advanceTimersByTime(5_000);
    expect(isSessionPaused("acc1")).toBe(false);
  });

  it("clearSessionPause removes an active pause (#155 recovery)", () => {
    pauseSession("acc1");
    expect(isSessionPaused("acc1")).toBe(true);

    clearSessionPause("acc1");
    expect(isSessionPaused("acc1")).toBe(false);
    expect(getRemainingPauseMs("acc1")).toBe(0);
    expect(() => assertSessionActive("acc1")).not.toThrow();
  });

  it("clearSessionPause is a no-op when no pause is set", () => {
    expect(() => clearSessionPause("acc1")).not.toThrow();
    expect(isSessionPaused("acc1")).toBe(false);
  });

  it("clearSessionPause is per-account", () => {
    pauseSession("acc1");
    pauseSession("acc2");
    clearSessionPause("acc1");
    expect(isSessionPaused("acc1")).toBe(false);
    expect(isSessionPaused("acc2")).toBe(true);
  });
});
