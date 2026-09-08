import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { resolvePartialQuote } from "./partial-quote.js";

function md5(value: string): string {
  return crypto.createHash("md5").update(value, "utf8").digest("hex");
}

describe("resolvePartialQuote", () => {
  it("resolves the protocol example using global occurrence indexes", () => {
    expect(
      resolvePartialQuote("abcedfabcgh", {
        start: "a",
        end: "c",
        startindex: 1,
        endindex: 1,
        quotemd5: md5("abc"),
      }),
    ).toEqual({ resolved: "abc", fallback: false });
  });

  it("uses the hash to support end indexes relative to the selected start", () => {
    const full = "x-end start first-end second-end";
    const selected = "start first-end second-end";
    expect(
      resolvePartialQuote(full, {
        start: "start",
        end: "end",
        startindex: 0,
        endindex: 1,
        quotemd5: md5(selected),
      }),
    ).toEqual({ resolved: selected, fallback: false });
  });

  it("falls back when indexes are invalid or the hash does not match", () => {
    expect(
      resolvePartialQuote("hello", {
        start: "h",
        end: "o",
        startindex: -1,
        endindex: 0,
        quotemd5: "",
      }),
    ).toEqual({ resolved: null, fallback: true });
    expect(
      resolvePartialQuote("hello", {
        start: "h",
        end: "o",
        startindex: 0,
        endindex: 0,
        quotemd5: "not-the-md5",
      }),
    ).toEqual({ resolved: null, fallback: true });
  });
});
