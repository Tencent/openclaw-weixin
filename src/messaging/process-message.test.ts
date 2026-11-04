import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authorize: vi.fn(),
  notice: vi.fn(),
  download: vi.fn(),
  typing: vi.fn(),
  send: vi.fn(),
  token: vi.fn(),
  finalize: vi.fn(),
  quote: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/temp-path", () => ({ resolvePreferredOpenClawTmpDir: () => "/tmp" }));
vi.mock("../auth/accounts.js", () => ({ loadWeixinAccount: () => ({ userId: "allowed" }) }));
vi.mock("../util/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("./authorization.js", () => ({ resolveWeixinInboundAuthorization: state.authorize }));
vi.mock("./error-notice.js", () => ({ sendWeixinErrorNotice: state.notice }));
vi.mock("../media/media-download.js", () => ({ downloadMediaFromItem: state.download }));
vi.mock("./typing.js", () => ({ loadTypingCallbacksFactory: state.typing }));
vi.mock("./send.js", () => ({ sendMessageWeixin: state.send }));
vi.mock("./debug-mode.js", () => ({ isDebugMode: () => false }));
vi.mock("./slash-commands.js", () => ({ handleSlashCommand: async () => ({ handled: false }) }));
vi.mock("./quote-store.js", () => ({
  getQuoteStore: () => undefined,
  getActiveQuoteMediaSubdir: () => "test",
}));
vi.mock("./inbound.js", () => ({
  weixinMessageToMsgContext: (m: any) => ({
    To: m.from_user_id,
    From: m.from_user_id,
    Body: m.item_list?.[0]?.text_item?.text ?? "[image]",
    contextToken: m.context_token,
  }),
  getContextTokenFromMsgContext: (ctx: any) => ctx.contextToken,
  setContextToken: state.token,
  getWeixinMessageId: () => undefined,
  isMediaItem: (item: any) => item.type !== 1,
  resolveStoredQuoteContext: state.quote,
  attachAdditionalMedia: async () => {},
}));
vi.mock("./outbound-hooks.js", () => ({
  applyWeixinMessageSendingHook: async (p: any) => ({ text: p.text }),
  emitWeixinMessageSent: () => {},
}));
vi.mock("./dispatch-options.js", () => ({ withPublishedModelRuntime: (p: any) => p }));
vi.mock("../config/reply-progress.js", () => ({ resolveReplyProgressMessagesEnabled: () => true }));
vi.mock("./reply-progress-sender.js", () => ({
  WeixinReplyProgressSender: class {
    replyOptions = {};
    finalize = state.finalize;
  },
}));

import { processOneMessage } from "./process-message.js";

function fixture() {
  const controller = new AbortController();
  let onError: (error: Error, info: { kind: string }) => void;
  const runtime = {
    commands: {},
    media: { saveMediaBuffer: vi.fn() },
    routing: {
      resolveAgentRoute: () => ({ agentId: "test", sessionKey: "test", mainSessionKey: "main" }),
    },
    session: {
      resolveStorePath: () => "/tmp/test",
      recordInboundSession: vi.fn().mockResolvedValue(undefined),
    },
    reply: {
      finalizeInboundContext: (ctx: any) => ctx,
      resolveHumanDelayConfig: () => ({}),
      createReplyDispatcherWithTyping: (args: any) => {
        onError = args.onError;
        return {
          dispatcher: { deliver: args.deliver },
          replyOptions: {},
          markDispatchIdle: vi.fn(),
        };
      },
      withReplyDispatcher: ({ run }: any) => run(),
      dispatchReplyFromConfig: vi.fn().mockResolvedValue({}),
    },
  };
  const deps = {
    accountId: "account",
    config: {},
    channelRuntime: runtime as any,
    baseUrl: "https://invalid.test",
    cdnBaseUrl: "https://invalid.test",
    abortSignal: controller.signal,
    log: vi.fn(),
    errLog: vi.fn(),
  };
  const msg = {
    from_user_id: "allowed",
    context_token: "context",
    item_list: [{ type: 1, text_item: { text: "work" } }],
  };
  return { controller, runtime, deps, msg, error: () => onError };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.authorize.mockResolvedValue({ senderAllowed: true, commandAuthorized: true });
  state.notice.mockResolvedValue(undefined);
  state.download.mockResolvedValue({});
  state.typing.mockResolvedValue(() => ({}));
  state.send.mockResolvedValue({ messageId: "sent" });
  state.finalize.mockResolvedValue(undefined);
});

describe("authorized inbound failure reporting", () => {
  it("reports a session setup rejection once using sanitized text", async () => {
    const f = fixture();
    f.runtime.session.recordInboundSession.mockRejectedValue(new Error("secret=test"));
    await expect(processOneMessage(f.msg, f.deps)).rejects.toThrow("secret=test");
    expect(state.notice).toHaveBeenCalledTimes(1);
    expect(state.notice.mock.calls[0][0]).toMatchObject({
      to: "allowed",
      contextToken: "context",
      config: f.deps.config,
      abortSignal: f.controller.signal,
    });
    expect(state.notice.mock.calls[0][0].message).not.toContain("secret");
    expect(f.runtime.reply.dispatchReplyFromConfig).not.toHaveBeenCalled();
  });
  it("reports typing adapter load failure", async () => {
    const f = fixture();
    state.typing.mockRejectedValue(new Error("adapter unavailable"));
    await expect(processOneMessage(f.msg, f.deps)).rejects.toThrow("adapter unavailable");
    expect(state.notice).toHaveBeenCalledTimes(1);
  });
  it("reports an internal AbortError when channel is not cancelled", async () => {
    const f = fixture();
    f.runtime.reply.dispatchReplyFromConfig.mockRejectedValue(
      Object.assign(new Error("provider aborted"), { name: "AbortError" }),
    );
    await expect(processOneMessage(f.msg, f.deps)).rejects.toThrow("provider aborted");
    expect(state.notice).toHaveBeenCalledTimes(1);
  });
  it("does not report channel cancellation", async () => {
    const f = fixture();
    f.runtime.reply.dispatchReplyFromConfig.mockImplementation(async () => {
      f.controller.abort();
      throw f.controller.signal.reason;
    });
    await expect(processOneMessage(f.msg, f.deps)).rejects.toThrow();
    expect(state.notice).not.toHaveBeenCalled();
  });
  it("authorizes before downloading and reports failed media without starting an agent", async () => {
    const f = fixture();
    f.msg.item_list = [
      { type: 2, image_item: { media: { full_url: "https://invalid.test/pic" } } } as any,
    ];
    state.download.mockImplementation(async () => {
      expect(state.authorize).toHaveBeenCalledTimes(1);
      throw new Error("download timeout");
    });
    await expect(processOneMessage(f.msg, f.deps)).rejects.toThrow("download timeout");
    expect(state.download.mock.calls[0][1]).toMatchObject({
      abortSignal: f.controller.signal,
      throwOnError: true,
    });
    expect(state.notice).toHaveBeenCalledTimes(1);
    expect(f.runtime.reply.dispatchReplyFromConfig).not.toHaveBeenCalled();
  });
  it("does not download, mutate context or notify unauthorized senders", async () => {
    const f = fixture();
    f.msg.item_list = [
      { type: 2, image_item: { media: { full_url: "https://invalid.test/pic" } } } as any,
    ];
    state.authorize.mockResolvedValue({ senderAllowed: false });
    await processOneMessage(f.msg, f.deps);
    expect(state.download).not.toHaveBeenCalled();
    expect(state.token).not.toHaveBeenCalled();
    expect(state.notice).not.toHaveBeenCalled();
  });
  it("does not send a false failure after a successful final response and cleanup failure", async () => {
    const f = fixture();
    f.runtime.reply.dispatchReplyFromConfig.mockImplementation(async ({ dispatcher }) =>
      dispatcher.deliver({ text: "done" }, { kind: "final" }),
    );
    state.finalize.mockRejectedValue(new Error("cleanup failed"));
    await expect(processOneMessage(f.msg, f.deps)).rejects.toThrow("cleanup failed");
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.notice).not.toHaveBeenCalled();
  });
  it("reports cleanup failure if only progress was delivered", async () => {
    const f = fixture();
    f.runtime.reply.dispatchReplyFromConfig.mockImplementation(async ({ dispatcher }) =>
      dispatcher.deliver({ text: "working" }, { kind: "block" }),
    );
    state.finalize.mockRejectedValue(new Error("cleanup failed"));
    await expect(processOneMessage(f.msg, f.deps)).rejects.toThrow("cleanup failed");
    expect(state.notice).toHaveBeenCalledTimes(1);
  });
  it("does not send duplicate failure from dispatcher after visible final delivery", async () => {
    const f = fixture();
    f.runtime.reply.dispatchReplyFromConfig.mockImplementation(async ({ dispatcher }) => {
      await dispatcher.deliver({ text: "done" }, { kind: "final" });
      f.error()(new Error("post-send hook failed"), { kind: "final" });
    });
    await processOneMessage(f.msg, f.deps);
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.notice).not.toHaveBeenCalled();
  });
  it("deduplicates multiple dispatcher errors and outer catch", async () => {
    const f = fixture();
    f.runtime.reply.dispatchReplyFromConfig.mockImplementation(async () => {
      f.error()(new Error("first failure"), { kind: "final" });
      f.error()(new Error("second failure"), { kind: "final" });
      throw new Error("outer failure");
    });
    await expect(processOneMessage(f.msg, f.deps)).rejects.toThrow("outer failure");
    expect(state.notice).toHaveBeenCalledTimes(1);
  });
  it("resolves metadata-only quoted attachments without attempting a strict download", async () => {
    const f = fixture();
    f.msg.item_list = [
      {
        type: 1,
        text_item: { text: "explain quote" },
        ref_msg: {
          svr_id: "old-file",
          message_item: { type: 4, file_item: { file_name: "report.txt" } },
        },
      } as any,
    ];
    await processOneMessage(f.msg, f.deps);
    expect(state.download).not.toHaveBeenCalled();
    expect(state.quote).toHaveBeenCalledTimes(1);
    expect(f.runtime.reply.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(state.notice).not.toHaveBeenCalled();
  });
});

it.each([false, true])(
  "retains error notice custody through finalization (cleanup fails: %s)",
  async (cleanupFails) => {
    const f = fixture();
    let finishNotice!: (value: { status: string }) => void;
    state.notice.mockReturnValue(
      new Promise((resolve) => {
        finishNotice = resolve;
      }),
    );
    f.runtime.reply.dispatchReplyFromConfig.mockImplementation(async () => {
      f.error()(new Error("reply failed"), { kind: "final" });
    });
    if (cleanupFails) state.finalize.mockRejectedValue(new Error("cleanup failed"));
    let settled = false;
    const result = processOneMessage(f.msg, f.deps).then(
      () => {
        settled = true;
        return "resolved";
      },
      (error) => {
        settled = true;
        return error.message;
      },
    );
    await vi.waitFor(() => expect(state.notice).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finishNotice({ status: "pending" });
    expect(await result).toBe(cleanupFails ? "cleanup failed" : "resolved");
  },
);
