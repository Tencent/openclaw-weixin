import { describe, expect, it, vi } from "vitest";

import { parseOwnerChoice, PROMPT_OWNER, readOwnerChoice } from "./bind-owner-prompt.js";

describe("parseOwnerChoice", () => {
  it("treats empty input and Y as self", () => {
    expect(parseOwnerChoice("")).toBe("self");
    expect(parseOwnerChoice("  ")).toBe("self");
    expect(parseOwnerChoice("Y")).toBe("self");
    expect(parseOwnerChoice("y")).toBe("self");
  });

  it("treats n as other", () => {
    expect(parseOwnerChoice("n")).toBe("other");
    expect(parseOwnerChoice("N")).toBe("other");
  });

  it("does not guess yes or no", () => {
    expect(parseOwnerChoice("yes")).toBe("invalid");
    expect(parseOwnerChoice("no")).toBe("invalid");
    expect(parseOwnerChoice("x")).toBe("invalid");
  });
});

describe("readOwnerChoice", () => {
  it("writes the prompt once when the first line is empty", async () => {
    const write = vi.fn();
    const readLine = vi.fn(async () => "");
    await expect(readOwnerChoice({ readLine, write })).resolves.toBe("self");
    expect(write).toHaveBeenCalledWith(PROMPT_OWNER);
    expect(readLine).toHaveBeenCalledOnce();
  });

  it("asks again after an unrecognized answer and then accepts n", async () => {
    const write = vi.fn();
    const readLine = vi.fn().mockResolvedValueOnce("yes").mockResolvedValueOnce("n");
    await expect(readOwnerChoice({ readLine, write })).resolves.toBe("other");
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(1, PROMPT_OWNER);
    expect(write).toHaveBeenNthCalledWith(2, PROMPT_OWNER);
  });
});
