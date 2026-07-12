import { createHash, randomUUID } from "node:crypto";

import type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueClaimRef,
  ChannelIngressQueueRecord,
} from "openclaw/plugin-sdk/channel-message-runtime";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";

import type { WeixinMessage } from "../api/types.js";
import { extractTextBody } from "../messaging/process-message.js";
import type { Logger } from "../util/logger.js";

const DURABLE_INGRESS_VERSION = 1;
const ORDINARY_ADMISSION_LIMIT = 4;
const APPROVAL_ADMISSION_LIMIT = 1;
const MAX_PROCESS_ATTEMPTS = 5;
const RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 30_000;
const CLAIM_REFRESH_INTERVAL_MS = 5_000;
const CLAIM_STALE_MS = 30_000;
const QUEUE_PRUNE_INTERVAL_MS = 60_000;
const COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILED_TTL_MS = 24 * 60 * 60 * 1000;
const COMPLETED_MAX_ENTRIES = 8_192;
const FAILED_MAX_ENTRIES = 1_024;
const LIVE_OWNERS_SYMBOL = Symbol.for("openclaw-weixin.live-ingress-owners");

export const PLUGIN_APPROVAL_CONTROL_LANE = "plugin-approval-control";
export const DURABLE_RETRY_DELAY_FOR_TESTS_MS = RETRY_DELAY_MS;
export const DURABLE_MAX_PROCESS_ATTEMPTS_FOR_TESTS = MAX_PROCESS_ATTEMPTS;

type DurableIngressPayload = {
  version: typeof DURABLE_INGRESS_VERSION;
  message: WeixinMessage;
};

type DurableIngressMetadata = {
  laneKey?: string;
};

type DurableIngressCompletedMetadata = {
  outcome: "handled" | "agent-run" | "queued-followup";
};

type DurableIngressQueue = ChannelIngressQueue<
  DurableIngressPayload,
  DurableIngressMetadata,
  DurableIngressCompletedMetadata
>;
type DurableIngressClaim = ChannelIngressQueueClaim<
  DurableIngressPayload,
  DurableIngressMetadata
>;
type DurableIngressRecord = ChannelIngressQueueRecord<
  DurableIngressPayload,
  DurableIngressMetadata
>;

export type OpenChannelIngressQueue = PluginRuntime["state"]["openChannelIngressQueue"];

export type DurableIngressLifecycle = {
  receivedAt: number;
  onAgentRunStart: (runId: string) => void;
  queuedFollowupLifecycle: {
    onEnqueued: () => void;
    onComplete: () => void;
  };
};

type Admission = {
  promise: Promise<void>;
  resolve: () => void;
};

type ActiveClaim = {
  claim: DurableIngressClaim;
  laneKey: string;
  kind: "ordinary" | "approval";
  phase: "processing" | "queued" | "settling" | "finished";
  admitted: boolean;
  admission: Admission;
  refreshTimer?: ReturnType<typeof setInterval>;
  refreshRunning?: boolean;
  operation?: Promise<void>;
};

export type DurableIngressManager = {
  enqueueBatch(messages: WeixinMessage[]): Promise<void>;
  requestDrain(): void;
  stop(): Promise<void>;
};

function createAdmission(): Admission {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalStringify(entryValue)}`)
    .join(",")}}`;
}

export function getDurableIngressEventId(accountId: string, message: WeixinMessage): string {
  if (typeof message.message_id === "number" && Number.isSafeInteger(message.message_id)) {
    return `message:${accountId}:${message.message_id}`;
  }
  if (typeof message.seq === "number" && Number.isSafeInteger(message.seq)) {
    return `seq:${accountId}:${message.seq}`;
  }
  return `hash:${accountId}:${createHash("sha256")
    .update(canonicalStringify(message))
    .digest("hex")}`;
}

export function resolveDurableIngressLaneKey(params: {
  accountId: string;
  config: OpenClawConfig;
  channelRuntime: PluginRuntime["channel"];
  message: WeixinMessage;
}): string {
  const textBody = extractTextBody(params.message.item_list).trim();
  if (/^\/approve(?:\s|$)/i.test(textBody) && /\bplugin:/i.test(textBody)) {
    return PLUGIN_APPROVAL_CONTROL_LANE;
  }
  const peerId = params.message.from_user_id ?? "";
  const route = params.channelRuntime.routing.resolveAgentRoute({
    cfg: params.config,
    channel: "openclaw-weixin",
    accountId: params.accountId,
    peer: { kind: "direct", id: peerId },
  });
  return route.sessionKey ?? route.mainSessionKey ?? `openclaw-weixin:${params.accountId}:${peerId}`;
}

function claimRef(claim: DurableIngressClaim): ChannelIngressQueueClaimRef {
  return { id: claim.id, claim: { token: claim.claim.token } };
}

function liveOwners(): Set<string> {
  const existing = Reflect.get(globalThis, LIVE_OWNERS_SYMBOL);
  if (existing instanceof Set) return existing as Set<string>;
  const owners = new Set<string>();
  Reflect.set(globalThis, LIVE_OWNERS_SYMBOL, owners);
  return owners;
}

function ownerPid(ownerId: string): number {
  const separator = ownerId.indexOf(":");
  return Number.parseInt(separator === -1 ? ownerId : ownerId.slice(0, separator), 10);
}

function isLocalOwnerLive(ownerId: string): boolean {
  return ownerPid(ownerId) === process.pid && liveOwners().has(ownerId);
}

function retryBackoffMs(attempts: number): number {
  return Math.min(
    RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1),
    MAX_RETRY_DELAY_MS,
  );
}

function retryAvailableAt(record: DurableIngressRecord): number | undefined {
  if (!record.lastError || !record.lastAttemptAt || record.attempts <= 0) return undefined;
  return record.lastAttemptAt + retryBackoffMs(record.attempts);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

class WeixinDurableIngressManager implements DurableIngressManager {
  private readonly ownerId = `${process.pid}:${randomUUID()}`;
  private readonly active = new Map<string, ActiveClaim>();
  private readonly activeLaneKeys = new Set<string>();
  private readonly stopWake = createAdmission();
  private ordinaryAdmissions = 0;
  private approvalAdmissions = 0;
  private stopped = false;
  private drainPromise?: Promise<void>;
  private drainAgain = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryAt = 0;
  private lastPrunedAt = 0;
  private lastReceivedAt = 0;
  private initialization?: Promise<void>;
  private readonly pendingApprovalIds = new Set<string>();
  private readonly persistedClaimLaneKeys = new Set<string>();
  private readonly retryAtByLane = new Map<string, number>();

  constructor(
    private readonly options: {
      accountId: string;
      config: OpenClawConfig;
      channelRuntime: PluginRuntime["channel"];
      queue: DurableIngressQueue;
      log: (message: string) => void;
      errLog: (message: string) => void;
      aLog: Logger;
      onDurableMessage?: (message: WeixinMessage, receivedAt: number) => void;
      processMessage: (
        message: WeixinMessage,
        lifecycle: DurableIngressLifecycle,
      ) => Promise<void>;
    },
  ) {
    liveOwners().add(this.ownerId);
  }

  async enqueueBatch(messages: WeixinMessage[]): Promise<void> {
    await this.ensureInitialized();
    for (const message of messages) {
      const id = getDurableIngressEventId(this.options.accountId, message);
      const laneKey = resolveDurableIngressLaneKey({
        accountId: this.options.accountId,
        config: this.options.config,
        channelRuntime: this.options.channelRuntime,
        message,
      });
      this.lastReceivedAt = Math.max(Date.now(), this.lastReceivedAt + 1);
      const result = await this.options.queue.enqueue(
        id,
        { version: DURABLE_INGRESS_VERSION, message },
        {
          metadata: { laneKey },
          laneKey,
          receivedAt: this.lastReceivedAt,
        },
      );
      if (
        laneKey === PLUGIN_APPROVAL_CONTROL_LANE &&
        (result.kind === "accepted" || result.kind === "pending")
      ) {
        this.pendingApprovalIds.add(id);
      }
      if (
        result.kind === "accepted" ||
        result.kind === "pending" ||
        result.kind === "claimed"
      ) {
        this.options.onDurableMessage?.(
          result.record.payload.message,
          result.record.receivedAt,
        );
      }
    }
    this.requestDrain();
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialization) {
      const initialization = this.reloadPendingMetadata();
      this.initialization = initialization;
      void initialization.catch(() => {
        if (this.initialization === initialization) this.initialization = undefined;
      });
    }
    return this.initialization;
  }

  private async reloadPendingMetadata(): Promise<void> {
    const [pending, claims] = await Promise.all([
      this.options.queue.listPending({ limit: "all", orderBy: "received" }),
      this.options.queue.listClaims(),
    ]);
    let latestReceivedAt = Date.now() - 1;
    for (const record of pending) {
      latestReceivedAt = Math.max(latestReceivedAt, record.receivedAt);
    }
    for (const claim of claims) {
      latestReceivedAt = Math.max(latestReceivedAt, claim.receivedAt);
    }
    this.lastReceivedAt = Math.max(this.lastReceivedAt, latestReceivedAt);
    this.replacePersistedClaimLaneKeys(claims);

    const seenLaneKeys = new Set<string>();
    for (const record of pending) {
      const laneKey = record.laneKey ?? record.metadata?.laneKey;
      if (!laneKey) continue;
      if (laneKey === PLUGIN_APPROVAL_CONTROL_LANE) {
        this.pendingApprovalIds.add(record.id);
      }
      if (seenLaneKeys.has(laneKey)) continue;
      seenLaneKeys.add(laneKey);
      const retryAt = retryAvailableAt(record);
      if (retryAt !== undefined && retryAt > Date.now()) {
        this.retryAtByLane.set(
          laneKey,
          Math.max(this.retryAtByLane.get(laneKey) ?? 0, retryAt),
        );
      }
    }
  }

  private async reloadPersistedClaimLaneKeys(): Promise<void> {
    this.replacePersistedClaimLaneKeys(await this.options.queue.listClaims());
  }

  private replacePersistedClaimLaneKeys(claims: DurableIngressClaim[]): void {
    const laneKeys = new Set<string>();
    for (const claim of claims) {
      if (isLocalOwnerLive(claim.claim.ownerId)) continue;
      const laneKey = claim.laneKey ?? claim.metadata?.laneKey;
      if (laneKey) laneKeys.add(laneKey);
    }
    this.persistedClaimLaneKeys.clear();
    for (const laneKey of laneKeys) this.persistedClaimLaneKeys.add(laneKey);
  }

  requestDrain(): void {
    if (this.stopped) return;
    if (this.drainPromise) {
      this.drainAgain = true;
      return;
    }
    const drain = this.drainLoop().catch((err) => {
      this.options.errLog(`weixin durable ingress drain failed: ${String(err)}`);
      this.options.aLog.error(`durable ingress drain failed: ${String(err)}`);
      this.scheduleDrain(RETRY_DELAY_MS);
    });
    this.drainPromise = drain.finally(() => {
      this.drainPromise = undefined;
      if (this.drainAgain && !this.stopped) {
        this.drainAgain = false;
        this.requestDrain();
      }
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopWake.resolve();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.drainPromise;
    await Promise.all(
      [...this.active.values()]
        .filter((state) => state.admitted)
        .map((state) => state.admission.promise),
    );
    this.retireOwnerIfIdle();
  }

  private async drainLoop(): Promise<void> {
    do {
      this.drainAgain = false;
      await this.drainOnce();
    } while (this.drainAgain && !this.stopped);
  }

  private async drainOnce(): Promise<void> {
    await this.ensureInitialized();
    const recovered = await this.options.queue.recoverStaleClaims({
      staleMs: CLAIM_STALE_MS,
      shouldRecover: (claim) =>
        !this.active.has(claim.id) && !isLocalOwnerLive(claim.claim.ownerId),
    });
    if (recovered > 0) {
      this.options.log(`[weixin] recovered ${recovered} stale inbound claim(s)`);
      await this.reloadPendingMetadata();
    } else if (this.persistedClaimLaneKeys.size > 0) {
      await this.reloadPersistedClaimLaneKeys();
    }
    await this.pruneIfDue();

    const blockedLaneKeys = new Set([
      ...this.activeLaneKeys,
      ...this.persistedClaimLaneKeys,
    ]);
    let nextRetryMs = Number.POSITIVE_INFINITY;
    const now = Date.now();
    for (const [laneKey, retryAt] of this.retryAtByLane) {
      if (retryAt <= now) {
        this.retryAtByLane.delete(laneKey);
      } else {
        blockedLaneKeys.add(laneKey);
        nextRetryMs = Math.min(nextRetryMs, retryAt - now);
      }
    }

    if (
      !this.stopped &&
      this.approvalAdmissions < APPROVAL_ADMISSION_LIMIT &&
      !blockedLaneKeys.has(PLUGIN_APPROVAL_CONTROL_LANE) &&
      this.pendingApprovalIds.size > 0
    ) {
      const candidateIds = [...this.pendingApprovalIds];
      const claim = await this.options.queue.claimNext({
        ownerId: this.ownerId,
        candidateIds,
        orderBy: "received",
      });
      if (claim) {
        this.pendingApprovalIds.delete(claim.id);
        await this.startClaimOrRelease(claim, PLUGIN_APPROVAL_CONTROL_LANE, "approval");
      } else {
        for (const id of candidateIds) this.pendingApprovalIds.delete(id);
        await this.reloadPendingMetadata();
        if (this.pendingApprovalIds.size > 0) nextRetryMs = Math.min(nextRetryMs, 250);
      }
    }

    while (!this.stopped && this.ordinaryAdmissions < ORDINARY_ADMISSION_LIMIT) {
      const claim = await this.options.queue.claimNext({
        ownerId: this.ownerId,
        blockedLaneKeys: new Set([
          ...blockedLaneKeys,
          ...this.activeLaneKeys,
          PLUGIN_APPROVAL_CONTROL_LANE,
        ]),
        orderBy: "received",
      });
      if (!claim) break;
      const laneKey = claim.laneKey ?? claim.metadata?.laneKey;
      if (!laneKey) {
        await this.options.queue.fail(claimRef(claim), {
          reason: "missing-lane-key",
          message: "Durable Weixin ingress record has no lane key.",
        });
        continue;
      }
      await this.startClaimOrRelease(claim, laneKey, "ordinary");
    }

    this.scheduleDrain(Math.min(nextRetryMs, CLAIM_STALE_MS));
  }

  private async startClaimOrRelease(
    claim: DurableIngressClaim,
    laneKey: string,
    kind: ActiveClaim["kind"],
  ): Promise<void> {
    if (this.stopped) {
      await this.options.queue.release(claimRef(claim), {
        lastError: "monitor stopped before handler started",
      });
      return;
    }
    this.options.onDurableMessage?.(claim.payload.message, claim.receivedAt);
    this.startClaim(claim, laneKey, kind);
  }

  private startClaim(
    claim: DurableIngressClaim,
    laneKey: string,
    kind: ActiveClaim["kind"],
  ): void {
    const state: ActiveClaim = {
      claim,
      laneKey,
      kind,
      phase: "processing",
      admitted: true,
      admission: createAdmission(),
    };
    this.active.set(claim.id, state);
    this.activeLaneKeys.add(laneKey);
    if (kind === "approval") this.approvalAdmissions += 1;
    else this.ordinaryAdmissions += 1;
    this.startRefresh(state);

    if (claim.attempts >= MAX_PROCESS_ATTEMPTS) {
      this.options.errLog(
        `weixin durable ingress discarded exhausted claim ${claim.id} after ${claim.attempts} attempts`,
      );
      void this.fail(
        state,
        "Recovered claim had already exhausted its processing attempts.",
      );
      return;
    }

    const lifecycle: DurableIngressLifecycle = {
      receivedAt: claim.receivedAt,
      onAgentRunStart: () => {
        if (state.phase === "processing") void this.complete(state, "agent-run");
      },
      queuedFollowupLifecycle: {
        onEnqueued: () => {
          if (state.phase !== "processing") return;
          state.phase = "queued";
          // OpenClaw now owns session ordering; retain the claim but free ingress admission.
          this.releaseAdmission(state);
          this.requestDrain();
        },
        onComplete: () => {
          if (state.phase === "queued") void this.complete(state, "queued-followup");
        },
      },
    };

    void this.options.processMessage(claim.payload.message, lifecycle).then(
      () => {
        if (state.phase === "processing") void this.complete(state, "handled");
      },
      (err) => {
        if (state.phase === "processing") {
          const message = String(err);
          const currentAttempt = state.claim.attempts + 1;
          if (currentAttempt >= MAX_PROCESS_ATTEMPTS) {
            this.options.errLog(
              `weixin durable ingress exhausted ${MAX_PROCESS_ATTEMPTS} attempts for ${state.claim.id}: ${message}`,
            );
            void this.fail(state, message);
          } else {
            void this.release(state, message);
          }
          return;
        }
        this.options.aLog.warn(
          `durable ingress handler failed after ownership transfer id=${claim.id}: ${String(err)}`,
        );
      },
    );
  }

  private complete(
    state: ActiveClaim,
    outcome: DurableIngressCompletedMetadata["outcome"],
  ): Promise<void> {
    if (state.phase === "settling" || state.phase === "finished") {
      return state.operation ?? Promise.resolve();
    }
    state.phase = "settling";
    if (outcome !== "handled") this.releaseAdmission(state);
    return this.runQueueOperation(state, "complete", () =>
      this.options.queue.complete(claimRef(state.claim), { metadata: { outcome } }),
    );
  }

  private release(state: ActiveClaim, lastError: string): Promise<void> {
    if (state.phase === "settling" || state.phase === "finished") {
      return state.operation ?? Promise.resolve();
    }
    state.phase = "settling";
    const releasedAt = Date.now();
    return this.runQueueOperation(state, "release", async () => {
      const changed = await this.options.queue.release(claimRef(state.claim), {
        lastError,
        releasedAt,
      });
      if (changed) {
        const attempts = state.claim.attempts + 1;
        this.retryAtByLane.set(
          state.laneKey,
          releasedAt + retryBackoffMs(attempts),
        );
        if (state.kind === "approval") this.pendingApprovalIds.add(state.claim.id);
      }
      return changed;
    });
  }

  private fail(state: ActiveClaim, message: string): Promise<void> {
    if (state.phase === "settling" || state.phase === "finished") {
      return state.operation ?? Promise.resolve();
    }
    state.phase = "settling";
    return this.runQueueOperation(state, "fail", () =>
      this.options.queue.fail(claimRef(state.claim), {
        reason: "handler-attempts-exhausted",
        message,
      }),
    );
  }

  private runQueueOperation(
    state: ActiveClaim,
    operationName: "complete" | "release" | "fail",
    operation: () => Promise<boolean>,
  ): Promise<void> {
    const task = (async () => {
      let delayMs = 250;
      while (state.phase === "settling") {
        try {
          const changed = await operation();
          if (!changed) {
            this.options.aLog.warn(
              `durable ingress ${operationName} lost claim id=${state.claim.id}`,
            );
          }
          this.finishClaim(state);
          return;
        } catch (err) {
          this.options.errLog(
            `weixin durable ingress ${operationName} failed for ${state.claim.id}: ${String(err)}`,
          );
          const canAbandonOnStop =
            operationName === "release" || operationName === "fail";
          if (this.stopped && canAbandonOnStop) {
            this.finishClaim(state);
            return;
          }
          if (canAbandonOnStop) {
            await Promise.race([sleep(delayMs), this.stopWake.promise]);
            if (this.stopped) {
              this.finishClaim(state);
              return;
            }
          } else {
            await sleep(delayMs);
          }
          delayMs = Math.min(delayMs * 2, MAX_RETRY_DELAY_MS);
        }
      }
    })();
    state.operation = task;
    return task;
  }

  private finishClaim(state: ActiveClaim): void {
    if (state.phase === "finished") return;
    state.phase = "finished";
    this.stopRefresh(state);
    this.releaseAdmission(state);
    this.active.delete(state.claim.id);
    if (!this.stopped) this.requestDrain();
    this.retireOwnerIfIdle();
  }

  private releaseAdmission(state: ActiveClaim): void {
    if (!state.admitted) return;
    state.admitted = false;
    this.activeLaneKeys.delete(state.laneKey);
    if (state.kind === "approval") this.approvalAdmissions -= 1;
    else this.ordinaryAdmissions -= 1;
    state.admission.resolve();
  }

  private startRefresh(state: ActiveClaim): void {
    const refresh = async () => {
      if (state.phase === "finished" || state.refreshRunning) return;
      state.refreshRunning = true;
      try {
        const refreshed = await this.options.queue.refreshClaim?.(claimRef(state.claim));
        if (refreshed === false) {
          this.options.aLog.warn(`durable ingress refresh lost claim id=${state.claim.id}`);
          this.finishClaim(state);
        }
      } catch (err) {
        this.options.aLog.warn(
          `durable ingress refresh failed id=${state.claim.id}: ${String(err)}`,
        );
      } finally {
        state.refreshRunning = false;
      }
    };
    void refresh();
    state.refreshTimer = setInterval(() => void refresh(), CLAIM_REFRESH_INTERVAL_MS);
    state.refreshTimer.unref?.();
  }

  private stopRefresh(state: ActiveClaim): void {
    if (!state.refreshTimer) return;
    clearInterval(state.refreshTimer);
    state.refreshTimer = undefined;
  }

  private scheduleDrain(delayMs: number): void {
    if (this.stopped) return;
    const dueAt = Date.now() + Math.max(0, delayMs);
    if (this.retryTimer && this.retryAt <= dueAt) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryAt = dueAt;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryAt = 0;
      this.requestDrain();
    }, Math.max(0, dueAt - Date.now()));
    this.retryTimer.unref?.();
  }

  private async pruneIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPrunedAt < QUEUE_PRUNE_INTERVAL_MS) return;
    this.lastPrunedAt = now;
    await this.options.queue.prune({
      completedTtlMs: COMPLETED_TTL_MS,
      failedTtlMs: FAILED_TTL_MS,
      completedMaxEntries: COMPLETED_MAX_ENTRIES,
      failedMaxEntries: FAILED_MAX_ENTRIES,
      protectIds: this.active.keys(),
      now,
    });
  }

  private retireOwnerIfIdle(): void {
    if (this.stopped && this.active.size === 0) liveOwners().delete(this.ownerId);
  }
}

export function createDurableIngressManager(options: {
  accountId: string;
  config: OpenClawConfig;
  channelRuntime: PluginRuntime["channel"];
  openChannelIngressQueue: OpenChannelIngressQueue;
  log: (message: string) => void;
  errLog: (message: string) => void;
  aLog: Logger;
  onDurableMessage?: (message: WeixinMessage, receivedAt: number) => void;
  processMessage: (
    message: WeixinMessage,
    lifecycle: DurableIngressLifecycle,
  ) => Promise<void>;
}): DurableIngressManager {
  const queue = options.openChannelIngressQueue<
    DurableIngressPayload,
    DurableIngressMetadata,
    DurableIngressCompletedMetadata
  >({ accountId: options.accountId });
  const manager = new WeixinDurableIngressManager({ ...options, queue });
  manager.requestDrain();
  return manager;
}
