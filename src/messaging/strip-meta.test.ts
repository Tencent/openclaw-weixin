import { describe, it, expect } from "vitest";
import { stripInboundMetadata } from "./strip-meta";

describe("stripInboundMetadata", () => {
  it("passes through normal text unchanged", () => {
    const input = "Hello, how can I help you today?";
    expect(stripInboundMetadata(input)).toBe(input);
  });

  it("passes through empty string", () => {
    expect(stripInboundMetadata("")).toBe("");
  });

  it("passes through text that mentions metadata-like terms but not actual sentinels", () => {
    const input = "Let me check the conversation info for you.";
    expect(stripInboundMetadata(input)).toBe(input);
  });

  it("strips a Conversation info metadata block", () => {
    const input = [
      "Here is my reply.",
      "",
      "Conversation info (untrusted metadata):",
      "```json",
      '{ "foo": "bar" }',
      "```",
    ].join("\n");
    const result = stripInboundMetadata(input);
    expect(result).toBe("Here is my reply.");
  });

  it("strips a Conversation info block with timestamp prefix", () => {
    const input = [
      "My response",
      "",
      "[Sat 2026-07-04 17:45 GMT+8] Conversation info (untrusted metadata):",
      "```json",
      '{ "foo": "bar" }',
      "```",
      "",
      "More text",
    ].join("\n");
    const result = stripInboundMetadata(input);
    expect(result).toBe("My response\n\nMore text");
  });

  it("strips a Sender metadata block", () => {
    const input = [
      "Sender (untrusted metadata):",
      "```json",
      '{ "sender": "test" }',
      "```",
      "",
      "Reply text",
    ].join("\n");
    const result = stripInboundMetadata(input);
    expect(result).toBe("Reply text");
  });

  it("strips Thread starter block", () => {
    const input = [
      "Thread starter (untrusted, for context):",
      "```json",
      '{ "text": "hello" }',
      "```",
      "Reply",
    ].join("\n");
    const result = stripInboundMetadata(input);
    expect(result).toBe("Reply");
  });

  it("strips Reply target block", () => {
    const input = [
      "Reply target of current user message (untrusted, for context):",
      "```json",
      '{ "text": "target" }',
      "```",
      "Reply",
    ].join("\n");
    const result = stripInboundMetadata(input);
    expect(result).toBe("Reply");
  });

  it("strips Forwarded message context block", () => {
    const input = [
      "Forwarded message context (untrusted metadata):",
      "```json",
      '{ "text": "forwarded" }',
      "```",
      "Reply",
    ].join("\n");
    const result = stripInboundMetadata(input);
    expect(result).toBe("Reply");
  });

  it("strips Chat history block", () => {
    const input = [
      "Chat history since last reply (untrusted, for context):",
      "```json",
      '[{"role":"user","content":"hi"}]',
      "```",
      "Reply",
    ].join("\n");
    const result = stripInboundMetadata(input);
    expect(result).toBe("Reply");
  });

  it("strips multiple metadata blocks", () => {
    const input = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{ "foo": "bar" }',
      "```",
      "",
      "Sender (untrusted metadata):",
      "```json",
      '{ "sender": "test" }',
      "```",
      "",
      "Real reply here",
    ].join("\n");
    const result = stripInboundMetadata(input);
    expect(result).toBe("Real reply here");
  });

  it("handles sentinel followed by non-fenced content gracefully", () => {
    const input = [
      "Conversation info (untrusted metadata):",
      "Not a fenced code block",
      "Real text",
    ].join("\n");
    // Should keep all lines since it's not a proper meta block (no ```json following)
    const result = stripInboundMetadata(input);
    expect(result).toContain("Conversation info");
    expect(result).toContain("Not a fenced code block");
    expect(result).toContain("Real text");
  });
});
