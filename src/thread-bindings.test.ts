import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Prevent the sweeper from firing during tests and avoid touching the real
// conversation-runtime state shared with a running gateway. vi.hoisted is
// required because vi.mock factories are hoisted above top-level locals.
const { registerSessionBindingAdapterMock, unregisterSessionBindingAdapterMock } = vi.hoisted(
  () => ({
    registerSessionBindingAdapterMock: vi.fn(),
    unregisterSessionBindingAdapterMock: vi.fn(),
  }),
);

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  registerSessionBindingAdapter: registerSessionBindingAdapterMock,
  unregisterSessionBindingAdapter: unregisterSessionBindingAdapterMock,
  resolveThreadBindingConversationIdFromBindingId: vi.fn(
    ({ accountId, bindingId }: { accountId: string; bindingId: string }) => {
      const prefix = `${accountId}:`;
      return bindingId.startsWith(prefix) ? bindingId.slice(prefix.length) : null;
    },
  ),
  resolveThreadBindingEffectiveExpiresAt: vi.fn(() => 0),
  formatThreadBindingDurationLabel: vi.fn((ms: number) => `${ms}ms`),
}));

vi.mock("openclaw/plugin-sdk/json-store", () => ({
  writeJsonFileAtomically: vi.fn(async (filePath: string, data: unknown) => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }),
}));

vi.mock("openclaw/plugin-sdk/routing", () => ({
  normalizeAccountId: (raw?: string | null) => (raw ?? "").trim() || "default",
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  logVerbose: vi.fn(),
}));

const { stateDirRef } = vi.hoisted(() => ({ stateDirRef: { current: "" } }));

vi.mock("openclaw/plugin-sdk/state-paths", () => ({
  resolveStateDir: (_env: NodeJS.ProcessEnv, _homedir: typeof os.homedir) => stateDirRef.current,
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  normalizeOptionalString: (raw: unknown) => {
    if (typeof raw !== "string") {
      return undefined;
    }
    const trimmed = raw.trim();
    return trimmed ? trimmed : undefined;
  },
}));

import {
  __testing,
  createWeixinThreadBindingManager,
  getWeixinThreadBindingManager,
  registerWeixinThreadBindings,
} from "./thread-bindings.js";

/**
 * Pull the SessionBindingAdapter that was registered with the mocked
 * registerSessionBindingAdapter. Lets tests exercise bind/resolve/touch/unbind
 * through the same entry point the ACP runtime uses.
 */
// biome-ignore lint/suspicious/noExplicitAny: test seam
function lastRegisteredAdapter(): any {
  const calls = registerSessionBindingAdapterMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]?.[0];
}

const CHANNEL = "openclaw-weixin";

describe("weixin thread bindings", () => {
  beforeEach(async () => {
    stateDirRef.current = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "openclaw-weixin-bindings-"),
    );
    await __testing.stopAllWeixinThreadBindings();
    registerSessionBindingAdapterMock.mockClear();
    unregisterSessionBindingAdapterMock.mockClear();
  });

  afterEach(async () => {
    await __testing.stopAllWeixinThreadBindings();
    if (stateDirRef.current) {
      await fs.promises.rm(stateDirRef.current, { recursive: true, force: true });
      stateDirRef.current = "";
    }
  });

  it("dedupes manager instances per accountId", () => {
    const a = createWeixinThreadBindingManager({
      accountId: "acc1",
      enableSweeper: false,
      persist: false,
    });
    const b = createWeixinThreadBindingManager({
      accountId: "acc1",
      enableSweeper: false,
      persist: false,
    });
    expect(a).toBe(b);
    expect(getWeixinThreadBindingManager("acc1")).toBe(a);
    expect(registerSessionBindingAdapterMock).toHaveBeenCalledTimes(1);
  });

  it("isolates bindings across accounts", () => {
    const mgrA = createWeixinThreadBindingManager({
      accountId: "accA",
      enableSweeper: false,
      persist: false,
    });
    const mgrB = createWeixinThreadBindingManager({
      accountId: "accB",
      enableSweeper: false,
      persist: false,
    });
    expect(mgrA).not.toBe(mgrB);
    expect(mgrA.listBindings()).toEqual([]);
    expect(mgrB.listBindings()).toEqual([]);
    expect(registerSessionBindingAdapterMock).toHaveBeenCalledTimes(2);
  });

  it("resolves the bindings store path under the state dir", () => {
    const bindingsPath = __testing.resolveBindingsPath("accX");
    expect(bindingsPath).toBe(
      path.join(stateDirRef.current, "openclaw-weixin", "thread-bindings-accX.json"),
    );
  });

  it("returns null when touchConversation is called on an unknown id", () => {
    const mgr = createWeixinThreadBindingManager({
      accountId: "accTouch",
      enableSweeper: false,
      persist: false,
    });
    expect(mgr.touchConversation("not-bound@im.wechat")).toBeNull();
  });

  it("binds a current-placement ACP conversation and makes it resolvable", async () => {
    const mgr = createWeixinThreadBindingManager({
      accountId: "accBind",
      enableSweeper: false,
      persist: false,
    });
    const adapter = lastRegisteredAdapter();

    const result = await adapter.bind({
      targetSessionKey: "agent:claude:acp:test-session",
      targetKind: "session",
      placement: "current",
      conversation: {
        channel: CHANNEL,
        accountId: "accBind",
        conversationId: "user-1@im.wechat",
      },
      metadata: { label: "Test bind", agentId: "main" },
    });

    expect(result).not.toBeNull();
    expect(result.targetSessionKey).toBe("agent:claude:acp:test-session");
    expect(result.conversation).toEqual({
      channel: CHANNEL,
      accountId: "accBind",
      conversationId: "user-1@im.wechat",
    });

    expect(mgr.listBindings()).toHaveLength(1);
    expect(mgr.getByConversationId("user-1@im.wechat")?.targetSessionKey).toBe(
      "agent:claude:acp:test-session",
    );

    const lookup = adapter.resolveByConversation({
      channel: CHANNEL,
      accountId: "accBind",
      conversationId: "user-1@im.wechat",
    });
    expect(lookup?.targetSessionKey).toBe("agent:claude:acp:test-session");
  });

  it("rejects child placement (no group/forum topic support)", async () => {
    createWeixinThreadBindingManager({
      accountId: "accChild",
      enableSweeper: false,
      persist: false,
    });
    const adapter = lastRegisteredAdapter();

    const result = await adapter.bind({
      targetSessionKey: "agent:claude:acp:x",
      targetKind: "session",
      placement: "child",
      conversation: {
        channel: CHANNEL,
        accountId: "accChild",
        conversationId: "user-1@im.wechat",
      },
    });

    expect(result).toBeNull();
  });

  it("rejects bind from a foreign channel", async () => {
    createWeixinThreadBindingManager({
      accountId: "accChan",
      enableSweeper: false,
      persist: false,
    });
    const adapter = lastRegisteredAdapter();

    const result = await adapter.bind({
      targetSessionKey: "agent:claude:acp:x",
      targetKind: "session",
      placement: "current",
      conversation: {
        channel: "telegram",
        accountId: "accChan",
        conversationId: "user-1@im.wechat",
      },
    });

    expect(result).toBeNull();
  });

  it("rejects bind when targetSessionKey is blank", async () => {
    createWeixinThreadBindingManager({
      accountId: "accBlank",
      enableSweeper: false,
      persist: false,
    });
    const adapter = lastRegisteredAdapter();

    const result = await adapter.bind({
      targetSessionKey: "   ",
      targetKind: "session",
      placement: "current",
      conversation: {
        channel: CHANNEL,
        accountId: "accBlank",
        conversationId: "user-1@im.wechat",
      },
    });

    expect(result).toBeNull();
  });

  it("touchConversation bumps lastActivityAt", async () => {
    const mgr = createWeixinThreadBindingManager({
      accountId: "accTouch2",
      enableSweeper: false,
      persist: false,
    });
    const adapter = lastRegisteredAdapter();

    await adapter.bind({
      targetSessionKey: "agent:claude:acp:tt",
      targetKind: "session",
      placement: "current",
      conversation: {
        channel: CHANNEL,
        accountId: "accTouch2",
        conversationId: "user-touch@im.wechat",
      },
    });

    const beforeTouch = mgr.getByConversationId("user-touch@im.wechat");
    expect(beforeTouch).toBeDefined();
    const touchedAt = (beforeTouch?.lastActivityAt ?? 0) + 10_000;
    const touched = mgr.touchConversation("user-touch@im.wechat", touchedAt);
    expect(touched?.lastActivityAt).toBe(touchedAt);
  });

  it("unbinds by bindingId", async () => {
    const mgr = createWeixinThreadBindingManager({
      accountId: "accUnbind",
      enableSweeper: false,
      persist: false,
    });
    const adapter = lastRegisteredAdapter();

    await adapter.bind({
      targetSessionKey: "agent:claude:acp:u1",
      targetKind: "session",
      placement: "current",
      conversation: {
        channel: CHANNEL,
        accountId: "accUnbind",
        conversationId: "user-unbind@im.wechat",
      },
    });
    expect(mgr.listBindings()).toHaveLength(1);

    const removed = await adapter.unbind({
      bindingId: "accUnbind:user-unbind@im.wechat",
    });
    expect(removed).toHaveLength(1);
    expect(mgr.listBindings()).toHaveLength(0);
  });

  it("unbinds all bindings sharing a targetSessionKey", async () => {
    const mgr = createWeixinThreadBindingManager({
      accountId: "accUnbindKey",
      enableSweeper: false,
      persist: false,
    });
    const adapter = lastRegisteredAdapter();

    for (const conv of ["a@im.wechat", "b@im.wechat"]) {
      await adapter.bind({
        targetSessionKey: "agent:claude:acp:shared",
        targetKind: "session",
        placement: "current",
        conversation: { channel: CHANNEL, accountId: "accUnbindKey", conversationId: conv },
      });
    }
    expect(mgr.listBindings()).toHaveLength(2);

    const removed = await adapter.unbind({
      targetSessionKey: "agent:claude:acp:shared",
    });
    expect(removed).toHaveLength(2);
    expect(mgr.listBindings()).toHaveLength(0);
  });

  it("listBySession returns only bindings with matching targetSessionKey", async () => {
    const mgr = createWeixinThreadBindingManager({
      accountId: "accListBySession",
      enableSweeper: false,
      persist: false,
    });
    const adapter = lastRegisteredAdapter();

    await adapter.bind({
      targetSessionKey: "agent:claude:acp:first",
      targetKind: "session",
      placement: "current",
      conversation: {
        channel: CHANNEL,
        accountId: "accListBySession",
        conversationId: "u-a@im.wechat",
      },
    });
    await adapter.bind({
      targetSessionKey: "agent:claude:acp:second",
      targetKind: "session",
      placement: "current",
      conversation: {
        channel: CHANNEL,
        accountId: "accListBySession",
        conversationId: "u-b@im.wechat",
      },
    });

    const first = adapter.listBySession("agent:claude:acp:first");
    expect(first).toHaveLength(1);
    expect(first[0].conversation.conversationId).toBe("u-a@im.wechat");

    const missing = adapter.listBySession("agent:claude:acp:nope");
    expect(missing).toEqual([]);

    expect(mgr.listBindings()).toHaveLength(2);
  });

  it("persists bindings to disk when persist=true and reloads them on restart", async () => {
    const mgrA = createWeixinThreadBindingManager({
      accountId: "accPersist",
      enableSweeper: false,
      persist: true,
    });
    const adapterA = lastRegisteredAdapter();

    await adapterA.bind({
      targetSessionKey: "agent:claude:acp:persist",
      targetKind: "session",
      placement: "current",
      conversation: {
        channel: CHANNEL,
        accountId: "accPersist",
        conversationId: "user-p@im.wechat",
      },
    });
    // Allow the fire-and-forget persist enqueue to drain.
    await new Promise((resolve) => setImmediate(resolve));

    const bindingsFile = __testing.resolveBindingsPath("accPersist");
    const rawAfterBind = await fs.promises.readFile(bindingsFile, "utf-8");
    expect(rawAfterBind).toContain("user-p@im.wechat");

    // Drop the in-memory state and recreate; the manager must rehydrate
    // from the persisted file.
    await __testing.stopAllWeixinThreadBindings();
    registerSessionBindingAdapterMock.mockClear();

    const mgrB = createWeixinThreadBindingManager({
      accountId: "accPersist",
      enableSweeper: false,
      persist: true,
    });
    expect(mgrB).not.toBe(mgrA);
    const reloaded = mgrB.getByConversationId("user-p@im.wechat");
    expect(reloaded?.targetSessionKey).toBe("agent:claude:acp:persist");
  });

  it("registerWeixinThreadBindings is a thin wrapper over createWeixinThreadBindingManager", () => {
    const mgr = registerWeixinThreadBindings({
      accountId: "accRegister",
      idleTimeoutMs: 5_000,
    });
    expect(getWeixinThreadBindingManager("accRegister")).toBe(mgr);
    expect(mgr.getIdleTimeoutMs()).toBe(5_000);
  });

  it("stops the manager and clears registry on stopAllWeixinThreadBindings", async () => {
    createWeixinThreadBindingManager({
      accountId: "accStop",
      enableSweeper: false,
      persist: false,
    });
    expect(getWeixinThreadBindingManager("accStop")).not.toBeNull();
    await __testing.stopAllWeixinThreadBindings();
    expect(getWeixinThreadBindingManager("accStop")).toBeNull();
    expect(unregisterSessionBindingAdapterMock).toHaveBeenCalled();
  });

  it("merges metadata into an existing binding when rebinding the same conversationId", async () => {
    const mgr = createWeixinThreadBindingManager({
      accountId: "accRebind",
      enableSweeper: false,
      persist: false,
    });
    const adapter = lastRegisteredAdapter();

    await adapter.bind({
      targetSessionKey: "agent:claude:acp:v1",
      targetKind: "session",
      placement: "current",
      conversation: { channel: CHANNEL, accountId: "accRebind", conversationId: "u@im.wechat" },
      metadata: { agentId: "main", label: "first", boundBy: "user" },
    });
    const first = mgr.getByConversationId("u@im.wechat");
    expect(first?.agentId).toBe("main");
    expect(first?.label).toBe("first");

    // Rebind without agentId — should preserve existing one via the merge path.
    await adapter.bind({
      targetSessionKey: "agent:claude:acp:v2",
      targetKind: "session",
      placement: "current",
      conversation: { channel: CHANNEL, accountId: "accRebind", conversationId: "u@im.wechat" },
      metadata: { label: "second" },
    });
    const second = mgr.getByConversationId("u@im.wechat");
    expect(second?.targetSessionKey).toBe("agent:claude:acp:v2");
    expect(second?.agentId).toBe("main"); // carried over from the first bind
    expect(second?.label).toBe("second"); // overwritten by the second bind
  });

  it("reads idleTimeoutMs and maxAgeMs overrides from metadata", async () => {
    const mgr = createWeixinThreadBindingManager({
      accountId: "accTimeouts",
      enableSweeper: false,
      persist: false,
    });
    const adapter = lastRegisteredAdapter();

    await adapter.bind({
      targetSessionKey: "agent:claude:acp:t",
      targetKind: "session",
      placement: "current",
      conversation: { channel: CHANNEL, accountId: "accTimeouts", conversationId: "ttl@im.wechat" },
      metadata: { idleTimeoutMs: 2_000, maxAgeMs: 10_000 },
    });
    const record = mgr.getByConversationId("ttl@im.wechat");
    expect(record?.idleTimeoutMs).toBe(2_000);
    expect(record?.maxAgeMs).toBe(10_000);
  });

  it("returns null when resolveByConversation is called with a foreign channel or empty id", () => {
    createWeixinThreadBindingManager({
      accountId: "accResolve",
      enableSweeper: false,
      persist: false,
    });
    const adapter = lastRegisteredAdapter();

    expect(
      adapter.resolveByConversation({
        channel: "telegram",
        accountId: "accResolve",
        conversationId: "x@im.wechat",
      }),
    ).toBeNull();
    expect(
      adapter.resolveByConversation({
        channel: CHANNEL,
        accountId: "accResolve",
        conversationId: "",
      }),
    ).toBeNull();
  });

  it("handles loadBindingsFromDisk for missing file (ENOENT) gracefully", () => {
    // Point at an accountId whose store file has never been written.
    const mgr = createWeixinThreadBindingManager({
      accountId: "accMissing",
      enableSweeper: false,
      persist: true,
    });
    expect(mgr.listBindings()).toEqual([]);
  });

  it("ignores on-disk bindings with wrong store version", async () => {
    // Hand-write a bogus store file, then spin up a manager and expect it
    // to reject the entire file (version mismatch) rather than crash.
    const storePath = __testing.resolveBindingsPath("accVersion");
    await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
    await fs.promises.writeFile(
      storePath,
      JSON.stringify({
        version: 999,
        bindings: [
          {
            conversationId: "u@im.wechat",
            targetSessionKey: "agent:claude:acp:x",
            boundAt: Date.now(),
            lastActivityAt: Date.now(),
          },
        ],
      }),
      "utf-8",
    );

    const mgr = createWeixinThreadBindingManager({
      accountId: "accVersion",
      enableSweeper: false,
      persist: true,
    });
    expect(mgr.listBindings()).toEqual([]);
  });

  it("ignores on-disk bindings with missing conversationId or targetSessionKey", async () => {
    const storePath = __testing.resolveBindingsPath("accBadEntries");
    await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
    await fs.promises.writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        bindings: [
          { targetSessionKey: "agent:claude:acp:x", boundAt: 1, lastActivityAt: 1 }, // no conversationId
          { conversationId: "u@im.wechat", boundAt: 1, lastActivityAt: 1 }, // no targetSessionKey
          {
            conversationId: "good@im.wechat",
            targetSessionKey: "agent:claude:acp:ok",
            boundAt: 1,
            lastActivityAt: 1,
            idleTimeoutMs: 500,
            maxAgeMs: 1_000,
            agentId: "main",
            label: "ok",
            boundBy: "user",
            metadata: { hint: "survive" },
          },
        ],
      }),
      "utf-8",
    );

    const mgr = createWeixinThreadBindingManager({
      accountId: "accBadEntries",
      enableSweeper: false,
      persist: true,
    });
    const bindings = mgr.listBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.conversationId).toBe("good@im.wechat");
    expect(bindings[0]?.idleTimeoutMs).toBe(500);
    expect(bindings[0]?.agentId).toBe("main");
  });

  it("sweeper removes idle-expired bindings", async () => {
    vi.useFakeTimers();
    try {
      const mgr = createWeixinThreadBindingManager({
        accountId: "accSweep",
        enableSweeper: true,
        persist: false,
        idleTimeoutMs: 100,
      });
      const adapter = lastRegisteredAdapter();

      await adapter.bind({
        targetSessionKey: "agent:claude:acp:sweep",
        targetKind: "session",
        placement: "current",
        conversation: { channel: CHANNEL, accountId: "accSweep", conversationId: "sw@im.wechat" },
      });
      expect(mgr.listBindings()).toHaveLength(1);

      // Advance wall clock past idleTimeoutMs, then tick the sweeper interval.
      vi.advanceTimersByTime(61_000);
      expect(mgr.listBindings()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes bogus durations to the fallback", () => {
    const mgr = createWeixinThreadBindingManager({
      accountId: "accNorm",
      enableSweeper: false,
      persist: false,
      // Intentionally non-numeric to hit the normalizeDurationMs fallback.
      idleTimeoutMs: Number.NaN,
      maxAgeMs: -5,
    });
    expect(mgr.getIdleTimeoutMs()).toBe(24 * 60 * 60 * 1000);
    expect(mgr.getMaxAgeMs()).toBe(0);
  });

  it("unbind returns [] when the bindingId cannot be resolved", async () => {
    createWeixinThreadBindingManager({
      accountId: "accBadBinding",
      enableSweeper: false,
      persist: false,
    });
    const adapter = lastRegisteredAdapter();
    const result = await adapter.unbind({ bindingId: "garbage" });
    expect(result).toEqual([]);
  });

  it("touch is a no-op when the bindingId cannot be resolved", () => {
    const mgr = createWeixinThreadBindingManager({
      accountId: "accTouchBad",
      enableSweeper: false,
      persist: false,
    });
    const adapter = lastRegisteredAdapter();
    adapter.touch("garbage");
    expect(mgr.listBindings()).toEqual([]);
  });

  it("adapter listBySession returns [] for a blank targetSessionKey", () => {
    createWeixinThreadBindingManager({
      accountId: "accListBlank",
      enableSweeper: false,
      persist: false,
    });
    const adapter = lastRegisteredAdapter();
    expect(adapter.listBySession("   ")).toEqual([]);
  });

  it("sweeper leaves non-expired bindings alone between ticks", async () => {
    vi.useFakeTimers();
    try {
      const mgr = createWeixinThreadBindingManager({
        accountId: "accSweepKeep",
        enableSweeper: true,
        persist: false,
        // Very long idle timeout so a single sweep tick never expires.
        idleTimeoutMs: 60 * 60 * 1000,
      });
      const adapter = lastRegisteredAdapter();

      await adapter.bind({
        targetSessionKey: "agent:claude:acp:keep",
        targetKind: "session",
        placement: "current",
        conversation: {
          channel: CHANNEL,
          accountId: "accSweepKeep",
          conversationId: "keep@im.wechat",
        },
      });

      vi.advanceTimersByTime(61_000); // one sweep interval tick
      expect(mgr.listBindings()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

});
