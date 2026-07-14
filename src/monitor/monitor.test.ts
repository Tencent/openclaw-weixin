import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MessageItemType, type GetUpdatesResp, type WeixinMessage } from "../api/types.js";
import type { ProcessMessageDeps } from "../messaging/process-message.js";
import { getSyncBufFilePath, loadGetUpdatesBuf } from "../storage/sync-buf.js";
import { resolveInboundInboxDir } from "./inbound-inbox.js";

const getUpdatesMock = vi.fn<(opts: { abortSignal?: AbortSignal }) => Promise<GetUpdatesResp>>();
const getForUserMock = vi.fn<
  (userId: string, contextToken?: string) => Promise<{ typingTicket: string }>
>();
const processOneMessageMock =
  vi.fn<(message: WeixinMessage, deps: ProcessMessageDeps) => Promise<void>>();

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
  processOneMessage: (message: WeixinMessage, deps: unknown) => processOneMessageMock(message, deps),
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

const TEST_STATE_ROOT = path.join(process.cwd(), ".vitest-state");

let stateDir = "";

beforeEach(() => {
  stateDir = path.join(
    TEST_STATE_ROOT,
    `monitor-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(stateDir, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = stateDir;
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("monitorWeixinProvider", () => {
  it("enqueues before cursor commit and keeps polling while the first run is active", async () => {
    vi.resetModules();
    const { monitorWeixinProvider } = await import("./monitor.js");
    const abortController = new AbortController();
    const firstRun = createDeferred();
    const started: string[] = [];
    const processDeps: ProcessMessageDeps[] = [];
    const responses: GetUpdatesResp[] = [
      {
        ret: 0,
        msgs: [makeMessage("first", { message_id: 101 })],
        get_updates_buf: "cursor-1",
      },
      {
        ret: 0,
        msgs: [makeMessage("second", { message_id: 102 })],
        get_updates_buf: "cursor-2",
      },
    ];

    getUpdatesMock.mockImplementation(async ({ abortSignal }) => {
      const next = responses.shift();
      if (next) return next;
      return await waitForAbort(abortSignal);
    });
    getForUserMock.mockResolvedValue({ typingTicket: "ticket" });
    processOneMessageMock.mockImplementation(async (message, deps) => {
      const text = getText(message);
      started.push(text);
      processDeps.push(deps);
      if (text === "first") {
        deps.durableInboundLifecycle?.onTurnAdopted();
        await firstRun.promise;
        return;
      }
      abortController.abort();
      await firstRun.promise;
    });

    const monitor = monitorWeixinProvider({
      baseUrl: "https://example.test",
      cdnBaseUrl: "https://cdn.example.test",
      accountId: "acc-monitor",
      config: {} as never,
      channelRuntime: {} as never,
      durableQueueAdmissionSupported: true,
      abortSignal: abortController.signal,
      runtime: { log: vi.fn(), error: vi.fn() },
    });

    try {
      await waitForCondition(() => started.includes("first") && started.includes("second"));
      expect(processDeps).toHaveLength(2);
      expect(processDeps.every((deps) => deps.durableInboundLifecycle !== undefined)).toBe(true);
      expect(loadGetUpdatesBuf(getSyncBufFilePath("acc-monitor"))).toBe("cursor-2");
      const inboxFiles = fs.readdirSync(resolveInboundInboxDir("acc-monitor"));
      expect(inboxFiles.some((name) => name.endsWith(".pending.json"))).toBe(true);

      firstRun.resolve();
      await monitor;
      await waitForCondition(
        () =>
          fs
            .readdirSync(resolveInboundInboxDir("acc-monitor"))
            .filter((name) => name.endsWith(".done.json")).length === 2,
      );
    } finally {
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
  let settled = false;
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = () => {
      if (settled) return;
      settled = true;
      innerResolve();
    };
  });
  return { promise, resolve };
}

async function waitForAbort(signal?: AbortSignal): Promise<GetUpdatesResp> {
  return await new Promise<GetUpdatesResp>((_, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}
