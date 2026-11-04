import { describe, expect, it } from "vitest";

import { resolveWeixinInboundAuthorization } from "./authorization.js";

const commands = {
  shouldComputeCommandAuthorized: (body: string) => body.startsWith("/"),
};

describe("resolveWeixinInboundAuthorization", () => {
  it("preserves legacy message access when no owner is stored", async () => {
    const result = await resolveWeixinInboundAuthorization({
      senderId: "sender",
      ownerId: undefined,
      rawBody: "hello",
      config: {},
      commands,
    });

    expect(result).toEqual({ senderAllowed: true, commandAuthorized: undefined });
  });

  it("does not authorize commands when no owner is stored", async () => {
    const result = await resolveWeixinInboundAuthorization({
      senderId: "sender",
      ownerId: undefined,
      rawBody: "/status",
      config: {},
      commands,
    });

    expect(result).toEqual({ senderAllowed: true, commandAuthorized: false });
  });

  it("admits the stored owner and authorizes commands", async () => {
    const result = await resolveWeixinInboundAuthorization({
      senderId: "sender",
      ownerId: "sender",
      rawBody: "/status",
      config: {},
      commands,
    });

    expect(result).toEqual({ senderAllowed: true, commandAuthorized: true });
  });

  it("rejects a sender who is not the QR-scanned account owner", async () => {
    const result = await resolveWeixinInboundAuthorization({
      senderId: "sender",
      ownerId: "owner",
      rawBody: "/status",
      config: {},
      commands,
    });

    expect(result).toEqual({ senderAllowed: false, commandAuthorized: false });
  });
});
