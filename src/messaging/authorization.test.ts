import { describe, expect, it } from "vitest";

import { resolveWeixinInboundAuthorization } from "./authorization.js";

const commands = {
  shouldComputeCommandAuthorized: (body: string) => body.startsWith("/"),
};

describe("resolveWeixinInboundAuthorization", () => {
  it("preserves legacy message access when no owner is stored", async () => {
    const result = await resolveWeixinInboundAuthorization({
      accountId: "account",
      senderId: "sender",
      rawBody: "hello",
      config: {},
      commands,
      allowFrom: [],
    });

    expect(result).toEqual({ senderAllowed: true, commandAuthorized: undefined });
  });

  it("does not authorize commands when no owner is stored", async () => {
    const result = await resolveWeixinInboundAuthorization({
      accountId: "account",
      senderId: "sender",
      rawBody: "/status",
      config: {},
      commands,
      allowFrom: [],
    });

    expect(result).toEqual({ senderAllowed: true, commandAuthorized: false });
  });

  it("admits the stored owner and authorizes commands", async () => {
    const result = await resolveWeixinInboundAuthorization({
      accountId: "account",
      senderId: "sender",
      rawBody: "/status",
      config: {},
      commands,
      allowFrom: ["sender"],
    });

    expect(result).toEqual({ senderAllowed: true, commandAuthorized: true });
  });

  it("rejects a sender outside the stored allowlist", async () => {
    const result = await resolveWeixinInboundAuthorization({
      accountId: "account",
      senderId: "sender",
      rawBody: "/status",
      config: {},
      commands,
      allowFrom: ["other"],
    });

    expect(result).toEqual({ senderAllowed: false, commandAuthorized: false });
  });
});
