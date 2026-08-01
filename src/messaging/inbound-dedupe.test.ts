import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WeixinMessage } from "../api/types.js";
import { MessageItemType } from "../api/types.js";
import {
  WEIXIN_INBOUND_DEDUPE_TTL_MS,
  buildWeixinInboundDedupeKey,
  claimWeixinInboundMessage,
  commitWeixinInboundMessage,
  logWeixinInboundDuplicate,
  releaseWeixinInboundMessage,
  resetWeixinInboundDedupeForTests,
} from "./inbound-dedupe.js";
import { logger } from "../util/logger.js";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

beforeEach(() => {
  resetWeixinInboundDedupeForTests();
});

afterEach(() => {
  resetWeixinInboundDedupeForTests();
});

function textMsg(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    from_user_id: "user-1",
    message_id: 42,
    create_time_ms: 1_700_000_000_000,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "你好" } }],
    ...overrides,
  };
}

describe("buildWeixinInboundDedupeKey", () => {
  it("prefers message_id", () => {
    expect(buildWeixinInboundDedupeKey("jinjin", textMsg())).toBe(
      "weixin:v1:jinjin:user-1:mid:42",
    );
  });

  it("falls back to client_id then seq then body fingerprint", () => {
    expect(
      buildWeixinInboundDedupeKey(
        "jinjin",
        textMsg({ message_id: undefined, client_id: "c-9" }),
      ),
    ).toBe("weixin:v1:jinjin:user-1:cid:c-9");

    expect(
      buildWeixinInboundDedupeKey(
        "jinjin",
        textMsg({ message_id: undefined, client_id: undefined, seq: 7 }),
      ),
    ).toBe("weixin:v1:jinjin:user-1:seq:7");

    const bodyKey = buildWeixinInboundDedupeKey(
      "jinjin",
      textMsg({ message_id: undefined, client_id: undefined, seq: undefined }),
    );
    expect(bodyKey).toMatch(/^weixin:v1:jinjin:user-1:body:[0-9a-f]{16}$/);
  });

  it("returns null key only when empty identity", () => {
    expect(buildWeixinInboundDedupeKey("", {})).toBeNull();
    expect(buildWeixinInboundDedupeKey("acc", {})).toBeNull();
  });

  it("body fallback uses voice transcription text", () => {
    const key = buildWeixinInboundDedupeKey("acc", {
      from_user_id: "u",
      create_time_ms: 1,
      item_list: [{ type: MessageItemType.VOICE, voice_item: { text: "语音转写" } }],
    });
    expect(key).toMatch(/^weixin:v1:acc:u:body:[0-9a-f]{16}$/);
  });
});

describe("claimWeixinInboundMessage", () => {
  it("claims once, rejects in-flight/duplicate, allows after TTL", async () => {
    const key = buildWeixinInboundDedupeKey("jinjin", textMsg())!;
    const t0 = 1_000_000;
    const ns = { namespace: "jinjin", now: t0 };

    expect(await claimWeixinInboundMessage(key, ns)).toBe(true);
    // Second delivery while first is still in-flight
    expect(await claimWeixinInboundMessage(key, { ...ns, now: t0 + 900 })).toBe(false);

    await commitWeixinInboundMessage(key, ns);
    // After commit, still within TTL
    expect(await claimWeixinInboundMessage(key, { ...ns, now: t0 + 60_000 })).toBe(false);

    // Past 24h replay tombstone window
    expect(
      await claimWeixinInboundMessage(key, {
        namespace: "jinjin",
        now: t0 + WEIXIN_INBOUND_DEDUPE_TTL_MS + 1,
      }),
    ).toBe(true);
  });

  it("release allows retry after failure", async () => {
    const key = buildWeixinInboundDedupeKey("jinjin", textMsg())!;
    const ns = { namespace: "jinjin", now: 1_000_000 };

    expect(await claimWeixinInboundMessage(key, ns)).toBe(true);
    releaseWeixinInboundMessage(key, { ...ns, error: new Error("boom") });
    expect(await claimWeixinInboundMessage(key, ns)).toBe(true);
  });

  it("covers long-turn redelivery window (30–50 min)", async () => {
    const key = buildWeixinInboundDedupeKey("jinjin", textMsg())!;
    const t0 = 5_000_000;
    expect(await claimWeixinInboundMessage(key, { namespace: "jinjin", now: t0 })).toBe(true);
    await commitWeixinInboundMessage(key, { namespace: "jinjin", now: t0 });
    expect(
      await claimWeixinInboundMessage(key, {
        namespace: "jinjin",
        now: t0 + 50 * 60 * 1000,
      }),
    ).toBe(false);
  });
});

describe("logWeixinInboundDuplicate", () => {
  it("logs account and key", () => {
    logWeixinInboundDuplicate({
      accountId: "jinjin",
      key: "weixin:v1:jinjin:u:mid:1",
      messageId: 1,
      seq: 2,
      from: "u",
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("dropping duplicate inbound message"),
    );
  });
});
