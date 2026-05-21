import { describe, it, expect, vi, beforeEach } from "vitest";
import { isMediaItem, weixinMessageToMsgContext, getContextTokenFromMsgContext } from "./inbound.js";
import type { WeixinMsgContext } from "./inbound.js";
import { MessageItemType } from "../api/types.js";
import type { WeixinMessage, MessageItem } from "../api/types.js";

// Mock logger to avoid file I/O
vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock crypto.randomBytes for deterministic MessageSid
vi.mock("node:crypto", () => ({
  default: {
    randomBytes: vi.fn(() => Buffer.from("deadbeef", "hex")),
  },
}));

describe("isMediaItem", () => {
  it("returns true for IMAGE type", () => {
    expect(isMediaItem({ type: MessageItemType.IMAGE })).toBe(true);
  });

  it("returns true for VIDEO type", () => {
    expect(isMediaItem({ type: MessageItemType.VIDEO })).toBe(true);
  });

  it("returns true for FILE type", () => {
    expect(isMediaItem({ type: MessageItemType.FILE })).toBe(true);
  });

  it("returns true for VOICE type", () => {
    expect(isMediaItem({ type: MessageItemType.VOICE })).toBe(true);
  });

  it("returns false for TEXT type", () => {
    expect(isMediaItem({ type: MessageItemType.TEXT })).toBe(false);
  });

  it("returns false for NONE type", () => {
    expect(isMediaItem({ type: MessageItemType.NONE })).toBe(false);
  });
});

describe("weixinMessageToMsgContext", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
  });

  const baseMsg: WeixinMessage = {
    from_user_id: "user123",
    item_list: [
      { type: MessageItemType.TEXT, text_item: { text: "hello" } },
    ],
    create_time_ms: 1700000000000,
    context_token: "ctx-token-abc",
  };

  it("builds correct MsgContext from a text message", () => {
    const ctx = weixinMessageToMsgContext(baseMsg, "account1");
    expect(ctx.Body).toBe("hello");
    expect(ctx.From).toBe("user123");
    expect(ctx.To).toBe("user123");
    expect(ctx.AccountId).toBe("account1");
    expect(ctx.OriginatingChannel).toBe("openclaw-weixin");
    expect(ctx.Provider).toBe("openclaw-weixin");
    expect(ctx.ChatType).toBe("direct");
    expect(ctx.context_token).toBe("ctx-token-abc");
    expect(ctx.MessageSid).toMatch(/^openclaw-weixin:\d+-[0-9a-f]+$/);
    expect(ctx.Timestamp).toBe(1700000000000);
  });

  it("populates SenderId from from_user_id so OpenClaw core can route per-sender peer state", () => {
    // Without SenderId, downstream memory plugins (honcho, etc.) collapse all senders
    // into a single peer because `buildInboundUserContextPrefix` reads `ctx.SenderId`
    // when emitting the inbound `Conversation info` metadata block. Multi-user setups
    // depend on this field being populated.
    const ctx = weixinMessageToMsgContext(baseMsg, "account1");
    expect(ctx.SenderId).toBe("user123");
  });

  it("handles missing from_user_id", () => {
    const msg: WeixinMessage = { item_list: [] };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.From).toBe("");
    expect(ctx.To).toBe("");
    expect(ctx.SenderId).toBe("");
  });

  it("handles empty item_list", () => {
    const msg: WeixinMessage = { from_user_id: "u", item_list: [] };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("");
  });

  it("handles missing context_token", () => {
    const msg: WeixinMessage = { from_user_id: "u", item_list: [] };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.context_token).toBeUndefined();
  });

  it("sets MediaPath and MediaType for decryptedPicPath", () => {
    const ctx = weixinMessageToMsgContext(baseMsg, "acc", {
      decryptedPicPath: "/tmp/pic.png",
    });
    expect(ctx.MediaPath).toBe("/tmp/pic.png");
    expect(ctx.MediaType).toBe("image/*");
  });

  it("sets MediaPath for decryptedVideoPath", () => {
    const ctx = weixinMessageToMsgContext(baseMsg, "acc", {
      decryptedVideoPath: "/tmp/video.mp4",
    });
    expect(ctx.MediaPath).toBe("/tmp/video.mp4");
    expect(ctx.MediaType).toBe("video/mp4");
  });

  it("sets MediaPath for decryptedFilePath with custom type", () => {
    const ctx = weixinMessageToMsgContext(baseMsg, "acc", {
      decryptedFilePath: "/tmp/doc.pdf",
      fileMediaType: "application/pdf",
    });
    expect(ctx.MediaPath).toBe("/tmp/doc.pdf");
    expect(ctx.MediaType).toBe("application/pdf");
  });

  it("defaults file media type to application/octet-stream", () => {
    const ctx = weixinMessageToMsgContext(baseMsg, "acc", {
      decryptedFilePath: "/tmp/file.bin",
    });
    expect(ctx.MediaType).toBe("application/octet-stream");
  });

  it("sets MediaPath for decryptedVoicePath", () => {
    const ctx = weixinMessageToMsgContext(baseMsg, "acc", {
      decryptedVoicePath: "/tmp/voice.wav",
      voiceMediaType: "audio/wav",
    });
    expect(ctx.MediaPath).toBe("/tmp/voice.wav");
    expect(ctx.MediaType).toBe("audio/wav");
  });

  it("defaults voice media type to audio/wav", () => {
    const ctx = weixinMessageToMsgContext(baseMsg, "acc", {
      decryptedVoicePath: "/tmp/voice.silk",
    });
    expect(ctx.MediaType).toBe("audio/wav");
  });

  it("prioritizes pic > video > file > voice", () => {
    const ctx = weixinMessageToMsgContext(baseMsg, "acc", {
      decryptedPicPath: "/tmp/pic.png",
      decryptedVideoPath: "/tmp/video.mp4",
      decryptedFilePath: "/tmp/file.bin",
      decryptedVoicePath: "/tmp/voice.wav",
    });
    expect(ctx.MediaPath).toBe("/tmp/pic.png");
    expect(ctx.MediaType).toBe("image/*");
  });

  it("builds quoted context from ref_msg title", () => {
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: "reply" },
          ref_msg: { title: "original title" },
        },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("[引用: original title]\nreply");
  });

  it("skips quoted context when ref_msg is a media item", () => {
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: "reply" },
          ref_msg: {
            message_item: { type: MessageItemType.IMAGE },
          },
        },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("reply");
  });

  it("builds quoted context from ref_msg with title and message_item text", () => {
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: "my reply" },
          ref_msg: {
            title: "Author",
            message_item: {
              type: MessageItemType.TEXT,
              text_item: { text: "original text" },
            },
          },
        },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("[引用: Author | original text]\nmy reply");
  });

  it("builds quoted context with only message_item (no title)", () => {
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: "reply" },
          ref_msg: {
            message_item: {
              type: MessageItemType.TEXT,
              text_item: { text: "quoted" },
            },
          },
        },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("[引用: quoted]\nreply");
  });

  it("returns text when ref_msg has no extractable content", () => {
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: "reply" },
          ref_msg: {},
        },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("reply");
  });

  it("returns empty body when item_list has only non-text items", () => {
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        { type: MessageItemType.IMAGE },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("");
  });
});

describe("getContextTokenFromMsgContext", () => {
  it("returns context_token when present", () => {
    const ctx = { context_token: "tok123" } as WeixinMsgContext;
    expect(getContextTokenFromMsgContext(ctx)).toBe("tok123");
  });

  it("returns undefined when context_token is absent", () => {
    const ctx = {} as WeixinMsgContext;
    expect(getContextTokenFromMsgContext(ctx)).toBeUndefined();
  });
});
