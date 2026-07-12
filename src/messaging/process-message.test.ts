import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveSenderCommandAuthorizationWithRuntime = vi.hoisted(() => vi.fn());
const mockResolveDirectDmAuthorizationOutcome = vi.hoisted(() => vi.fn());
const mockHandleSlashCommand = vi.hoisted(() => vi.fn().mockResolvedValue({ handled: false }));
const mockSendMessageWeixin = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: "out-1" }));
const mockSendWeixinErrorNotice = vi.hoisted(() => vi.fn());
const mockSendTyping = vi.hoisted(() => vi.fn());
const mockResolveReplyProgressMessagesEnabled = vi.hoisted(() => vi.fn(() => false));
const mockProgressFinalize = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("openclaw/plugin-sdk/channel-runtime", () => ({
  createTypingCallbacks: (callbacks: unknown) => callbacks,
}));

vi.mock("openclaw/plugin-sdk/command-auth", () => ({
  resolveSenderCommandAuthorizationWithRuntime: mockResolveSenderCommandAuthorizationWithRuntime,
  resolveDirectDmAuthorizationOutcome: mockResolveDirectDmAuthorizationOutcome,
}));

vi.mock("openclaw/plugin-sdk/infra-runtime", () => ({
  resolvePreferredOpenClawTmpDir: () => "C:\\temp",
}));

vi.mock("../api/api.js", () => ({
  sendTyping: mockSendTyping,
}));

vi.mock("../auth/accounts.js", () => ({
  loadWeixinAccount: vi.fn(() => ({ userId: "owner" })),
}));

vi.mock("../auth/pairing.js", () => ({
  readFrameworkAllowFromList: vi.fn(() => []),
}));

vi.mock("../cdn/upload.js", () => ({
  downloadRemoteImageToTemp: vi.fn(),
}));

vi.mock("../config/reply-progress.js", () => ({
  resolveReplyProgressMessagesEnabled: mockResolveReplyProgressMessagesEnabled,
}));

vi.mock("../media/media-download.js", () => ({
  downloadMediaFromItem: vi.fn(),
}));

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./debug-mode.js", () => ({
  isDebugMode: vi.fn(() => false),
}));

vi.mock("./error-notice.js", () => ({
  sendWeixinErrorNotice: mockSendWeixinErrorNotice,
}));

vi.mock("./outbound-hooks.js", () => ({
  applyWeixinMessageSendingHook: vi.fn(async ({ text }: { text: string }) => ({
    cancelled: false,
    text,
  })),
  emitWeixinMessageSent: vi.fn(),
}));

vi.mock("./send-media.js", () => ({
  sendWeixinMediaFile: vi.fn(),
}));

vi.mock("./send.js", () => ({
  StreamingMarkdownFilter: class {
    feed(text: string) {
      return text;
    }
    flush() {
      return "";
    }
  },
  sendMessageWeixin: mockSendMessageWeixin,
}));

vi.mock("./reply-progress-sender.js", () => ({
  WeixinReplyProgressSender: class {
    get replyOptions() {
      return {};
    }
    finalize = mockProgressFinalize;
  },
}));

vi.mock("./slash-commands.js", () => ({
  handleSlashCommand: mockHandleSlashCommand,
}));

import { MessageItemType } from "../api/types.js";
import { clearContextTokensForAccount, setContextToken } from "./inbound.js";
import { processOneMessage } from "./process-message.js";

function makeMessage(body: string, contextToken = "origin-token") {
  return {
    from_user_id: "user-1",
    context_token: contextToken,
    create_time_ms: 1700000000000,
    item_list: [
      {
        type: MessageItemType.TEXT,
        text_item: { text: body },
      },
    ],
  };
}

function createChannelRuntime(overrides?: {
  route?: Partial<ReturnType<PluginRuntimeLike["routing"]["resolveAgentRoute"]>>;
  dispatchReplyFromConfig?: (params: {
    dispatcher: { deliver: (payload: { text?: string; mediaUrl?: string }) => Promise<void> };
    replyOptions: Record<string, unknown>;
  }) => Promise<void>;
}) {
  const route = {
    agentId: "agent-1",
    sessionKey: "session:user-1",
    mainSessionKey: "main:user-1",
    lastRoutePolicy: "session",
    ...overrides?.route,
  };

  const createReplyDispatcherWithTyping = vi.fn(({ deliver }: { deliver: (payload: { text?: string; mediaUrl?: string }) => Promise<void> }) => ({
    dispatcher: { deliver },
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  }));

  const dispatchReplyFromConfig = vi.fn(async (params: {
    dispatcher: { deliver: (payload: { text?: string; mediaUrl?: string }) => Promise<void> };
    replyOptions: Record<string, unknown>;
  }) => {
    if (overrides?.dispatchReplyFromConfig) {
      await overrides.dispatchReplyFromConfig(params);
      return;
    }
    await params.dispatcher.deliver({ text: "reply" });
  });

  return {
    runtime: {
      media: {
        saveMediaBuffer: vi.fn(),
      },
      commands: {},
      routing: {
        resolveAgentRoute: vi.fn(() => route),
      },
      session: {
        resolveStorePath: vi.fn(() => "state/session.json"),
        recordInboundSession: vi.fn(async () => undefined),
      },
      reply: {
        finalizeInboundContext: vi.fn((ctx) => ctx),
        resolveHumanDelayConfig: vi.fn(() => undefined),
        createReplyDispatcherWithTyping,
        withReplyDispatcher: vi.fn(async ({ run }: { run: () => Promise<void> }) => run()),
        dispatchReplyFromConfig,
      },
    },
    dispatchReplyFromConfig,
  };
}

type PluginRuntimeLike = {
  routing: {
    resolveAgentRoute: () => {
      agentId?: string;
      sessionKey?: string;
      mainSessionKey?: string;
      lastRoutePolicy?: string;
    };
  };
};

describe("processOneMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSenderCommandAuthorizationWithRuntime.mockResolvedValue({
      senderAllowedForCommands: false,
      commandAuthorized: false,
    });
    mockResolveDirectDmAuthorizationOutcome.mockReturnValue("allowed");
    mockResolveReplyProgressMessagesEnabled.mockReturnValue(false);
    clearContextTokensForAccount("acc-process");
  });

  it("uses the latest context token when delivering the actual reply", async () => {
    mockResolveSenderCommandAuthorizationWithRuntime.mockResolvedValue({
      senderAllowedForCommands: true,
      commandAuthorized: true,
    });
    const { runtime } = createChannelRuntime({
      dispatchReplyFromConfig: async ({ dispatcher }) => {
        setContextToken("acc-process", "user-1", "latest-token");
        await dispatcher.deliver({ text: "reply" });
      },
    });

    await processOneMessage(makeMessage("hello", "origin-token"), {
      accountId: "acc-process",
      config: {} as never,
      channelRuntime: runtime as never,
      baseUrl: "https://api.example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "tok",
      log: vi.fn(),
      errLog: vi.fn(),
    });

    expect(mockSendMessageWeixin).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: expect.objectContaining({
          contextToken: "latest-token",
        }),
      }),
    );
  });

  it("keeps progress delivery open until a queued follow-up completes", async () => {
    mockResolveSenderCommandAuthorizationWithRuntime.mockResolvedValue({
      senderAllowedForCommands: true,
      commandAuthorized: true,
    });
    mockResolveReplyProgressMessagesEnabled.mockReturnValue(true);
    const ingressLifecycle = {
      onEnqueued: vi.fn(),
      onComplete: vi.fn(),
    };
    let queuedLifecycle:
      | { onEnqueued?: () => void; onComplete?: () => void }
      | undefined;
    const { runtime } = createChannelRuntime({
      dispatchReplyFromConfig: async ({ replyOptions }) => {
        queuedLifecycle = replyOptions.queuedFollowupLifecycle as typeof queuedLifecycle;
        queuedLifecycle?.onEnqueued?.();
      },
    });

    await processOneMessage(makeMessage("follow up"), {
      accountId: "acc-process",
      config: {} as never,
      channelRuntime: runtime as never,
      baseUrl: "https://api.example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "tok",
      queuedFollowupLifecycle: ingressLifecycle,
      log: vi.fn(),
      errLog: vi.fn(),
    });

    expect(ingressLifecycle.onEnqueued).toHaveBeenCalledOnce();
    expect(mockProgressFinalize).not.toHaveBeenCalled();

    queuedLifecycle?.onComplete?.();

    expect(ingressLifecycle.onComplete).toHaveBeenCalledOnce();
    expect(mockProgressFinalize).toHaveBeenCalledOnce();
  });
});
