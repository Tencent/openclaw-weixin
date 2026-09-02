import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getContextTokenFromMsgContext,
  getWeixinMessageId,
  isMediaItem,
  resolveStoredQuoteContext,
  weixinMessageToMsgContext,
} from "./inbound.js";
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

describe("getMediaLabel", () => {
  it("labels every supported media kind", async () => {
    const { getMediaLabel } = await import("./inbound.js");
    expect(getMediaLabel(MessageItemType.IMAGE)).toBe("[图片]");
    expect(getMediaLabel(MessageItemType.VIDEO)).toBe("[视频]");
    expect(getMediaLabel(MessageItemType.FILE)).toBe("[文件]");
    expect(getMediaLabel(MessageItemType.VOICE)).toBe("[语音]");
    expect(getMediaLabel(MessageItemType.TEXT)).toBe("");
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

  it("uses transcribed voice text as the body", () => {
    const ctx = weixinMessageToMsgContext({
      from_user_id: "u",
      item_list: [{ type: MessageItemType.VOICE, voice_item: { text: "voice transcript" } }],
    }, "acc");
    expect(ctx.Body).toBe("voice transcript");
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

  it("keeps downloaded inline-quote media out of the current message attachment", () => {
    const ctx = weixinMessageToMsgContext(baseMsg, "acc", {
      decryptedPicPath: "/tmp/quoted.png",
      referencedMedia: true,
    });
    expect(ctx.MediaPath).toBeUndefined();
    expect(ctx.MediaType).toBeUndefined();
    expect(ctx.MediaPaths).toEqual(["/tmp/quoted.png"]);
    expect(ctx.MediaTypes).toEqual(["image/*"]);
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
    expect(ctx.Body).toBe("reply");
    expect(ctx.ReplyToBody).toBe("original title");
    expect(ctx.ReplyToIsQuote).toBe(true);
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
    expect(ctx.Body).toBe("my reply");
    expect(ctx.ReplyToBody).toBe("Author | original text");
    expect(ctx.ReplyToIsQuote).toBe(true);
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
    expect(ctx.Body).toBe("reply");
    expect(ctx.ReplyToBody).toBe("quoted");
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

  it("uses a stable label when item_list has only a media item", () => {
    const msg: WeixinMessage = {
      from_user_id: "u",
      item_list: [
        { type: MessageItemType.IMAGE },
      ],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    expect(ctx.Body).toBe("[图片]");
  });

  it("keeps the provider uint64 ID separately from the generated MessageSid", () => {
    const ctx = weixinMessageToMsgContext({ ...baseMsg, message_id: "18446744073709551615" }, "acc");
    expect(ctx.MessageSidFull).toBe("18446744073709551615");
    expect(ctx.MessageSid).not.toBe(ctx.MessageSidFull);
  });
});

describe("stored quote resolution", () => {
  const quotedMessage = (partial_text?: NonNullable<NonNullable<MessageItem["ref_msg"]>["partial_text"]>): WeixinMessage => ({
    from_user_id: "user1",
    item_list: [{
      type: MessageItemType.TEXT,
      text_item: { text: "reply" },
      ref_msg: { svr_id: "9007199254740993123", ...(partial_text ? { partial_text } : {}) },
    }],
  });

  it("looks up an ID-only quote in the account and conversation scope", () => {
    const msg = quotedMessage();
    const ctx = weixinMessageToMsgContext(msg, "acc");
    const find = vi.fn(() => ({
      accountId: "acc",
      conversationId: "user1",
      messageId: "9007199254740993123",
      direction: "inbound" as const,
      body: "original text",
      createdAt: Date.now(),
    }));
    resolveStoredQuoteContext(ctx, msg, "acc", { find });
    expect(find).toHaveBeenCalledWith("acc", "user1", "9007199254740993123");
    expect(ctx).toMatchObject({
      Body: "reply",
      ReplyToId: "9007199254740993123",
      ReplyToBody: "original text",
      ReplyToIsQuote: true,
    });
  });

  it("marks a cache miss without modifying the current message body", () => {
    const msg = quotedMessage();
    const ctx = weixinMessageToMsgContext(msg, "acc");
    resolveStoredQuoteContext(ctx, msg, "acc", { find: () => null });
    expect(ctx.Body).toBe("reply");
    expect(ctx.ReplyToBody).toBe("[引用消息内容未缓存]");
  });

  it("resolves the legacy nested message ID", () => {
    const msg: WeixinMessage = {
      from_user_id: "user1",
      item_list: [{
        type: MessageItemType.TEXT,
        text_item: { text: "reply" },
        ref_msg: { message_item: { type: MessageItemType.TEXT, msg_id: "legacy-id" } },
      }],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    resolveStoredQuoteContext(ctx, msg, "acc", {
      find: () => ({
        accountId: "acc", conversationId: "user1", messageId: "legacy-id",
        direction: "inbound", body: "legacy body", createdAt: Date.now(),
      }),
    });
    expect(ctx.ReplyToId).toBe("legacy-id");
    expect(ctx.ReplyToBody).toBe("legacy body");
  });

  it("keeps complete inline quote content instead of replacing it from storage", () => {
    const msg: WeixinMessage = {
      from_user_id: "user1",
      item_list: [{
        type: MessageItemType.TEXT,
        text_item: { text: "reply" },
        ref_msg: {
          svr_id: "id",
          message_item: { type: MessageItemType.TEXT, text_item: { text: "inline body" } },
        },
      }],
    };
    const ctx = weixinMessageToMsgContext(msg, "acc");
    const find = vi.fn();
    resolveStoredQuoteContext(ctx, msg, "acc", { find });
    expect(find).not.toHaveBeenCalled();
    expect(ctx.ReplyToBody).toBe("inline body");
  });

  it("sets ReplyToQuoteText for a partial quote", () => {
    const selected = "second abc";
    const msg = quotedMessage({
      start: "s",
      end: "c",
      startindex: 1,
      endindex: 2,
      quotemd5: "",
    });
    const ctx = weixinMessageToMsgContext(msg, "acc");
    resolveStoredQuoteContext(ctx, msg, "acc", {
      find: () => ({
        accountId: "acc",
        conversationId: "user1",
        messageId: "9007199254740993123",
        direction: "inbound",
        body: "start abc, second abc",
        createdAt: Date.now(),
      }),
    });
    expect(ctx.ReplyToQuoteText).toBe(selected);
  });

  it.each([
    ["image/png", "picture.png", "[引用的图片已过期: picture.png]"],
    ["video/mp4", undefined, "[引用的视频已过期]"],
    ["audio/mpeg", undefined, "[引用的语音已过期]"],
    ["application/pdf", "doc.pdf", "[引用的附件已过期: doc.pdf]"],
  ])("describes expired managed media (%s)", (mediaMime, mediaName, expected) => {
    const msg = quotedMessage();
    const ctx = weixinMessageToMsgContext(msg, "acc");
    resolveStoredQuoteContext(ctx, msg, "acc", {
      find: () => ({
        accountId: "acc", conversationId: "user1", messageId: "9007199254740993123",
        direction: "inbound", body: "[媒体]", mediaMime, ...(mediaName ? { mediaName } : {}),
        createdAt: Date.now(),
      }),
    });
    expect(ctx.ReplyToBody).toBe(expected);
  });

  it("adds an existing quoted media file alongside the current attachment", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-inbound-quote-"));
    const quotedPath = path.join(tempDir, "quoted.png");
    fs.writeFileSync(quotedPath, "image");
    try {
      const msg = quotedMessage();
      const ctx = weixinMessageToMsgContext(msg, "acc", { decryptedFilePath: "/tmp/current.pdf" });
      ctx.ChannelPromptContext = ["existing channel context"];
      resolveStoredQuoteContext(ctx, msg, "acc", {
        find: () => ({
          accountId: "acc", conversationId: "user1", messageId: "9007199254740993123",
          direction: "inbound", body: "[图片]", mediaPath: quotedPath, mediaMime: "image/png",
          mediaName: "quoted-original.png",
          createdAt: Date.now(),
        }),
      });
      expect(ctx.MediaPaths).toEqual(["/tmp/current.pdf", quotedPath]);
      expect(ctx.MediaTypes).toEqual(["application/octet-stream", "image/png"]);
      expect(ctx.media).toEqual([
        { path: "/tmp/current.pdf", contentType: "application/octet-stream" },
        {
          path: quotedPath,
          contentType: "image/png",
          fileName: "quoted-original.png",
          messageId: "9007199254740993123",
        },
      ]);
      expect(ctx.ChannelPromptContext).toEqual([
        "existing channel context",
        [
          "Quoted attachment tool access:",
          JSON.stringify({
            message_id: "9007199254740993123",
            original_filename: "quoted-original.png",
            managed_source_path: quotedPath,
            workspace_directory: "media/inbound/",
          }),
          "The attachment is staged into the agent workspace under media/inbound/. " +
            "If automatic extraction fails and the user asks about its contents, use the available " +
            "file/PDF tools to locate it by original_filename and read it.",
        ].join("\n"),
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("marks a referenced media path that disappeared from disk as expired", () => {
    const msg = quotedMessage();
    const ctx = weixinMessageToMsgContext(msg, "acc");
    resolveStoredQuoteContext(ctx, msg, "acc", {
      find: () => ({
        accountId: "acc", conversationId: "user1", messageId: "9007199254740993123",
        direction: "inbound", body: "[视频]", mediaPath: "/definitely/missing/video.mp4",
        mediaMime: "video/mp4", createdAt: Date.now(),
      }),
    });
    expect(ctx.ReplyToBody).toBe("[引用的视频已过期]");
  });

  it("adds a tool-access hint and falls back to the managed basename", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-inbound-quote-hint-"));
    const quotedPath = path.join(tempDir, "managed-document.pdf");
    fs.writeFileSync(quotedPath, "pdf");
    try {
      const msg = quotedMessage();
      const ctx = weixinMessageToMsgContext(msg, "acc");
      resolveStoredQuoteContext(ctx, msg, "acc", {
        find: () => ({
          accountId: "acc", conversationId: "user1", messageId: "9007199254740993123",
          direction: "inbound", body: "[文件]", mediaPath: quotedPath,
          mediaMime: "application/pdf", createdAt: Date.now(),
        }),
      });
      expect(ctx.ChannelPromptContext?.[0]).toContain('"original_filename":"managed-document.pdf"');
      expect(ctx.ChannelPromptContext?.[0]).toContain('"workspace_directory":"media/inbound/"');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("getWeixinMessageId", () => {
  it("prefers the top-level ID and falls back to an item ID", () => {
    expect(getWeixinMessageId({ message_id: "10", item_list: [{ msg_id: "11" }] })).toBe("10");
    expect(getWeixinMessageId({ item_list: [{ msg_id: "11" }] })).toBe("11");
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
