import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUpdates = vi.hoisted(() => vi.fn());
const mockProcessOneMessage = vi.hoisted(() => vi.fn());
const mockGetForUser = vi.hoisted(() => vi.fn(async () => ({ typingTicket: "ticket-1" })));
const mockLogger = vi.hoisted(() => {
  const base = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withAccount: vi.fn(),
    getLogFilePath: vi.fn(() => "openclaw.log"),
    close: vi.fn(),
  };
  base.withAccount.mockImplementation(() => base);
  return base;
});

vi.mock("../api/api.js", () => ({
  getUpdates: mockGetUpdates,
  classifyFetchError: vi.fn((err: unknown) => ({
    type: "fetch",
    description: String(err),
    code: undefined,
  })),
}));

vi.mock("../api/config-cache.js", () => ({
  WeixinConfigManager: class {
    getForUser = mockGetForUser;
  },
}));

vi.mock("../messaging/process-message.js", () => ({
  extractTextBody: (itemList?: Array<{ type?: number; text_item?: { text?: string } }>) =>
    itemList?.find((item) => item.type === 1)?.text_item?.text ?? "",
  processOneMessage: mockProcessOneMessage,
}));

vi.mock("../util/logger.js", () => ({
  logger: mockLogger,
}));

import { MessageItemType } from "../api/types.js";
import {
  clearContextTokensForAccount,
} from "../messaging/inbound.js";
import { getSyncBufFilePath } from "../storage/sync-buf.js";
import {
  DURABLE_RETRY_DELAY_FOR_TESTS_MS,
  PLUGIN_APPROVAL_CONTROL_LANE,
  getDurableIngressEventId,
  monitorWeixinProvider,
  resolveDurableIngressLaneKey,
} from "./monitor.js";
import {
  createDurableIngressManager,
  DURABLE_MAX_PROCESS_ATTEMPTS_FOR_TESTS,
} from "./durable-ingress.js";

type QueueRecord = {
  id: string;
  payload: { version: 1; message: ReturnType<typeof makeMessage> };
  metadata?: { laneKey?: string };
  receivedAt: number;
  updatedAt: number;
  laneKey?: string;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
};

type QueueClaim = QueueRecord & {
  claim: {
    token: string;
    ownerId: string;
    claimedAt: number;
  };
};

class FakeIngressQueue {
  pending = new Map<string, QueueRecord>();
  claims = new Map<string, QueueClaim>();
  completed = new Map<string, { metadata?: { outcome: string } }>();
  failed = new Map<string, { reason: string; message?: string }>();
  enqueueObservations: boolean[] = [];
  releaseCalls: Array<{ id: string; lastError?: string }> = [];
  completeCalls: Array<{ id: string; outcome?: string }> = [];
  refreshCalls: string[] = [];
  listPendingCalls = 0;
  onEnqueue?: (id: string) => void;
  beforeClaim?: (id: string) => Promise<void>;
  listPendingError?: Error;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async enqueue(id: string, payload: QueueRecord["payload"], options?: {
    metadata?: { laneKey?: string };
    receivedAt?: number;
    laneKey?: string;
  }) {
    this.onEnqueue?.(id);
    if (this.pending.has(id)) {
      return { kind: "pending" as const, duplicate: true, record: this.pending.get(id)! };
    }
    if (this.claims.has(id)) {
      return { kind: "claimed" as const, duplicate: true, record: this.claims.get(id)! };
    }
    if (this.completed.has(id)) {
      return { kind: "completed" as const, duplicate: true, record: { id } };
    }
    if (this.failed.has(id)) {
      return { kind: "failed" as const, duplicate: true, record: { id } };
    }
    const record: QueueRecord = {
      id,
      payload,
      metadata: options?.metadata,
      receivedAt: options?.receivedAt ?? this.now(),
      updatedAt: this.now(),
      laneKey: options?.laneKey,
      attempts: 0,
    };
    this.pending.set(id, record);
    return { kind: "accepted" as const, duplicate: false, record };
  }

  async listPending(options?: { limit?: number | "all"; orderBy?: "received" | "id" }) {
    this.listPendingCalls += 1;
    if (this.listPendingError) {
      const error = this.listPendingError;
      this.listPendingError = undefined;
      throw error;
    }
    const records = [...this.pending.values()].sort((left, right) =>
      options?.orderBy === "id"
        ? left.id.localeCompare(right.id)
        : left.receivedAt - right.receivedAt || left.id.localeCompare(right.id),
    );
    return typeof options?.limit === "number" ? records.slice(0, options.limit) : records;
  }

  async listClaims() {
    return [...this.claims.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async claim(id: string, options?: { ownerId?: string }) {
    await this.beforeClaim?.(id);
    const record = this.pending.get(id);
    if (!record) return null;
    this.pending.delete(id);
    const claim: QueueClaim = {
      ...record,
      attempts: record.attempts,
      lastAttemptAt: this.now(),
      updatedAt: this.now(),
      claim: {
        token: `claim:${id}:${record.attempts + 1}`,
        ownerId: options?.ownerId ?? "owner",
        claimedAt: this.now(),
      },
    };
    this.claims.set(id, claim);
    return claim;
  }

  async claimNext(options?: {
    ownerId?: string;
    blockedLaneKeys?: Iterable<string>;
    orderBy?: "received" | "id";
    candidateIds?: Iterable<string>;
  }) {
    const blocked = new Set(options?.blockedLaneKeys ?? []);
    const candidates = options?.candidateIds
      ? new Set(options.candidateIds)
      : undefined;
    const record = [...this.pending.values()]
      .filter((entry) => !candidates || candidates.has(entry.id))
      .filter((entry) => !entry.laneKey || !blocked.has(entry.laneKey))
      .sort((left, right) =>
        options?.orderBy === "id"
          ? left.id.localeCompare(right.id)
          : left.receivedAt - right.receivedAt || left.id.localeCompare(right.id),
      )[0];
    return record ? this.claim(record.id, { ownerId: options?.ownerId }) : null;
  }

  async refreshClaim(claimRef: { id: string; claim: { token: string } }) {
    const claim = this.claims.get(claimRef.id);
    if (!claim || claim.claim.token !== claimRef.claim.token) return false;
    claim.claim.claimedAt = this.now();
    claim.updatedAt = this.now();
    this.refreshCalls.push(claimRef.id);
    return true;
  }

  async complete(idOrClaim: string | { id: string; claim: { token: string } }, options?: {
    metadata?: { outcome: string };
  }) {
    const id = typeof idOrClaim === "string" ? idOrClaim : idOrClaim.id;
    this.pending.delete(id);
    this.claims.delete(id);
    this.completed.set(id, { metadata: options?.metadata });
    this.completeCalls.push({ id, outcome: options?.metadata?.outcome });
    return true;
  }

  async release(idOrClaim: string | { id: string; claim: { token: string } }, options?: {
    lastError?: string;
  }) {
    const id = typeof idOrClaim === "string" ? idOrClaim : idOrClaim.id;
    const claim = this.claims.get(id);
    if (!claim) return false;
    this.claims.delete(id);
    this.pending.set(id, {
      ...claim,
      attempts: claim.attempts + 1,
      updatedAt: this.now(),
      lastAttemptAt: this.now(),
      lastError: options?.lastError,
    });
    this.releaseCalls.push({ id, lastError: options?.lastError });
    return true;
  }

  async fail(idOrClaim: string | { id: string; claim: { token: string } }, options: {
    reason: string;
    message?: string;
  }) {
    const id = typeof idOrClaim === "string" ? idOrClaim : idOrClaim.id;
    this.pending.delete(id);
    this.claims.delete(id);
    this.failed.set(id, options);
    return true;
  }

  async recoverStaleClaims(options?: {
    staleMs?: number;
    now?: number;
    shouldRecover?: (claim: QueueClaim) => boolean | Promise<boolean>;
  }) {
    const now = options?.now ?? this.now();
    let recovered = 0;
    for (const claim of [...this.claims.values()]) {
      if (now - claim.claim.claimedAt < (options?.staleMs ?? 0)) continue;
      if (!(await options?.shouldRecover?.(claim) ?? true)) continue;
      this.claims.delete(claim.id);
      this.pending.set(claim.id, {
        ...claim,
        attempts: claim.attempts + 1,
        lastAttemptAt: now,
        updatedAt: now,
      });
      recovered += 1;
    }
    return recovered;
  }

  async prune() {
    return 0;
  }

  seedClaim(claim: QueueClaim) {
    this.claims.set(claim.id, claim);
  }
}

function makeMessage(fromUserId: string, text: string, extras?: Partial<{
  message_id: number;
  seq: number;
  context_token: string;
}>) {
  return {
    from_user_id: fromUserId,
    message_id: extras?.message_id,
    seq: extras?.seq,
    context_token: extras?.context_token ?? `${fromUserId}-origin`,
    create_time_ms: 1700000000000,
    item_list: [
      {
        type: MessageItemType.TEXT,
        text_item: { text },
      },
    ],
  };
}

function createChannelRuntime() {
  const routes = new Map<string, {
    agentId: string;
    sessionKey: string;
    mainSessionKey: string;
    lastRoutePolicy: "main" | "session";
  }>();
  return {
    routes,
    runtime: {
      routing: {
        resolveAgentRoute: vi.fn(({ peer }: { peer: { id: string } }) => routes.get(peer.id) ?? {
          agentId: "agent-default",
          sessionKey: `session:${peer.id}`,
          mainSessionKey: `main:${peer.id}`,
          lastRoutePolicy: "session" as const,
        }),
      },
    },
  };
}

async function waitForCondition(check: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition not met before timeout");
}

describe("monitorWeixinProvider durable ingress", () => {
  let stateDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    stateDir = fs.mkdtempSync(path.join(process.cwd(), ".monitor-test-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    mockProcessOneMessage.mockImplementation(async () => undefined);
  });

  afterEach(() => {
    clearContextTokensForAccount("acc-monitor");
    delete process.env.OPENCLAW_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("persists the cursor only after the whole batch is durably enqueued", async () => {
    const abortController = new AbortController();
    const queue = new FakeIngressQueue();
    const { runtime, routes } = createChannelRuntime();
    routes.set("user-a", {
      agentId: "agent-a",
      sessionKey: "session:user-a",
      mainSessionKey: "main:user-a",
      lastRoutePolicy: "session",
    });
    const syncFile = getSyncBufFilePath("acc-monitor");
    queue.onEnqueue = () => {
      queue.enqueueObservations.push(fs.existsSync(syncFile));
    };

    mockGetUpdates
      .mockResolvedValueOnce({
        msgs: [
          makeMessage("user-a", "one", {
            message_id: 1,
            context_token: "context-old",
          }),
          makeMessage("user-a", "two", {
            message_id: 2,
            context_token: "context-new",
          }),
        ],
        get_updates_buf: "cursor-1",
      })
      .mockImplementationOnce(async () => {
        abortController.abort();
        throw new Error("aborted");
      });

    await monitorWeixinProvider({
      baseUrl: "https://api.example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "tok",
      accountId: "acc-monitor",
      config: {} as never,
      channelRuntime: runtime as never,
      openChannelIngressQueue: (() => queue) as never,
      abortSignal: abortController.signal,
      runtime: { log: vi.fn(), error: vi.fn() },
    });

    expect(queue.enqueueObservations).toEqual([false, false]);
    expect(fs.readFileSync(syncFile, "utf8")).toContain("cursor-1");
  });

  it("does not advance the cursor when enqueueing the batch fails", async () => {
    const abortController = new AbortController();
    const queue = new FakeIngressQueue();
    const { runtime } = createChannelRuntime();
    let enqueueCount = 0;
    queue.onEnqueue = () => {
      enqueueCount += 1;
      if (enqueueCount === 2) {
        abortController.abort();
        throw new Error("enqueue failed");
      }
    };

    mockGetUpdates.mockResolvedValueOnce({
      msgs: [
        makeMessage("user-a", "one", { message_id: 1 }),
        makeMessage("user-b", "two", { message_id: 2 }),
      ],
      get_updates_buf: "cursor-fail",
    });

    await monitorWeixinProvider({
      baseUrl: "https://api.example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "tok",
      accountId: "acc-monitor",
      config: {} as never,
      channelRuntime: runtime as never,
      openChannelIngressQueue: (() => queue) as never,
      abortSignal: abortController.signal,
      runtime: { log: vi.fn(), error: vi.fn() },
    });

    expect(fs.existsSync(getSyncBufFilePath("acc-monitor"))).toBe(false);
    expect(mockProcessOneMessage).not.toHaveBeenCalled();
  });

  it("computes stable event IDs and dedicated approval lanes", () => {
    const { runtime, routes } = createChannelRuntime();
    routes.set("user-a", {
      agentId: "agent-a",
      sessionKey: "session:user-a",
      mainSessionKey: "main:user-a",
      lastRoutePolicy: "session",
    });

    expect(getDurableIngressEventId("acc-monitor", makeMessage("user-a", "text", { message_id: 42 }))).toBe(
      "message:acc-monitor:42",
    );
    expect(getDurableIngressEventId("acc-monitor", makeMessage("user-a", "text", { seq: 7 }))).toBe(
      "seq:acc-monitor:7",
    );
    expect(getDurableIngressEventId(
      "acc-monitor",
      makeMessage("user-a", "text", {
        message_id: Number.MAX_SAFE_INTEGER + 1,
        seq: 8,
      }),
    )).toBe("seq:acc-monitor:8");
    expect(getDurableIngressEventId("acc-monitor", makeMessage("user-a", "text"))).toMatch(
      /^hash:acc-monitor:[0-9a-f]{64}$/,
    );
    expect(resolveDurableIngressLaneKey({
      accountId: "acc-monitor",
      config: {} as never,
      channelRuntime: runtime as never,
      message: makeMessage("user-a", "/approve plugin:approval deny"),
    })).toBe(PLUGIN_APPROVAL_CONTROL_LANE);
  });

  it("dedupes replayed messages and frees same-session lanes on agent start while other lanes progress", async () => {
    const abortController = new AbortController();
    const queue = new FakeIngressQueue();
    const { runtime, routes } = createChannelRuntime();
    routes.set("user-a", {
      agentId: "agent-a",
      sessionKey: "session:user-a",
      mainSessionKey: "main:user-a",
      lastRoutePolicy: "session",
    });
    routes.set("user-b", {
      agentId: "agent-b",
      sessionKey: "session:user-b",
      mainSessionKey: "main:user-b",
      lastRoutePolicy: "session",
    });

    const releaseOne = Promise.withResolvers<void>();
    const releaseThree = Promise.withResolvers<void>();
    const started: string[] = [];

    mockProcessOneMessage.mockImplementation(async (message, deps) => {
      const body = message.item_list?.[0]?.text_item?.text ?? "";
      started.push(body);
      if (body === "one") {
        deps.onAgentRunStart?.("run-one");
        await releaseOne.promise;
        return;
      }
      if (body === "three") {
        await releaseThree.promise;
      }
    });

    mockGetUpdates
      .mockResolvedValueOnce({
        msgs: [
          makeMessage("user-a", "one", {
            message_id: 10,
            context_token: "context-one",
          }),
          makeMessage("user-a", "two", {
            message_id: 2,
            context_token: "context-two",
          }),
          makeMessage("user-b", "three", { message_id: 3 }),
          makeMessage("user-a", "/approve plugin:approval deny", {
            message_id: 4,
            context_token: "context-latest",
          }),
        ],
        get_updates_buf: "cursor-1",
      })
      .mockResolvedValueOnce({
        msgs: [
          makeMessage("user-a", "one", {
            message_id: 10,
            context_token: "stale",
          }),
        ],
        get_updates_buf: "cursor-2",
      })
      .mockImplementationOnce(async () => {
        await waitForCondition(() => started.includes("two") && started.includes("/approve plugin:approval deny"));
        releaseOne.resolve();
        releaseThree.resolve();
        abortController.abort();
        throw new Error("aborted");
      });

    await monitorWeixinProvider({
      baseUrl: "https://api.example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "tok",
      accountId: "acc-monitor",
      config: {} as never,
      channelRuntime: runtime as never,
      openChannelIngressQueue: (() => queue) as never,
      abortSignal: abortController.signal,
      runtime: { log: vi.fn(), error: vi.fn() },
    });

    expect(started).toEqual(expect.arrayContaining(["one", "two", "three", "/approve plugin:approval deny"]));
    expect(started.filter((entry) => entry === "one")).toHaveLength(1);
    expect(started.indexOf("two")).toBeGreaterThan(started.indexOf("one"));
    expect(started.indexOf("two")).toBeLessThan(started.length);
  });

  it("keeps queued followup claims alive until completion while freeing the ordinary lane", async () => {
    const abortController = new AbortController();
    const queue = new FakeIngressQueue();
    const { runtime, routes } = createChannelRuntime();
    routes.set("user-a", {
      agentId: "agent-a",
      sessionKey: "session:user-a",
      mainSessionKey: "main:user-a",
      lastRoutePolicy: "session",
    });

    const started: string[] = [];
    let onComplete: (() => void) | undefined;
    const queuedId = getDurableIngressEventId("acc-monitor", makeMessage("user-a", "queued-1", { message_id: 11 }));

    mockProcessOneMessage.mockImplementation(async (message, deps) => {
      const body = message.item_list?.[0]?.text_item?.text ?? "";
      started.push(body);
      if (body === "queued-1") {
        deps.queuedFollowupLifecycle?.onEnqueued?.();
        onComplete = deps.queuedFollowupLifecycle?.onComplete;
      }
    });

    mockGetUpdates
      .mockResolvedValueOnce({
        msgs: [
          makeMessage("user-a", "queued-1", { message_id: 11 }),
          makeMessage("user-a", "queued-2", { message_id: 12 }),
        ],
        get_updates_buf: "cursor-queued",
      })
      .mockImplementationOnce(async () => {
        await waitForCondition(() => started.includes("queued-2"));
        expect(queue.claims.has(queuedId)).toBe(true);
        expect(queue.completed.has(queuedId)).toBe(false);
        onComplete?.();
        await waitForCondition(() => queue.completed.has(queuedId));
        abortController.abort();
        throw new Error("aborted");
      });

    await monitorWeixinProvider({
      baseUrl: "https://api.example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "tok",
      accountId: "acc-monitor",
      config: {} as never,
      channelRuntime: runtime as never,
      openChannelIngressQueue: (() => queue) as never,
      abortSignal: abortController.signal,
      runtime: { log: vi.fn(), error: vi.fn() },
    });

    expect(started).toEqual(expect.arrayContaining(["queued-1", "queued-2"]));
    expect(queue.completeCalls).toContainEqual({ id: queuedId, outcome: "queued-followup" });
    expect(queue.refreshCalls).toContain(queuedId);
  });

  it("retries released pre-admission failures", async () => {
    vi.useFakeTimers();

    const abortController = new AbortController();
    const queue = new FakeIngressQueue(() => Date.now());
    const { runtime, routes } = createChannelRuntime();
    routes.set("user-a", {
      agentId: "agent-a",
      sessionKey: "session:user-a",
      mainSessionKey: "main:user-a",
      lastRoutePolicy: "session",
    });

    const started: string[] = [];
    mockProcessOneMessage.mockImplementation(async (message) => {
      const body = message.item_list?.[0]?.text_item?.text ?? "";
      started.push(body);
      if (body === "retry-me" && started.filter((entry) => entry === body).length === 1) {
        throw new Error("boom");
      }
    });

    mockGetUpdates
      .mockResolvedValueOnce({
        msgs: [
          makeMessage("user-a", "retry-me", { message_id: 21 }),
          makeMessage("user-a", "after-retry", { message_id: 22 }),
        ],
        get_updates_buf: "cursor-retry",
      })
      .mockImplementationOnce(async () => {
        await vi.waitFor(() => expect(started).toEqual(["retry-me"]));
        await vi.waitFor(() => expect(queue.releaseCalls).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(DURABLE_RETRY_DELAY_FOR_TESTS_MS + 1);
        await vi.waitFor(() =>
          expect(started).toEqual(["retry-me", "retry-me", "after-retry"]),
        );
        abortController.abort();
        throw new Error("aborted");
      });

    await monitorWeixinProvider({
      baseUrl: "https://api.example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "tok",
      accountId: "acc-monitor",
      config: {} as never,
      channelRuntime: runtime as never,
      openChannelIngressQueue: (() => queue) as never,
      abortSignal: abortController.signal,
      runtime: { log: vi.fn(), error: vi.fn() },
    });

    expect(started).toEqual(["retry-me", "retry-me", "after-retry"]);
    expect(queue.releaseCalls).toHaveLength(1);
    expect(queue.completeCalls.some((call) => call.outcome === "handled")).toBe(true);
  });

  it("fails a poison message after bounded retries so its lane can continue", async () => {
    const queue = new FakeIngressQueue();
    const { runtime } = createChannelRuntime();
    const poison = makeMessage("user-a", "poison", { message_id: 23 });
    const afterPoison = makeMessage("user-a", "after-poison", { message_id: 24 });
    const laneKey = "session:user-a";
    const poisonId = getDurableIngressEventId("acc-poison", poison);
    const afterPoisonId = getDurableIngressEventId("acc-poison", afterPoison);

    await queue.enqueue(
      poisonId,
      { version: 1, message: poison },
      { laneKey, metadata: { laneKey }, receivedAt: 1 },
    );
    queue.pending.get(poisonId)!.attempts = DURABLE_MAX_PROCESS_ATTEMPTS_FOR_TESTS - 1;
    await queue.enqueue(
      afterPoisonId,
      { version: 1, message: afterPoison },
      { laneKey, metadata: { laneKey }, receivedAt: 2 },
    );

    const processed: string[] = [];
    const manager = createDurableIngressManager({
      accountId: "acc-poison",
      config: {} as never,
      channelRuntime: runtime as never,
      openChannelIngressQueue: (() => queue) as never,
      log: vi.fn(),
      errLog: vi.fn(),
      aLog: mockLogger as never,
      processMessage: async (message) => {
        const body = message.item_list?.[0]?.text_item?.text ?? "";
        processed.push(body);
        if (body === "poison") throw new Error("invalid payload");
      },
    });

    await waitForCondition(() => queue.failed.has(poisonId));
    await waitForCondition(() => queue.completed.has(afterPoisonId));
    await manager.stop();

    expect(processed).toEqual(["poison", "after-poison"]);
    expect(queue.failed.get(poisonId)).toEqual({
      reason: "handler-attempts-exhausted",
      message: "Error: invalid payload",
    });
  });

  it("retries queue initialization after a transient failure", async () => {
    const queue = new FakeIngressQueue();
    queue.listPendingError = new Error("state database busy");
    const { runtime } = createChannelRuntime();
    const errLog = vi.fn();
    const processMessage = vi.fn(async () => undefined);
    const manager = createDurableIngressManager({
      accountId: "acc-init-retry",
      config: {} as never,
      channelRuntime: runtime as never,
      openChannelIngressQueue: (() => queue) as never,
      log: vi.fn(),
      errLog,
      aLog: mockLogger as never,
      processMessage,
    });

    await waitForCondition(() => errLog.mock.calls.length > 0);
    await manager.enqueueBatch([
      makeMessage("user-a", "after-init-retry", { message_id: 25 }),
    ]);
    await waitForCondition(() => processMessage.mock.calls.length === 1);
    await manager.stop();

    expect(queue.listPendingCalls).toBeGreaterThanOrEqual(2);
  });

  it("tombstones a stale claim that already exhausted its attempts", async () => {
    const queue = new FakeIngressQueue();
    const { runtime } = createChannelRuntime();
    const message = makeMessage("user-a", "exhausted-stale", { message_id: 26 });
    const id = getDurableIngressEventId("acc-exhausted", message);
    queue.seedClaim({
      id,
      payload: { version: 1, message },
      metadata: { laneKey: "session:user-a" },
      receivedAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
      laneKey: "session:user-a",
      attempts: DURABLE_MAX_PROCESS_ATTEMPTS_FOR_TESTS - 1,
      claim: {
        token: "stale-exhausted-token",
        ownerId: "999999:stale-owner",
        claimedAt: Date.now() - 60_000,
      },
    });
    const processMessage = vi.fn(async () => undefined);
    const manager = createDurableIngressManager({
      accountId: "acc-exhausted",
      config: {} as never,
      channelRuntime: runtime as never,
      openChannelIngressQueue: (() => queue) as never,
      log: vi.fn(),
      errLog: vi.fn(),
      aLog: mockLogger as never,
      processMessage,
    });

    await waitForCondition(() => queue.failed.has(id));
    await manager.stop();

    expect(processMessage).not.toHaveBeenCalled();
    expect(queue.failed.get(id)?.reason).toBe("handler-attempts-exhausted");
  });

  it("recovers stale claims owned by dead processes", async () => {
    const abortController = new AbortController();
    const queue = new FakeIngressQueue();
    const { runtime, routes } = createChannelRuntime();
    routes.set("user-a", {
      agentId: "agent-a",
      sessionKey: "session:user-a",
      mainSessionKey: "main:user-a",
      lastRoutePolicy: "session",
    });

    const staleMessage = makeMessage("user-a", "stale", { message_id: 31 });
    const staleId = getDurableIngressEventId("acc-monitor", staleMessage);
    queue.seedClaim({
      id: staleId,
      payload: { version: 1, message: staleMessage },
      metadata: { laneKey: "session:user-a" },
      receivedAt: Date.now(),
      updatedAt: Date.now(),
      laneKey: "session:user-a",
      attempts: 1,
      lastAttemptAt: Date.now(),
      claim: {
        token: "stale-token",
        ownerId: "999999:openclaw-weixin",
        claimedAt: Date.now() - 60_000,
      },
    });

    mockGetUpdates
      .mockResolvedValueOnce({ msgs: [], get_updates_buf: "cursor-stale" })
      .mockImplementationOnce(async () => {
        await waitForCondition(() => mockProcessOneMessage.mock.calls.length === 1);
        abortController.abort();
        throw new Error("aborted");
      });

    await monitorWeixinProvider({
      baseUrl: "https://api.example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "tok",
      accountId: "acc-monitor",
      config: {} as never,
      channelRuntime: runtime as never,
      openChannelIngressQueue: (() => queue) as never,
      abortSignal: abortController.signal,
      runtime: { log: vi.fn(), error: vi.fn() },
    });

    expect(mockProcessOneMessage).toHaveBeenCalledTimes(1);
    expect(queue.completeCalls).toContainEqual({ id: staleId, outcome: "handled" });
  });

  it("stops polling without releasing a handler that may still perform side effects", async () => {
    const abortController = new AbortController();
    const queue = new FakeIngressQueue();
    const { runtime, routes } = createChannelRuntime();
    routes.set("user-a", {
      agentId: "agent-a",
      sessionKey: "session:user-a",
      mainSessionKey: "main:user-a",
      lastRoutePolicy: "session",
    });

    const finishHandler = Promise.withResolvers<void>();
    mockProcessOneMessage.mockImplementation(() => finishHandler.promise);

    mockGetUpdates
      .mockResolvedValueOnce({
        msgs: [makeMessage("user-a", "abort-me", { message_id: 41 })],
        get_updates_buf: "cursor-abort",
      })
      .mockImplementationOnce(async () => {
        await waitForCondition(() => mockProcessOneMessage.mock.calls.length === 1);
        abortController.abort();
        throw new Error("aborted");
      });

    let monitorStopped = false;
    const monitor = monitorWeixinProvider({
      baseUrl: "https://api.example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "tok",
      accountId: "acc-monitor",
      config: {} as never,
      channelRuntime: runtime as never,
      openChannelIngressQueue: (() => queue) as never,
      abortSignal: abortController.signal,
      runtime: { log: vi.fn(), error: vi.fn() },
    }).then(() => {
      monitorStopped = true;
    });

    await waitForCondition(() => abortController.signal.aborted);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(monitorStopped).toBe(false);
    expect(queue.releaseCalls).toHaveLength(0);
    expect(queue.claims.size).toBe(1);

    finishHandler.resolve();
    await monitor;
    await waitForCondition(() => queue.completed.size === 1);
    expect(queue.pending.size).toBe(0);
  });

  it.each(["resolver", "opener"] as const)(
    "keeps polling with the serial fallback when the host rejects queue access via %s",
    async (failureMode) => {
      const abortController = new AbortController();
      const { runtime } = createChannelRuntime();
      const log = vi.fn();
      const started: string[] = [];

      mockProcessOneMessage.mockImplementation(async (message) => {
        started.push(message.item_list?.[0]?.text_item?.text ?? "");
      });
      mockGetUpdates
        .mockResolvedValueOnce({
          msgs: [
            makeMessage("user-a", "fallback-1", { message_id: 61 }),
            makeMessage("user-a", "fallback-2", { message_id: 62 }),
          ],
          get_updates_buf: "cursor-fallback",
        })
        .mockImplementationOnce(async () => {
          abortController.abort();
          throw new Error("aborted");
        });

      const rejectedQueueAccess = () => {
        throw new Error("trusted plugins only");
      };
      await monitorWeixinProvider({
        baseUrl: "https://api.example.com",
        cdnBaseUrl: "https://cdn.example.com",
        token: "tok",
        accountId: "acc-monitor",
        config: {} as never,
        channelRuntime: runtime as never,
        ...(failureMode === "resolver"
          ? { resolveOpenChannelIngressQueue: rejectedQueueAccess as never }
          : { openChannelIngressQueue: rejectedQueueAccess as never }),
        abortSignal: abortController.signal,
        runtime: { log, error: vi.fn() },
      });

      expect(started).toEqual(["fallback-1", "fallback-2"]);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("legacy blocking serial polling"),
      );
    },
  );

  it("finds an approval lane behind more than one scan window of a blocked session", async () => {
    const abortController = new AbortController();
    const queue = new FakeIngressQueue();
    const { runtime } = createChannelRuntime();
    const releaseOrdinary = Promise.withResolvers<void>();
    const started: string[] = [];

    mockProcessOneMessage.mockImplementation(async (message) => {
      const body = message.item_list?.[0]?.text_item?.text ?? "";
      started.push(body);
      if (body === "ordinary-0") {
        await releaseOrdinary.promise;
      }
    });
    mockGetUpdates
      .mockResolvedValueOnce({
        msgs: [
          ...Array.from({ length: 65 }, (_, index) =>
            makeMessage("user-a", `ordinary-${index}`, { message_id: 1_000 + index }),
          ),
          makeMessage("user-a", "/approve plugin:approval deny", { message_id: 2_000 }),
        ],
        get_updates_buf: "cursor-deep-approval",
      })
      .mockImplementationOnce(async () => {
        await waitForCondition(() => started.includes("/approve plugin:approval deny"));
        expect(started.filter((body) => body.startsWith("ordinary-"))).toEqual(["ordinary-0"]);
        releaseOrdinary.resolve();
        abortController.abort();
        throw new Error("aborted");
      });

    await monitorWeixinProvider({
      baseUrl: "https://api.example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "tok",
      accountId: "acc-monitor",
      config: {} as never,
      channelRuntime: runtime as never,
      openChannelIngressQueue: (() => queue) as never,
      abortSignal: abortController.signal,
      runtime: { log: vi.fn(), error: vi.fn() },
    });

    expect(started).toContain("/approve plugin:approval deny");
    expect(queue.listPendingCalls).toBeGreaterThanOrEqual(1);
  });

  it("rediscovers approvals released by another manager", async () => {
    const queue = new FakeIngressQueue();
    const { runtime } = createChannelRuntime();
    const approvalBody = "/approve plugin:approval deny";
    const releaseOwner = Promise.withResolvers<void>();
    const startedByPrimary: string[] = [];
    const startedByOwner: string[] = [];
    const common = {
      accountId: "acc-approval-rediscovery",
      config: {} as never,
      channelRuntime: runtime as never,
      openChannelIngressQueue: (() => queue) as never,
      log: vi.fn(),
      errLog: vi.fn(),
      aLog: mockLogger as never,
    };

    const primaryManager = createDurableIngressManager({
      ...common,
      processMessage: async (message) => {
        startedByPrimary.push(message.item_list?.[0]?.text_item?.text ?? "");
      },
    });
    primaryManager.requestDrain();
    await waitForCondition(() => queue.listPendingCalls >= 1);

    const ownerManager = createDurableIngressManager({
      ...common,
      processMessage: async (message) => {
        startedByOwner.push(message.item_list?.[0]?.text_item?.text ?? "");
        await releaseOwner.promise;
        throw new Error("retry approval");
      },
    });
    const approval = makeMessage("user-a", approvalBody, { message_id: 2_100 });
    const approvalId = getDurableIngressEventId("acc-approval-rediscovery", approval);
    await ownerManager.enqueueBatch([approval]);
    await waitForCondition(() => startedByOwner.includes(approvalBody));
    releaseOwner.resolve();
    await waitForCondition(() => queue.releaseCalls.some((call) => call.id === approvalId));
    await ownerManager.stop();

    primaryManager.requestDrain();
    await waitForCondition(() => startedByPrimary.includes(approvalBody));
    await primaryManager.stop();
  });

  it("waits only for pre-transfer admission before completing a reload stop", async () => {
    const queue = new FakeIngressQueue();
    const { runtime } = createChannelRuntime();
    const releaseOld = Promise.withResolvers<void>();
    const started: string[] = [];
    const common = {
      accountId: "acc-reload",
      config: {} as never,
      channelRuntime: runtime as never,
      openChannelIngressQueue: (() => queue) as never,
      log: vi.fn(),
      errLog: vi.fn(),
      aLog: mockLogger as never,
    };

    const oldManager = createDurableIngressManager({
      ...common,
      processMessage: async (message) => {
        started.push(message.item_list?.[0]?.text_item?.text ?? "");
        await releaseOld.promise;
      },
    });
    await oldManager.enqueueBatch([
      makeMessage("user-a", "old-handler", { message_id: 71 }),
    ]);
    await waitForCondition(() => started.length === 1);
    let oldStopped = false;
    const stoppingOld = oldManager.stop().then(() => {
      oldStopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(oldStopped).toBe(false);
    releaseOld.resolve();
    await stoppingOld;

    const newManager = createDurableIngressManager({
      ...common,
      processMessage: async (message) => {
        started.push(message.item_list?.[0]?.text_item?.text ?? "");
      },
    });
    await newManager.enqueueBatch([
      makeMessage("user-a", "new-handler", { message_id: 72 }),
    ]);
    await waitForCondition(() => started.includes("new-handler"));
    await waitForCondition(() => queue.completed.size === 2);
    await newManager.stop();
  });

  it("blocks same-session claims while another live owner still holds that lane", async () => {
    const queue = new FakeIngressQueue();
    const { runtime } = createChannelRuntime();
    const releaseOld = Promise.withResolvers<void>();
    const oldStarted: string[] = [];
    const newStarted: string[] = [];
    const common = {
      accountId: "acc-reload-overlap",
      config: {} as never,
      channelRuntime: runtime as never,
      openChannelIngressQueue: (() => queue) as never,
      log: vi.fn(),
      errLog: vi.fn(),
      aLog: mockLogger as never,
    };

    const oldManager = createDurableIngressManager({
      ...common,
      processMessage: async (message) => {
        oldStarted.push(message.item_list?.[0]?.text_item?.text ?? "");
        await releaseOld.promise;
      },
    });
    await oldManager.enqueueBatch([
      makeMessage("user-a", "old-overlap", { message_id: 91 }),
    ]);
    await waitForCondition(() => oldStarted.length === 1);
    const stoppingOld = oldManager.stop();

    const newManager = createDurableIngressManager({
      ...common,
      processMessage: async (message) => {
        newStarted.push(message.item_list?.[0]?.text_item?.text ?? "");
      },
    });
    await newManager.enqueueBatch([
      makeMessage("user-a", "new-overlap", { message_id: 92 }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(newStarted).toEqual([]);

    releaseOld.resolve();
    await stoppingOld;
    newManager.requestDrain();
    await waitForCondition(() => newStarted.includes("new-overlap"));
    await newManager.stop();
  });

  it("releases a claim obtained after stop without starting its handler", async () => {
    const queue = new FakeIngressQueue();
    const { runtime } = createChannelRuntime();
    const claimStarted = Promise.withResolvers<void>();
    const allowClaim = Promise.withResolvers<void>();
    const processMessage = vi.fn(async () => undefined);
    queue.beforeClaim = async () => {
      claimStarted.resolve();
      await allowClaim.promise;
    };

    const manager = createDurableIngressManager({
      accountId: "acc-claim-race",
      config: {} as never,
      channelRuntime: runtime as never,
      openChannelIngressQueue: (() => queue) as never,
      log: vi.fn(),
      errLog: vi.fn(),
      aLog: mockLogger as never,
      processMessage,
    });
    await manager.enqueueBatch([
      makeMessage("user-a", "claim-race", { message_id: 81 }),
    ]);
    await claimStarted.promise;
    const stopping = manager.stop();
    allowClaim.resolve();
    await stopping;

    await waitForCondition(() => queue.releaseCalls.length === 1);
    expect(processMessage).not.toHaveBeenCalled();
    expect(queue.pending.has("message:acc-claim-race:81")).toBe(true);
  });

  it("keeps legacy hosts serial and warns only once", async () => {
    const abortController = new AbortController();
    const { runtime } = createChannelRuntime();
    const log = vi.fn();
    const releaseFirst = Promise.withResolvers<void>();
    const started: string[] = [];

    mockProcessOneMessage.mockImplementation(async (message) => {
      const body = message.item_list?.[0]?.text_item?.text ?? "";
      started.push(body);
      if (body === "serial-1") {
        await releaseFirst.promise;
      }
    });

    mockGetUpdates
      .mockResolvedValueOnce({
        msgs: [
          makeMessage("user-a", "serial-1", { message_id: 51 }),
          makeMessage("user-a", "serial-2", { message_id: 52 }),
        ],
        get_updates_buf: "cursor-legacy-1",
      })
      .mockImplementationOnce(
        ({ abortSignal }: { abortSignal?: AbortSignal }) =>
          new Promise((_, reject) => {
            abortSignal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
      );

    const monitor = monitorWeixinProvider({
      baseUrl: "https://api.example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "tok",
      accountId: "acc-monitor",
      config: {} as never,
      channelRuntime: runtime as never,
      abortSignal: abortController.signal,
      runtime: { log, error: vi.fn() },
    });

    await waitForCondition(() => started.length === 1);
    expect(started).toEqual(["serial-1"]);
    releaseFirst.resolve();
    await waitForCondition(() => started.includes("serial-2"));
    abortController.abort();
    await monitor;

    expect(started).toEqual(["serial-1", "serial-2"]);
    expect(log.mock.calls.filter(([message]) =>
      String(message).includes("legacy blocking serial polling"),
    )).toHaveLength(1);
  });
});
