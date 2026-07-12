import { describe, it, expect, vi, beforeEach } from "vitest";
import { setContextToken, getContextToken } from "./inbound.js";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("context-token-store", () => {
  it("stores and retrieves a token", () => {
    setContextToken("acc1", "user1", "token-abc");
    expect(getContextToken("acc1", "user1")).toBe("token-abc");
  });

  it("returns undefined for unknown key", () => {
    expect(getContextToken("unknown-acc", "unknown-user")).toBeUndefined();
  });

  it("overwrites existing token", () => {
    setContextToken("acc2", "user2", "old");
    setContextToken("acc2", "user2", "new");
    expect(getContextToken("acc2", "user2")).toBe("new");
  });

  it("uses composite key of accountId:userId", () => {
    setContextToken("acc", "userA", "tokenA");
    setContextToken("acc", "userB", "tokenB");
    expect(getContextToken("acc", "userA")).toBe("tokenA");
    expect(getContextToken("acc", "userB")).toBe("tokenB");
  });
});
