import { describe, it, expect } from "vitest";

import { isSilentOutboundText } from "./silent-reply.js";

describe("isSilentOutboundText", () => {
  it("suppresses exact NO_REPLY token", () => {
    expect(isSilentOutboundText("NO_REPLY")).toBe(true);
  });

  it("suppresses case-insensitive no_reply token", () => {
    expect(isSilentOutboundText("no_reply")).toBe(true);
    expect(isSilentOutboundText("No_Reply")).toBe(true);
  });

  it("suppresses whitespace-padded silent tokens", () => {
    expect(isSilentOutboundText("  NO_REPLY  ")).toBe(true);
  });

  it("does not suppress empty or substantive text", () => {
    expect(isSilentOutboundText("")).toBe(false);
    expect(isSilentOutboundText(undefined)).toBe(false);
    expect(isSilentOutboundText("hello")).toBe(false);
    expect(isSilentOutboundText("Done.\n\nNO_REPLY")).toBe(false);
  });
});
