import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  direct: vi.fn(),
  drain: vi.fn(),
  legacyDrain: vi.fn(),
  modernLookup: vi.fn(),
  legacyLookup: vi.fn(),
  modernDrainAvailable: true,
  legacyDrainAvailable: true,
  modernDrainError: undefined as Error | undefined,
  legacyDrainError: undefined as Error | undefined,
  sdkAvailable: true,
  sdkError: undefined as Error | undefined,
}));
vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({
  get sendDurableMessageBatch() {
    if (mocks.sdkError) throw mocks.sdkError;
    return mocks.sdkAvailable ? mocks.send : undefined;
  },
}));
vi.mock("openclaw/plugin-sdk/delivery-queue-runtime", () => ({
  get drainPendingDeliveries() {
    mocks.modernLookup();
    if (mocks.modernDrainError) throw mocks.modernDrainError;
    return mocks.modernDrainAvailable ? mocks.drain : undefined;
  },
}));
vi.mock("openclaw/plugin-sdk/infra-runtime", () => ({
  get drainPendingDeliveries() {
    mocks.legacyLookup();
    if (mocks.legacyDrainError) throw mocks.legacyDrainError;
    return mocks.legacyDrainAvailable ? mocks.legacyDrain : undefined;
  },
}));
vi.mock("./send.js", () => ({ sendMessageWeixin: mocks.direct }));
vi.mock("../util/logger.js", () => ({ logger: { debug: vi.fn() } }));
import { flushWeixinErrorNotices, sendWeixinErrorNotice } from "./error-notice.js";

const params = () => ({
  to: "test@im.wechat",
  contextToken: "context",
  message: "Request failed",
  baseUrl: "https://example.invalid",
  accountId: "test-account",
  runId: "test-run",
  config: {},
  errLog: vi.fn(),
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.sdkAvailable = true;
  mocks.modernDrainAvailable = true;
  mocks.legacyDrainAvailable = true;
  mocks.modernDrainError = undefined;
  mocks.legacyDrainError = undefined;
  mocks.sdkError = undefined;
});

describe("durable error notices", () => {
  it("uses required write-ahead custody with a stable bounded recovery intent", async () => {
    mocks.send.mockImplementation(async (p) => {
      p.onDeliveryIntent();
      return { status: "sent" };
    });
    expect(await sendWeixinErrorNotice(params())).toEqual({ status: "sent" });
    await sendWeixinErrorNotice(params());
    const [first, second] = mocks.send.mock.calls.map(([p]) => p);
    expect(first.deliveryIntentId).toBe(second.deliveryIntentId);
    expect(first).toMatchObject({
      durability: "required",
      maxRetries: 4,
      channel: "openclaw-weixin",
      accountId: "test-account",
    });
    expect(first).not.toHaveProperty("token");
    expect(first).not.toHaveProperty("contextToken");
    expect(mocks.direct).not.toHaveBeenCalled();
  });

  it("reports unresolved durable delivery without a second physical send", async () => {
    mocks.send.mockImplementation(async (p) => {
      p.onDeliveryIntent();
      return { status: "failed" };
    });
    expect(await sendWeixinErrorNotice(params())).toEqual({ status: "pending" });
    expect(mocks.direct).not.toHaveBeenCalled();
  });

  it("does not claim durability when queue creation fails", async () => {
    mocks.send.mockRejectedValue(new Error("queue unavailable"));
    expect(await sendWeixinErrorNotice(params())).toEqual({ status: "failed" });
    expect(mocks.direct).not.toHaveBeenCalled();
  });

  it("preserves policy suppression without direct bypass", async () => {
    mocks.send.mockResolvedValue({ status: "suppressed" });
    expect(await sendWeixinErrorNotice(params())).toEqual({ status: "suppressed" });
    expect(mocks.direct).not.toHaveBeenCalled();
  });

  it("does not emit a notice on channel cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await sendWeixinErrorNotice({ ...params(), abortSignal: controller.signal })).toEqual({
      status: "cancelled",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("drains only this account's error intents and retains core backoff", async () => {
    mocks.drain.mockResolvedValue(undefined);
    await flushWeixinErrorNotices(params());
    const p = mocks.drain.mock.calls[0][0];
    expect(
      p.selectEntry({
        id: "weixin-error-test",
        channel: "openclaw-weixin",
        accountId: "test-account",
      }),
    ).toEqual({ match: true });
    expect(
      p.selectEntry({ id: "normal", channel: "openclaw-weixin", accountId: "test-account" }),
    ).toEqual({ match: false });
    expect(
      p.selectEntry({
        id: "weixin-error-test",
        channel: "openclaw-weixin",
        accountId: "other-account",
      }),
    ).toEqual({ match: false });
    expect(
      p.selectEntry({ id: "weixin-error-test", channel: "telegram", accountId: "test-account" }),
    ).toEqual({ match: false });
  });

  it("coalesces overlapping poll drains and reports recovery errors", async () => {
    let finish!: () => void;
    mocks.drain.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const p = params();
    const first = flushWeixinErrorNotices(p);
    const second = flushWeixinErrorNotices(p);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(mocks.drain).toHaveBeenCalledTimes(1));
    finish();
    await first;
    mocks.drain.mockRejectedValue(new Error("offline"));
    await flushWeixinErrorNotices(p);
    expect(p.errLog).toHaveBeenCalledWith(expect.stringContaining("recovery failed"));
  });
});

describe("standalone compatibility sends", () => {
  it("preserves recipient, context, run and optional cancellation on direct calls", async () => {
    mocks.direct.mockResolvedValue({ messageId: "sent" });
    const p = { ...params(), config: undefined };
    expect(await sendWeixinErrorNotice(p)).toEqual({ status: "sent" });
    expect(mocks.direct).toHaveBeenCalledWith({
      to: p.to,
      text: p.message,
      opts: expect.objectContaining({
        contextToken: p.contextToken,
        runId: p.runId,
        accountId: p.accountId,
      }),
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("retains standalone send support without a context token", async () => {
    mocks.direct.mockResolvedValue({ messageId: "sent" });
    expect(
      await sendWeixinErrorNotice({ ...params(), config: undefined, contextToken: undefined }),
    ).toEqual({ status: "sent" });
    expect(mocks.direct).toHaveBeenCalledTimes(1);
  });
  it("reports direct failure without throwing or claiming a pending durable notice", async () => {
    mocks.direct.mockRejectedValue(new Error("send failed"));
    const p = { ...params(), config: undefined };
    expect(await sendWeixinErrorNotice(p)).toEqual({ status: "failed" });
    expect(p.errLog).toHaveBeenCalledWith(expect.stringContaining("error notice delivery failed"));
  });
});

describe("host capability and recovery boundaries", () => {
  it("uses the compatibility send when an older host lacks the durable export", async () => {
    mocks.sdkAvailable = false;
    vi.resetModules();
    const legacy = await import("./error-notice.js");
    mocks.direct.mockResolvedValue({ messageId: "sent" });
    expect(await legacy.sendWeixinErrorNotice(params())).toEqual({ status: "sent" });
    expect(mocks.direct).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("uses compatibility for an unavailable SDK path but never bypasses other loader errors", async () => {
    mocks.sdkError = Object.assign(new Error("old host"), {
      code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    });
    vi.resetModules();
    const legacy = await import("./error-notice.js");
    mocks.direct.mockResolvedValue({ messageId: "sent" });
    expect(await legacy.sendWeixinErrorNotice(params())).toEqual({ status: "sent" });
    expect(mocks.direct).toHaveBeenCalledTimes(1);
    mocks.direct.mockClear();
    mocks.sdkError = new Error("SDK initialization failed");
    vi.resetModules();
    const broken = await import("./error-notice.js");
    expect(await broken.sendWeixinErrorNotice(params())).toEqual({ status: "failed" });
    expect(mocks.direct).not.toHaveBeenCalled();
  });

  it("retains pending custody when transport throws after persistence", async () => {
    mocks.send.mockImplementation(async (p) => {
      p.onDeliveryIntent();
      throw new Error("transport unavailable");
    });
    expect(await sendWeixinErrorNotice(params())).toEqual({ status: "pending" });
    expect(mocks.direct).not.toHaveBeenCalled();
  });

  it("does not invent pending custody when the host declines to create an intent", async () => {
    mocks.send.mockResolvedValue({ status: "failed" });
    expect(await sendWeixinErrorNotice(params())).toEqual({ status: "failed" });
    expect(mocks.direct).not.toHaveBeenCalled();
  });

  it("stops recovery admission when the channel is cancelled", async () => {
    const controller = new AbortController();
    const p = { ...params(), abortSignal: controller.signal };
    mocks.drain.mockResolvedValue(undefined);
    await flushWeixinErrorNotices(p);
    const drain = mocks.drain.mock.calls[0][0];
    const entry = {
      id: "weixin-error-test",
      channel: "openclaw-weixin",
      accountId: "test-account",
    };
    expect(drain.shouldContinue()).toBe(true);
    expect(drain.selectEntry(entry)).toEqual({ match: true });
    controller.abort();
    expect(drain.shouldContinue()).toBe(false);
    expect(drain.selectEntry(entry)).toEqual({ match: false });
    await flushWeixinErrorNotices(p);
    expect(mocks.drain).toHaveBeenCalledTimes(1);
  });

  it("stops a legacy drain before its next delivery without shouldContinue support", async () => {
    const controller = new AbortController();
    const entries = ["first", "second"].map((id) => ({
      id: `weixin-error-${id}`,
      channel: "openclaw-weixin",
      accountId: "test-account",
    }));
    const delivered: string[] = [];
    mocks.drain.mockImplementation(async ({ selectEntry }) => {
      // The supported 2026.8.1 SDK selects its batch first, then rechecks each
      // entry at admission. It does not call shouldContinue.
      const batch = entries.filter((entry) => selectEntry(entry).match);
      for (const entry of batch) {
        if (!selectEntry(entry).match) continue;
        delivered.push(entry.id);
        controller.abort();
      }
    });
    await flushWeixinErrorNotices({ ...params(), abortSignal: controller.signal });
    expect(delivered).toEqual(["weixin-error-first"]);
  });
});

describe("recovery SDK path compatibility", () => {
  async function fresh() {
    vi.resetModules();
    return import("./error-notice.js");
  }

  it("prefers the modern recovery export without loading the removed legacy path", async () => {
    const subject = await fresh();
    mocks.drain.mockResolvedValue(undefined);
    await subject.flushWeixinErrorNotices(params());
    expect(mocks.drain).toHaveBeenCalledTimes(1);
    expect(mocks.legacyLookup).not.toHaveBeenCalled();
    expect(mocks.legacyDrain).not.toHaveBeenCalled();
  });

  it("falls back when an older host has no modern export", async () => {
    mocks.modernDrainAvailable = false;
    const subject = await fresh();
    mocks.legacyDrain.mockResolvedValue(undefined);
    await subject.flushWeixinErrorNotices(params());
    expect(mocks.legacyDrain).toHaveBeenCalledTimes(1);
    expect(mocks.drain).not.toHaveBeenCalled();
  });

  it.each(["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_MODULE_NOT_FOUND"])(
    "falls back when the modern SDK path is unavailable (%s)",
    async (code) => {
      mocks.modernDrainError = Object.assign(
        new Error(
          code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
            ? "Package subpath './plugin-sdk/delivery-queue-runtime' is not defined by exports"
            : "Cannot find module 'openclaw/plugin-sdk/delivery-queue-runtime' imported from /plugin/error-notice.js",
        ),
        { code },
      );
      const subject = await fresh();
      mocks.legacyDrain.mockResolvedValue(undefined);
      await subject.flushWeixinErrorNotices(params());
      expect(mocks.legacyDrain).toHaveBeenCalledTimes(1);
    },
  );

  it("recognizes a missing exported target file without hiding unrelated dependencies", async () => {
    mocks.modernDrainError = Object.assign(
      new Error("Cannot find module '/host/openclaw/dist/plugin-sdk/delivery-queue-runtime.js'"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    const subject = await fresh();
    mocks.legacyDrain.mockResolvedValue(undefined);
    await subject.flushWeixinErrorNotices(params());
    expect(mocks.legacyDrain).toHaveBeenCalledTimes(1);
  });

  it("caches absent capabilities without logging an error on every poll", async () => {
    mocks.modernDrainAvailable = false;
    mocks.legacyDrainAvailable = false;
    const subject = await fresh();
    const p = params();
    await subject.flushWeixinErrorNotices(p);
    await subject.flushWeixinErrorNotices(p);
    expect(mocks.modernLookup).toHaveBeenCalledTimes(1);
    expect(mocks.legacyLookup).toHaveBeenCalledTimes(1);
    expect(p.errLog).not.toHaveBeenCalled();
  });

  it("caches both unavailable paths without per-poll loader failures", async () => {
    mocks.modernDrainError = Object.assign(
      new Error("Package subpath './plugin-sdk/delivery-queue-runtime' is not exported"),
      { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
    );
    mocks.legacyDrainError = Object.assign(
      new Error("Package subpath './plugin-sdk/infra-runtime' is not exported"),
      { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
    );
    const subject = await fresh();
    const p = params();
    await subject.flushWeixinErrorNotices(p);
    await subject.flushWeixinErrorNotices(p);
    expect(mocks.modernLookup).toHaveBeenCalledTimes(1);
    expect(mocks.legacyLookup).toHaveBeenCalledTimes(1);
    expect(p.errLog).not.toHaveBeenCalled();
  });

  it.each([
    new Error("SDK initialization failed"),
    Object.assign(new Error("Cannot find package 'broken-transitive-dependency'"), {
      code: "ERR_MODULE_NOT_FOUND",
    }),
    Object.assign(
      new Error(
        "Cannot find package 'broken-transitive-dependency' imported from /node_modules/openclaw/dist/plugin-sdk/delivery-queue-runtime.js",
      ),
      { code: "ERR_MODULE_NOT_FOUND" },
    ),
    Object.assign(
      new Error(
        "Cannot find module '/node_modules/openclaw/dist/missing-internal.js' imported from /node_modules/openclaw/dist/plugin-sdk/delivery-queue-runtime.js",
      ),
      { code: "ERR_MODULE_NOT_FOUND" },
    ),
    Object.assign(
      new Error(
        "Package subpath './private' is not defined by exports in /node_modules/dependency/package.json imported from /node_modules/openclaw/dist/plugin-sdk/delivery-queue-runtime.js",
      ),
      { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
    ),
  ])("reports a broken SDK load without silently using the legacy path", async (error) => {
    mocks.modernDrainError = error;
    const subject = await fresh();
    const p = params();
    await subject.flushWeixinErrorNotices(p);
    expect(p.errLog).toHaveBeenCalledWith(expect.stringContaining(error.message));
    expect(mocks.legacyLookup).not.toHaveBeenCalled();
    mocks.modernDrainError = undefined;
    mocks.drain.mockResolvedValue(undefined);
    await subject.flushWeixinErrorNotices(p);
    expect(mocks.drain).toHaveBeenCalledTimes(1);
  });
});
