import { describe, expect, it, vi } from "vitest";

import { MessageItemType, type GetUpdatesResp, type WeixinMessage } from "../api/types.js";
import type { ProcessMessageDeps } from "../messaging/process-message.js";

const getUpdatesMock = vi.fn<(opts: { abortSignal?: AbortSignal }) => Promise<GetUpdatesResp>>();
const getForUserMock = vi.fn<
  (userId: string, contextToken?: string) => Promise<{ typingTicket: string }>
>();
const processOneMessageMock =
  vi.fn<(message: WeixinMessage, deps: ProcessMessageDeps) => Promise<void>>();
const saveGetUpdatesBufMock = vi.fn<(filePath: string, value: string) => void>();
const setContextTokenMock = vi.fn<(accountId: string, userId: string, token: string) => void>();

vi.mock("../api/api.js", () => ({
  getUpdates: (opts: { abortSignal?: AbortSignal }) => getUpdatesMock(opts),
  classifyFetchError: (err: unknown) => ({
    type: "mock",
    description: String(err),
    code: undefined,
  }),
}));

vi.mock("../api/config-cache.js", () => ({
  WeixinConfigManager: class {
    async getForUser(userId: string, contextToken?: string): Promise<{ typingTicket: string }> {
      return getForUserMock(userId, contextToken);
    }
  },
}));

vi.mock("../messaging/process-message.js", () => ({
  processOneMessage: (message: WeixinMessage, deps: ProcessMessageDeps) =>
    processOneMessageMock(message, deps),
}));

vi.mock("../messaging/inbound.js", () => ({
  setContextToken: (accountId: string, userId: string, token: string) =>
    setContextTokenMock(accountId, userId, token),
}));

vi.mock("../storage/sync-buf.js", () => ({
  getSyncBufFilePath: () => "sync-buf",
  loadGetUpdatesBuf: () => undefined,
  saveGetUpdatesBuf: (filePath: string, value: string) =>
    saveGetUpdatesBufMock(filePath, value),
}));

vi.mock("../util/logger.js", () => ({
  logger: {
    withAccount: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

describe("monitorWeixinProvider", () => {
  it("orders ordinary admission while approvals bypass an active ordinary turn", async () => {
    vi.resetModules();
    const { monitorWeixinProvider } = await import("./monitor.js");
    const abortController = new AbortController();
    const firstPreprocessing = createDeferred();
    const firstRun = createDeferred();
    const approvalStarted = createDeferred();
    const secondStarted = createDeferred();
    const started: string[] = [];
    const responses: GetUpdatesResp[] = [
      {
        ret: 0,
        msgs: [makeMessage("first", { message_id: 101, context_token: "token-1" })],
        get_updates_buf: "cursor-1",
      },
      {
        ret: 0,
        msgs: [
          makeMessage("second", { message_id: 102, context_token: "token-2" }),
          makeMessage("third", { message_id: 104, context_token: "token-4" }),
          makeMessage("/approve plugin:test approve", {
            message_id: 103,
            context_token: "token-3",
          }),
        ],
        get_updates_buf: "cursor-2",
      },
    ];

    getUpdatesMock.mockImplementation(async ({ abortSignal }) => {
      const next = responses.shift();
      if (next) return next;
      return await new Promise<GetUpdatesResp>((_, reject) => {
        if (abortSignal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    getForUserMock.mockResolvedValue({ typingTicket: "ticket" });
    processOneMessageMock.mockImplementation(async (message, deps) => {
      const text = getText(message);
      started.push(text);
      if (text === "first") {
        await firstPreprocessing.promise;
        deps.onReplyAdmitted?.();
        await firstRun.promise;
        return;
      }
      if (text.startsWith("/approve plugin:")) {
        approvalStarted.resolve();
        return;
      }
      if (text === "second") {
        secondStarted.resolve();
        abortController.abort();
      }
    });

    const monitor = monitorWeixinProvider({
      baseUrl: "https://example.test",
      cdnBaseUrl: "https://cdn.example.test",
      accountId: "acc-monitor",
      config: {} as never,
      channelRuntime: {} as never,
      abortSignal: abortController.signal,
      runtime: { log: vi.fn(), error: vi.fn() },
    });

    try {
      await approvalStarted.promise;
      expect(started).toEqual(["first", "/approve plugin:test approve"]);
      firstPreprocessing.resolve();
      await secondStarted.promise;
      await monitor;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(started).toEqual(["first", "/approve plugin:test approve", "second"]);
      expect(saveGetUpdatesBufMock).toHaveBeenLastCalledWith("sync-buf", "cursor-2");
      expect(setContextTokenMock.mock.calls).toEqual([
        ["acc-monitor", "user-a", "token-1"],
        ["acc-monitor", "user-a", "token-2"],
        ["acc-monitor", "user-a", "token-4"],
        ["acc-monitor", "user-a", "token-3"],
      ]);
    } finally {
      firstPreprocessing.resolve();
      firstRun.resolve();
      await monitor;
    }
  });
});

function makeMessage(text: string, overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    from_user_id: "user-a",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
    ...overrides,
  };
}

function getText(message: WeixinMessage): string {
  return message.item_list?.[0]?.text_item?.text ?? "";
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
