// WeChat thread bindings adapter.
//
// Lets the openclaw ACP runtime keep a persistent session bound to a WeChat
// 1:1 conversation, so `sessions_spawn(runtime="acp", mode="session",
// thread=true)` can actually route follow-up prompts back to the same
// Claude Code / Codex / Gemini CLI session instead of failing with
// `thread_binding_invalid: Thread bindings are unavailable for openclaw-weixin`.
//
// Structurally this is a slimmed-down port of the Telegram adapter in the
// openclaw monorepo (extensions/telegram/src/thread-bindings.ts), with the
// forum-topic / group handling removed because the WeChat plugin currently
// treats all inbound traffic as 1:1 direct chat. Conversation identifiers are
// therefore just the sender's WeChat id (e.g. `xxx@im.wechat`), scoped per
// WeChat bot accountId.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatThreadBindingDurationLabel,
  registerSessionBindingAdapter,
  resolveThreadBindingConversationIdFromBindingId,
  resolveThreadBindingEffectiveExpiresAt,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const WEIXIN_CHANNEL_ID = "openclaw-weixin";
const DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_THREAD_BINDING_MAX_AGE_MS = 0;
const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 60_000;
const STORE_VERSION = 1;

type WeixinBindingTargetKind = "subagent" | "acp";

export type WeixinThreadBindingRecord = {
  accountId: string;
  conversationId: string;
  targetKind: WeixinBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
  metadata?: Record<string, unknown>;
};

type StoredWeixinBindingState = {
  version: number;
  bindings: WeixinThreadBindingRecord[];
};

export type WeixinThreadBindingManager = {
  accountId: string;
  shouldPersistMutations: () => boolean;
  getIdleTimeoutMs: () => number;
  getMaxAgeMs: () => number;
  getByConversationId: (conversationId: string) => WeixinThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => WeixinThreadBindingRecord[];
  listBindings: () => WeixinThreadBindingRecord[];
  touchConversation: (conversationId: string, at?: number) => WeixinThreadBindingRecord | null;
  unbindConversation: (params: { conversationId: string; reason?: string }) => WeixinThreadBindingRecord | null;
  unbindBySessionKey: (params: { targetSessionKey: string; reason?: string }) => WeixinThreadBindingRecord[];
  stop: () => void;
};

type WeixinThreadBindingsState = {
  managersByAccountId: Map<string, WeixinThreadBindingManager>;
  bindingsByAccountConversation: Map<string, WeixinThreadBindingRecord>;
  persistQueueByAccountId: Map<string, Promise<void>>;
};

/**
 * Keep WeChat thread binding state shared across bundled chunks so routing,
 * binding lookups, and binding mutations all observe the same live registry.
 */
const WEIXIN_THREAD_BINDINGS_STATE_KEY = Symbol.for("openclaw.weixinThreadBindingsState");
let threadBindingsState: WeixinThreadBindingsState | undefined;

function getThreadBindingsState(): WeixinThreadBindingsState {
  if (!threadBindingsState) {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    threadBindingsState = (globalStore[WEIXIN_THREAD_BINDINGS_STATE_KEY] as
      | WeixinThreadBindingsState
      | undefined) ?? {
      managersByAccountId: new Map<string, WeixinThreadBindingManager>(),
      bindingsByAccountConversation: new Map<string, WeixinThreadBindingRecord>(),
      persistQueueByAccountId: new Map<string, Promise<void>>(),
    };
    globalStore[WEIXIN_THREAD_BINDINGS_STATE_KEY] = threadBindingsState;
  }
  return threadBindingsState;
}

function normalizeDurationMs(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(0, Math.floor(raw));
}

function resolveBindingKey(params: { accountId: string; conversationId: string }): string {
  return `${params.accountId}:${params.conversationId}`;
}

function toSessionBindingTargetKind(raw: WeixinBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toWeixinTargetKind(raw: BindingTargetKind): WeixinBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

function toSessionBindingRecord(
  record: WeixinThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  return {
    bindingId: resolveBindingKey({
      accountId: record.accountId,
      conversationId: record.conversationId,
    }),
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: WEIXIN_CHANNEL_ID,
      accountId: record.accountId,
      conversationId: record.conversationId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: resolveThreadBindingEffectiveExpiresAt({
      record,
      defaultIdleTimeoutMs: defaults.idleTimeoutMs,
      defaultMaxAgeMs: defaults.maxAgeMs,
    }),
    metadata: {
      agentId: record.agentId,
      label: record.label,
      boundBy: record.boundBy,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs:
        typeof record.idleTimeoutMs === "number"
          ? Math.max(0, Math.floor(record.idleTimeoutMs))
          : defaults.idleTimeoutMs,
      maxAgeMs:
        typeof record.maxAgeMs === "number"
          ? Math.max(0, Math.floor(record.maxAgeMs))
          : defaults.maxAgeMs,
      ...record.metadata,
    },
  };
}

function fromSessionBindingInput(params: {
  accountId: string;
  input: {
    targetSessionKey: string;
    targetKind: BindingTargetKind;
    conversationId: string;
    metadata?: Record<string, unknown>;
  };
}): WeixinThreadBindingRecord {
  const now = Date.now();
  const metadata = params.input.metadata ?? {};
  const existing = getThreadBindingsState().bindingsByAccountConversation.get(
    resolveBindingKey({
      accountId: params.accountId,
      conversationId: params.input.conversationId,
    }),
  );

  const record: WeixinThreadBindingRecord = {
    accountId: params.accountId,
    conversationId: params.input.conversationId,
    targetKind: toWeixinTargetKind(params.input.targetKind),
    targetSessionKey: params.input.targetSessionKey,
    agentId:
      typeof metadata.agentId === "string" && metadata.agentId.trim()
        ? metadata.agentId.trim()
        : existing?.agentId,
    label:
      typeof metadata.label === "string" && metadata.label.trim()
        ? metadata.label.trim()
        : existing?.label,
    boundBy:
      typeof metadata.boundBy === "string" && metadata.boundBy.trim()
        ? metadata.boundBy.trim()
        : existing?.boundBy,
    boundAt: now,
    lastActivityAt: now,
    metadata: {
      ...existing?.metadata,
      ...metadata,
    },
  };

  if (typeof metadata.idleTimeoutMs === "number" && Number.isFinite(metadata.idleTimeoutMs)) {
    record.idleTimeoutMs = Math.max(0, Math.floor(metadata.idleTimeoutMs));
  } else if (typeof existing?.idleTimeoutMs === "number") {
    record.idleTimeoutMs = existing.idleTimeoutMs;
  }

  if (typeof metadata.maxAgeMs === "number" && Number.isFinite(metadata.maxAgeMs)) {
    record.maxAgeMs = Math.max(0, Math.floor(metadata.maxAgeMs));
  } else if (typeof existing?.maxAgeMs === "number") {
    record.maxAgeMs = existing.maxAgeMs;
  }

  return record;
}

function resolveBindingsPath(accountId: string, env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return path.join(stateDir, "openclaw-weixin", `thread-bindings-${accountId}.json`);
}

function summarizeLifecycleForLog(
  record: WeixinThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): string {
  const idleTimeoutMs =
    typeof record.idleTimeoutMs === "number" ? record.idleTimeoutMs : defaults.idleTimeoutMs;
  const maxAgeMs = typeof record.maxAgeMs === "number" ? record.maxAgeMs : defaults.maxAgeMs;
  const idleLabel = formatThreadBindingDurationLabel(Math.max(0, Math.floor(idleTimeoutMs)));
  const maxAgeLabel = formatThreadBindingDurationLabel(Math.max(0, Math.floor(maxAgeMs)));
  return `idle=${idleLabel} maxAge=${maxAgeLabel}`;
}

function loadBindingsFromDisk(accountId: string): WeixinThreadBindingRecord[] {
  const filePath = resolveBindingsPath(accountId);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as StoredWeixinBindingState;
    if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.bindings)) {
      return [];
    }
    const bindings: WeixinThreadBindingRecord[] = [];
    for (const entry of parsed.bindings) {
      const conversationId = normalizeOptionalString(entry?.conversationId);
      const targetSessionKey = normalizeOptionalString(entry?.targetSessionKey) ?? "";
      const targetKind = entry?.targetKind === "subagent" ? "subagent" : "acp";
      if (!conversationId || !targetSessionKey) {
        continue;
      }
      const boundAt =
        typeof entry?.boundAt === "number" && Number.isFinite(entry.boundAt)
          ? Math.floor(entry.boundAt)
          : Date.now();
      const lastActivityAt =
        typeof entry?.lastActivityAt === "number" && Number.isFinite(entry.lastActivityAt)
          ? Math.floor(entry.lastActivityAt)
          : boundAt;
      const record: WeixinThreadBindingRecord = {
        accountId,
        conversationId,
        targetSessionKey,
        targetKind,
        boundAt,
        lastActivityAt,
      };
      if (typeof entry?.idleTimeoutMs === "number" && Number.isFinite(entry.idleTimeoutMs)) {
        record.idleTimeoutMs = Math.max(0, Math.floor(entry.idleTimeoutMs));
      }
      if (typeof entry?.maxAgeMs === "number" && Number.isFinite(entry.maxAgeMs)) {
        record.maxAgeMs = Math.max(0, Math.floor(entry.maxAgeMs));
      }
      if (typeof entry?.agentId === "string" && entry.agentId.trim()) {
        record.agentId = entry.agentId.trim();
      }
      if (typeof entry?.label === "string" && entry.label.trim()) {
        record.label = entry.label.trim();
      }
      if (typeof entry?.boundBy === "string" && entry.boundBy.trim()) {
        record.boundBy = entry.boundBy.trim();
      }
      if (entry?.metadata && typeof entry.metadata === "object") {
        record.metadata = { ...entry.metadata };
      }
      bindings.push(record);
    }
    return bindings;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      logVerbose(`weixin thread bindings load failed (${accountId}): ${String(err)}`);
    }
    return [];
  }
}

async function persistBindingsToDisk(params: {
  accountId: string;
  persist: boolean;
  bindings?: WeixinThreadBindingRecord[];
}): Promise<void> {
  if (!params.persist) {
    return;
  }
  const payload: StoredWeixinBindingState = {
    version: STORE_VERSION,
    bindings:
      params.bindings ??
      [...getThreadBindingsState().bindingsByAccountConversation.values()].filter(
        (entry) => entry.accountId === params.accountId,
      ),
  };
  await writeJsonFileAtomically(resolveBindingsPath(params.accountId), payload);
}

function listBindingsForAccount(accountId: string): WeixinThreadBindingRecord[] {
  return [...getThreadBindingsState().bindingsByAccountConversation.values()].filter(
    (entry) => entry.accountId === accountId,
  );
}

function enqueuePersistBindings(params: {
  accountId: string;
  persist: boolean;
  bindings?: WeixinThreadBindingRecord[];
}): Promise<void> {
  if (!params.persist) {
    return Promise.resolve();
  }
  const previous =
    getThreadBindingsState().persistQueueByAccountId.get(params.accountId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await persistBindingsToDisk(params);
    });
  getThreadBindingsState().persistQueueByAccountId.set(params.accountId, next);
  void next.finally(() => {
    if (getThreadBindingsState().persistQueueByAccountId.get(params.accountId) === next) {
      getThreadBindingsState().persistQueueByAccountId.delete(params.accountId);
    }
  });
  return next;
}

function persistBindingsSafely(params: {
  accountId: string;
  persist: boolean;
  bindings?: WeixinThreadBindingRecord[];
  reason: string;
}): void {
  void enqueuePersistBindings(params).catch((err) => {
    logVerbose(
      `weixin thread bindings persist failed (${params.accountId}, ${params.reason}): ${String(err)}`,
    );
  });
}

function normalizeTimestampMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return Date.now();
  }
  return Math.max(0, Math.floor(raw));
}

function shouldExpireByIdle(params: {
  now: number;
  record: WeixinThreadBindingRecord;
  defaultIdleTimeoutMs: number;
}): boolean {
  const idleTimeoutMs =
    typeof params.record.idleTimeoutMs === "number"
      ? Math.max(0, Math.floor(params.record.idleTimeoutMs))
      : params.defaultIdleTimeoutMs;
  if (idleTimeoutMs <= 0) {
    return false;
  }
  return params.now >= Math.max(params.record.lastActivityAt, params.record.boundAt) + idleTimeoutMs;
}

function shouldExpireByMaxAge(params: {
  now: number;
  record: WeixinThreadBindingRecord;
  defaultMaxAgeMs: number;
}): boolean {
  const maxAgeMs =
    typeof params.record.maxAgeMs === "number"
      ? Math.max(0, Math.floor(params.record.maxAgeMs))
      : params.defaultMaxAgeMs;
  if (maxAgeMs <= 0) {
    return false;
  }
  return params.now >= params.record.boundAt + maxAgeMs;
}

export function createWeixinThreadBindingManager(
  params: {
    accountId?: string;
    persist?: boolean;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
    enableSweeper?: boolean;
  } = {},
): WeixinThreadBindingManager {
  const accountId = normalizeAccountId(params.accountId);
  const existing = getThreadBindingsState().managersByAccountId.get(accountId);
  if (existing) {
    return existing;
  }

  const persist = params.persist ?? true;
  const idleTimeoutMs = normalizeDurationMs(
    params.idleTimeoutMs,
    DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  );
  const maxAgeMs = normalizeDurationMs(params.maxAgeMs, DEFAULT_THREAD_BINDING_MAX_AGE_MS);

  const loaded = loadBindingsFromDisk(accountId);
  for (const entry of loaded) {
    const key = resolveBindingKey({ accountId, conversationId: entry.conversationId });
    getThreadBindingsState().bindingsByAccountConversation.set(key, {
      ...entry,
      accountId,
    });
  }

  let sweepTimer: NodeJS.Timeout | null = null;

  const manager: WeixinThreadBindingManager = {
    accountId,
    shouldPersistMutations: () => persist,
    getIdleTimeoutMs: () => idleTimeoutMs,
    getMaxAgeMs: () => maxAgeMs,
    getByConversationId: (conversationIdRaw) => {
      const conversationId = normalizeOptionalString(conversationIdRaw);
      if (!conversationId) {
        return undefined;
      }
      return getThreadBindingsState().bindingsByAccountConversation.get(
        resolveBindingKey({ accountId, conversationId }),
      );
    },
    listBySessionKey: (targetSessionKeyRaw) => {
      const targetSessionKey = targetSessionKeyRaw.trim();
      if (!targetSessionKey) {
        return [];
      }
      return listBindingsForAccount(accountId).filter(
        (entry) => entry.targetSessionKey === targetSessionKey,
      );
    },
    listBindings: () => listBindingsForAccount(accountId),
    touchConversation: (conversationIdRaw, at) => {
      const conversationId = normalizeOptionalString(conversationIdRaw);
      if (!conversationId) {
        return null;
      }
      const key = resolveBindingKey({ accountId, conversationId });
      const existingEntry = getThreadBindingsState().bindingsByAccountConversation.get(key);
      if (!existingEntry) {
        return null;
      }
      const nextRecord: WeixinThreadBindingRecord = {
        ...existingEntry,
        lastActivityAt: normalizeTimestampMs(at ?? Date.now()),
      };
      getThreadBindingsState().bindingsByAccountConversation.set(key, nextRecord);
      persistBindingsSafely({
        accountId,
        persist: manager.shouldPersistMutations(),
        bindings: listBindingsForAccount(accountId),
        reason: "touch",
      });
      return nextRecord;
    },
    unbindConversation: (unbindParams) => {
      const conversationId = normalizeOptionalString(unbindParams.conversationId);
      if (!conversationId) {
        return null;
      }
      const key = resolveBindingKey({ accountId, conversationId });
      const removed = getThreadBindingsState().bindingsByAccountConversation.get(key) ?? null;
      if (!removed) {
        return null;
      }
      getThreadBindingsState().bindingsByAccountConversation.delete(key);
      persistBindingsSafely({
        accountId,
        persist: manager.shouldPersistMutations(),
        bindings: listBindingsForAccount(accountId),
        reason: "unbind-conversation",
      });
      return removed;
    },
    unbindBySessionKey: (unbindParams) => {
      const targetSessionKey = unbindParams.targetSessionKey.trim();
      if (!targetSessionKey) {
        return [];
      }
      const removed: WeixinThreadBindingRecord[] = [];
      for (const entry of listBindingsForAccount(accountId)) {
        if (entry.targetSessionKey !== targetSessionKey) {
          continue;
        }
        const key = resolveBindingKey({
          accountId,
          conversationId: entry.conversationId,
        });
        getThreadBindingsState().bindingsByAccountConversation.delete(key);
        removed.push(entry);
      }
      if (removed.length > 0) {
        persistBindingsSafely({
          accountId,
          persist: manager.shouldPersistMutations(),
          bindings: listBindingsForAccount(accountId),
          reason: "unbind-session",
        });
      }
      return removed;
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      unregisterSessionBindingAdapter({
        channel: WEIXIN_CHANNEL_ID,
        accountId,
        adapter: sessionBindingAdapter,
      });
      const existingManager = getThreadBindingsState().managersByAccountId.get(accountId);
      if (existingManager === manager) {
        getThreadBindingsState().managersByAccountId.delete(accountId);
      }
    },
  };

  // WeChat currently only supports 1:1 direct conversations (the channel code
  // always routes inbound traffic as direct chat; group_id is ignored). That
  // means we only expose the `current` placement — no `child` (forum topic /
  // group thread creation). If group support lands upstream this is the place
  // to add a `child` branch similar to Telegram's forum-topic handling.
  const sessionBindingAdapter: SessionBindingAdapter = {
    channel: WEIXIN_CHANNEL_ID,
    accountId,
    capabilities: {
      placements: ["current"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== WEIXIN_CHANNEL_ID) {
        return null;
      }
      const targetSessionKey = input.targetSessionKey.trim();
      if (!targetSessionKey) {
        return null;
      }
      if (input.placement === "child") {
        logVerbose(
          "weixin: child placement is not supported (no group/forum topic semantics); bind rejected.",
        );
        return null;
      }
      const conversationId = normalizeOptionalString(input.conversation.conversationId);
      if (!conversationId) {
        return null;
      }
      const record = fromSessionBindingInput({
        accountId,
        input: {
          targetSessionKey,
          targetKind: input.targetKind,
          conversationId,
          metadata: input.metadata,
        },
      });
      getThreadBindingsState().bindingsByAccountConversation.set(
        resolveBindingKey({ accountId, conversationId }),
        record,
      );
      await enqueuePersistBindings({
        accountId,
        persist: manager.shouldPersistMutations(),
        bindings: listBindingsForAccount(accountId),
      });
      logVerbose(
        `weixin: bound conversation ${conversationId} -> ${targetSessionKey} (${summarizeLifecycleForLog(
          record,
          { idleTimeoutMs, maxAgeMs },
        )})`,
      );
      return toSessionBindingRecord(record, { idleTimeoutMs, maxAgeMs });
    },
    listBySession: (targetSessionKeyRaw) => {
      const targetSessionKey = targetSessionKeyRaw.trim();
      if (!targetSessionKey) {
        return [];
      }
      return manager
        .listBySessionKey(targetSessionKey)
        .map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs }));
    },
    resolveByConversation: (ref) => {
      if (ref.channel !== WEIXIN_CHANNEL_ID) {
        return null;
      }
      const conversationId = normalizeOptionalString(ref.conversationId);
      if (!conversationId) {
        return null;
      }
      const record = manager.getByConversationId(conversationId);
      return record ? toSessionBindingRecord(record, { idleTimeoutMs, maxAgeMs }) : null;
    },
    touch: (bindingId, at) => {
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId,
      });
      if (!conversationId) {
        return;
      }
      manager.touchConversation(conversationId, at);
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        const removed = manager.unbindBySessionKey({
          targetSessionKey: input.targetSessionKey,
          reason: input.reason,
        });
        if (removed.length > 0) {
          await enqueuePersistBindings({
            accountId,
            persist: manager.shouldPersistMutations(),
            bindings: listBindingsForAccount(accountId),
          });
        }
        return removed.map((entry) =>
          toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs }),
        );
      }
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!conversationId) {
        return [];
      }
      const removed = manager.unbindConversation({
        conversationId,
        reason: input.reason,
      });
      if (removed) {
        await enqueuePersistBindings({
          accountId,
          persist: manager.shouldPersistMutations(),
          bindings: listBindingsForAccount(accountId),
        });
      }
      return removed ? [toSessionBindingRecord(removed, { idleTimeoutMs, maxAgeMs })] : [];
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);

  const sweeperEnabled = params.enableSweeper !== false;
  if (sweeperEnabled) {
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const record of listBindingsForAccount(accountId)) {
        const idleExpired = shouldExpireByIdle({
          now,
          record,
          defaultIdleTimeoutMs: idleTimeoutMs,
        });
        const maxAgeExpired = shouldExpireByMaxAge({
          now,
          record,
          defaultMaxAgeMs: maxAgeMs,
        });
        if (!idleExpired && !maxAgeExpired) {
          continue;
        }
        manager.unbindConversation({
          conversationId: record.conversationId,
          reason: idleExpired ? "idle-expired" : "max-age-expired",
        });
      }
    }, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  getThreadBindingsState().managersByAccountId.set(accountId, manager);
  return manager;
}

export function getWeixinThreadBindingManager(
  accountId?: string,
): WeixinThreadBindingManager | null {
  return getThreadBindingsState().managersByAccountId.get(normalizeAccountId(accountId)) ?? null;
}

/**
 * Register the shared WeChat thread binding adapter. Called from plugin
 * register(). Safe to call multiple times — subsequent calls return the
 * already-registered manager for the same accountId.
 */
export function registerWeixinThreadBindings(
  params: {
    accountId?: string;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
  } = {},
): WeixinThreadBindingManager {
  return createWeixinThreadBindingManager(params);
}

/**
 * Stop every active WeChat thread binding manager and unregister the shared
 * session binding adapter. Primarily used by tests; plugin shutdown paths
 * can also call it to release resources.
 */
export async function stopAllWeixinThreadBindings(): Promise<void> {
  for (const manager of [...getThreadBindingsState().managersByAccountId.values()]) {
    manager.stop();
  }
  // Always await the queue — Promise.allSettled([]) resolves synchronously,
  // so there's no reason to gate this on queue length (removing the branch
  // also keeps branch coverage clean).
  await Promise.allSettled([...getThreadBindingsState().persistQueueByAccountId.values()]);
  getThreadBindingsState().persistQueueByAccountId.clear();
  getThreadBindingsState().managersByAccountId.clear();
  getThreadBindingsState().bindingsByAccountConversation.clear();
}

export const __testing = {
  stopAllWeixinThreadBindings,
  resolveBindingsPath,
};
