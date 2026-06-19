/**
 * Regression test for #155: outbound REST calls (sendMessage / sendMedia /
 * sendTyping) must NOT be gated on the long-poll session-pause state.
 *
 * The bug was that `assertSessionActive` was called from the outbound send
 * paths in channel.ts, so a long-poll cooldown set by `pauseSession` would
 * block REST traffic that has nothing to do with the long-poll session.
 *
 * The fix is to leave the session-pause map untouched by outbound paths and
 * let the REST API surface its own server-side errors. These tests pin that
 * contract at the `sendMessageWeixin` boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { mockSendMessageApi } = vi.hoisted(() => ({
  mockSendMessageApi: vi.fn(),
}));

vi.mock("../api/api.js", () => ({
  sendMessage: mockSendMessageApi,
}));

vi.mock("node:crypto", () => ({
  default: {
    randomBytes: vi.fn(() => Buffer.from("deadbeef", "hex")),
  },
}));

vi.mock("openclaw/plugin-sdk", () => ({
  stripMarkdown: (text: string) => text,
}));

import { sendMessageWeixin } from "./send.js";
import { pauseSession, _resetForTest } from "../api/session-guard.js";

beforeEach(() => {
  _resetForTest();
  mockSendMessageApi.mockReset();
  mockSendMessageApi.mockResolvedValue(undefined);
});

describe("outbound REST is independent of long-poll pause (#155)", () => {
  it("sendMessageWeixin succeeds while the session is paused", async () => {
    // Simulate the monitor having just hit -14 and set a long pause.
    pauseSession("acc-1");

    await expect(
      sendMessageWeixin({
        to: "user-1",
        text: "hello while paused",
        opts: {
          baseUrl: "https://test.example/",
          token: "tok",
          contextToken: "ctx",
        },
      }),
    ).resolves.toMatchObject({ messageId: expect.any(String) });

    expect(mockSendMessageApi).toHaveBeenCalledTimes(1);
  });

  it("sendMessageWeixin does not consult or mutate the pause map", async () => {
    pauseSession("acc-1");
    const before = (await import("../api/session-guard.js")).getRemainingPauseMs(
      "acc-1",
    );

    await sendMessageWeixin({
      to: "user-2",
      text: "still working",
      opts: { baseUrl: "https://test.example/", token: "tok", contextToken: "ctx" },
    });

    const after = (await import("../api/session-guard.js")).getRemainingPauseMs(
      "acc-1",
    );
    // The outbound path must neither clear nor extend the pause window.
    // Allow a tiny delta for elapsed wall time during the test.
    expect(Math.abs(before - after)).toBeLessThan(1_000);
  });

  it("propagates the underlying REST error without touching pause state", async () => {
    pauseSession("acc-1");
    mockSendMessageApi.mockRejectedValueOnce(new Error("server -14: re-login"));

    await expect(
      sendMessageWeixin({
        to: "user-3",
        text: "boom",
        opts: { baseUrl: "https://test.example/", token: "tok", contextToken: "ctx" },
      }),
    ).rejects.toThrow(/server -14/);

    // Pause was not implicitly cleared by an outbound failure either.
    const { isSessionPaused } = await import("../api/session-guard.js");
    expect(isSessionPaused("acc-1")).toBe(true);
  });
});
