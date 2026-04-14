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

  it("handles missing from_user_id", () => {
    const msg: WeixinMessage = { item_list: [] };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.From).toBe("");
    expect(ctx.To).toBe("");
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

// ---------------------------------------------------------------------------
// Voice messages with quoted context (#48)
// ---------------------------------------------------------------------------

describe("voice messages with quoted context (#48)", () => {
  it("includes quoted text title when voice message replies to a text (#48)", () => {
    // Bug: voice messages with ref_msg silently dropped the quoted context.
    // A user quotes/replies to a text message with a voice reply — the agent
    // should see the quoted message as context, just like text replies do.
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: { text: "yes please do that" },
          ref_msg: { title: "Can you schedule a meeting tomorrow?" },
        },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("[引用: Can you schedule a meeting tomorrow?]\nyes please do that");
  });

  it("includes quoted text content when voice message replies to a text", () => {
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: { text: "agreed" },
          ref_msg: {
            message_item: {
              type: MessageItemType.TEXT,
              text_item: { text: "Let's meet at 3pm" },
            },
          },
        },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("[引用: Let's meet at 3pm]\nagreed");
  });

  it("includes both title and message_item when voice replies with both present", () => {
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: { text: "sounds good" },
          ref_msg: {
            title: "Alice",
            message_item: {
              type: MessageItemType.TEXT,
              text_item: { text: "Want to join the standup?" },
            },
          },
        },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("[引用: Alice | Want to join the standup?]\nsounds good");
  });

  it("omits quoted context when voice replies to a media item (image/video/file)", () => {
    // Quoting a media item: we can't include the media content as text context,
    // so we just return the transcribed voice text (same as text replying to media).
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: { text: "nice photo" },
          ref_msg: {
            message_item: { type: MessageItemType.IMAGE },
          },
        },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("nice photo");
  });

  it("returns transcribed text without quote context when ref_msg is empty", () => {
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: { text: "hello there" },
          ref_msg: {},
        },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("hello there");
  });

  it("returns transcribed text with no ref_msg (standalone voice, unchanged)", () => {
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: { text: "schedule meeting at 3pm" },
        },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("schedule meeting at 3pm");
  });

  it("returns empty body when voice has no transcription and no ref_msg", () => {
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.VOICE,
          // no voice_item.text — untranscribed voice
        },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("");
  });

  it("returns empty body when untranscribed voice has ref_msg (no text to show)", () => {
    // If voice has no transcription, we have nothing to prepend quote to.
    // Body stays empty regardless of ref_msg.
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: { text: undefined },
          ref_msg: { title: "Some quoted message" },
        },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("");
  });
});

  it("omits quoted context when voice replies to another voice message", () => {
    // Quoting audio with audio: the quoted voice has no text in the ref context,
    // so we just return the current transcription.
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: { text: "yes exactly what I said" },
          ref_msg: {
            message_item: { type: MessageItemType.VOICE },
          },
        },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("yes exactly what I said");
  });

  it("omits quoted context when voice replies to a video message", () => {
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: { text: "love this video" },
          ref_msg: {
            message_item: { type: MessageItemType.VIDEO },
          },
        },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("love this video");
  });

  it("omits quoted context when voice replies to a file", () => {
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: { text: "got the document" },
          ref_msg: {
            message_item: { type: MessageItemType.FILE },
          },
        },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("got the document");
  });
