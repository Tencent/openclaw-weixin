import { describe, it, expect } from "vitest";
import { deriveRawAccountId } from "./accounts.js";

describe("deriveRawAccountId", () => {
  it("converts -im-bot suffix to @im.bot", () => {
    expect(deriveRawAccountId("b0f5860fdecb-im-bot")).toBe("b0f5860fdecb@im.bot");
  });

  it("converts -im-wechat suffix to @im.wechat", () => {
    expect(deriveRawAccountId("abc123-im-wechat")).toBe("abc123@im.wechat");
  });

  it("returns undefined for unknown suffix", () => {
    expect(deriveRawAccountId("some-other-id")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(deriveRawAccountId("")).toBeUndefined();
  });

  it("handles exact suffix without prefix", () => {
    expect(deriveRawAccountId("-im-bot")).toBe("@im.bot");
  });
});
