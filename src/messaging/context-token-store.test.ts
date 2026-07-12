import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  findAccountIdsByContextToken,
  getContextToken,
  observeContextToken,
  resolveLatestContextToken,
  setContextToken,
} from "./inbound.js";

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

  it("does not let an older observation overwrite a newer token", () => {
    setContextToken("acc-order", "user2", "new", 200);
    setContextToken("acc-order", "user2", "old", 100);
    expect(getContextToken("acc-order", "user2")).toBe("new");
  });

  it("excludes observed tokens from account inference until authorization", () => {
    observeContextToken("acc-observed", "user2", "received", 100);
    expect(findAccountIdsByContextToken(["acc-observed"], "user2")).toEqual([]);

    setContextToken("acc-observed", "user2", "received", 100);
    expect(findAccountIdsByContextToken(["acc-observed"], "user2")).toEqual([
      "acc-observed",
    ]);
  });

  it("uses composite key of accountId:userId", () => {
    setContextToken("acc", "userA", "tokenA");
    setContextToken("acc", "userB", "tokenB");
    expect(getContextToken("acc", "userA")).toBe("tokenA");
    expect(getContextToken("acc", "userB")).toBe("tokenB");
  });

  it("falls back to the originating token when no newer token exists", () => {
    expect(resolveLatestContextToken("acc-fallback", "userC", "origin")).toBe("origin");
  });
});
