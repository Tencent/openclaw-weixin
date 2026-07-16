import { beforeEach, describe, expect, it, vi } from "vitest";

import { MessageItemType } from "../api/types.js";

const { mockSendMessageWeixin, mockSendTyping, mockSetContextToken } = vi.hoisted(() => ({
  mockSendMessageWeixin: vi.fn(),
  mockSendTyping: vi.fn(),
  mockSetContextToken: vi.fn(),
}));

vi.mock("../api/api.js", () => ({ sendTyping: mockSendTyping }));

vi.mock("./inbound.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound.js")>()),
  setContextToken: mockSetContextToken,
}));

vi.mock("./send.js", () => ({
  sendMessageWeixin: mockSendMessageWeixin,
}));

vi.mock("./outbound-hooks.js", () => ({
  applyWeixinMessageSendingHook: vi.fn(async (params: { text: string }) => ({
    cancelled: false,
    text: params.text,
  })),
  emitWeixinMessageSent: vi.fn(),
}));

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { processOneMessage } from "./process-message.js";

function createRuntime() {
  let deliver: ((payload: { text: string }) => Promise<void>) | undefined;
  let onReplyStart: (() => Promise<void> | void) | undefined;
  const resolveAgentRoute = vi.fn(() => ({
    agentId: "main",
    accountId: "bot",
    sessionKey: "agent:main:openclaw-weixin:group:family@chatroom",
    mainSessionKey: "agent:main:main",
  }));
  const recordInboundSession = vi.fn(async () => {});
  const runtime = {
    commands: {
      shouldComputeCommandAuthorized: vi.fn(() => false),
      resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
    },
    routing: { resolveAgentRoute },
    media: { saveMediaBuffer: vi.fn() },
    session: {
      resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
      recordInboundSession,
    },
    reply: {
      finalizeInboundContext: vi.fn((ctx: Record<string, unknown>) => ctx),
      resolveHumanDelayConfig: vi.fn(() => undefined),
      createReplyDispatcherWithTyping: vi.fn((params: {
        deliver: (payload: { text: string }) => Promise<void>;
        typingCallbacks?: { onReplyStart?: () => Promise<void> | void };
      }) => {
        deliver = params.deliver;
        onReplyStart = params.typingCallbacks?.onReplyStart;
        return { dispatcher: {}, replyOptions: {}, markDispatchIdle: vi.fn() };
      }),
      withReplyDispatcher: vi.fn(async (params: { run: () => Promise<void> }) => params.run()),
      dispatchReplyFromConfig: vi.fn(async () => {
        await onReplyStart?.();
        await deliver?.({ text: "group reply" });
      }),
    },
  };
  return { runtime, resolveAgentRoute, recordInboundSession };
}

describe("processOneMessage group routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessageWeixin.mockResolvedValue({ messageId: "sent-1" });
  });

  it("routes and replies by group while retaining the member sender", async () => {
    const { runtime, resolveAgentRoute, recordInboundSession } = createRuntime();
    await processOneMessage(
      {
        from_user_id: "wxid-alice",
        group_id: "family@chatroom",
        context_token: "group-context",
        item_list: [{ type: MessageItemType.TEXT, text_item: { text: "/echo hello group" } }],
      },
      {
        accountId: "bot",
        config: { channels: { "openclaw-weixin": { replyProgressMessages: false } } },
        channelRuntime: runtime,
        baseUrl: "http://webox.test",
        cdnBaseUrl: "http://cdn.test",
        token: "token",
        typingTicket: "direct-only-ticket",
        log: vi.fn(),
        errLog: vi.fn(),
      } as never,
    );

    expect(resolveAgentRoute).toHaveBeenCalledWith(expect.objectContaining({
      peer: { kind: "group", id: "family@chatroom" },
    }));
    expect(recordInboundSession).toHaveBeenCalledWith(expect.objectContaining({
      ctx: expect.objectContaining({
        ChatType: "group",
        From: "family@chatroom",
        To: "family@chatroom",
        GroupSubject: "family@chatroom",
        SenderId: "wxid-alice",
      }),
    }));
    expect(recordInboundSession.mock.calls[0]?.[0]).not.toHaveProperty("updateLastRoute");
    expect(mockSetContextToken).toHaveBeenCalledWith(
      "bot",
      "family@chatroom",
      "group-context",
    );
    expect(mockSendTyping).not.toHaveBeenCalled();
    expect(mockSendMessageWeixin).toHaveBeenCalledWith({
      to: "family@chatroom",
      text: "group reply",
      opts: expect.objectContaining({ contextToken: "group-context" }),
    });
  });
});
