import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WeixinMessage } from "../api/types.js";
import { monitorWeixinProvider } from "../monitor/monitor.js";
import { getSyncBufFilePath } from "../storage/sync-buf.js";
import { mergeInboundMessages } from "../monitor/inbound-batcher.js";
import { resolveStoredQuoteContext, weixinMessageToMsgContext } from "./inbound.js";
import { processOneMessage } from "./process-message.js";
import { closeQuoteStore, initializeQuoteStore } from "./quote-store.js";

vi.mock("../util/logger.js", () => {
  const log = { info() {}, debug() {}, warn() {}, error() {} };
  return { logger: { ...log, withAccount: () => log } };
});
vi.mock("./typing.js", () => ({ loadTypingCallbacksFactory: async () => () => ({}) }));

const key = Buffer.alloc(16, 7);
const image = (id: string): WeixinMessage => ({
  from_user_id: "owner",
  message_id: id,
  create_time_ms: Date.now(),
  item_list: [{ type: 2, image_item: { media: { full_url: `https://offline.invalid/${id}` } } }],
});
const file = (): WeixinMessage => ({
  ...image("file"),
  item_list: [
    {
      type: 4,
      file_item: {
        file_name: "report.pdf",
        media: {
          full_url: "https://offline.invalid/file",
          aes_key: key.toString("base64"),
        },
      },
    },
  ],
});
const video = (): WeixinMessage => ({
  ...image("video"),
  item_list: [
    {
      type: 5,
      video_item: {
        media: {
          full_url: "https://offline.invalid/video",
          aes_key: key.toString("base64"),
        },
      },
    },
  ],
});

let root: string;
let fetchOrder: string[];
let duringFetch: (id: string) => void;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-inbound-media-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  fetchOrder = [];
  duringFetch = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(url).toMatch(/^https:\/\/offline\.invalid\//);
      const id = url.split("/").at(-1)!;
      fetchOrder.push(id);
      duringFetch(id);
      let bytes = Buffer.from(id);
      if (id === "file" || id === "video") {
        const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
        bytes = Buffer.concat([cipher.update(bytes), cipher.final()]);
      }
      return new Response(bytes);
    }),
  );
});
afterEach(() => {
  closeQuoteStore();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(quoteCache = {}) {
  const config = { channels: { "openclaw-weixin": { replyProgressMessages: false, quoteCache } } };
  const store = (await initializeQuoteStore(config, "account"))!;
  const controller = new AbortController();
  let context: any;
  let onDispatch = async (_ctx: any) => {};
  const runtime = {
    commands: { shouldComputeCommandAuthorized: () => false },
    media: {
      saveMediaBuffer: (buf: Buffer, type: string, _subdir: string, max: number, name: string) =>
        store.saveMediaBuffer("account", buf, type, max, name),
    },
    routing: {
      resolveAgentRoute: () => ({ agentId: "test", sessionKey: "test", mainSessionKey: "test" }),
    },
    session: {
      resolveStorePath: () => path.join(root, "sessions"),
      recordInboundSession: async () => {},
    },
    reply: {
      finalizeInboundContext: (ctx: any) => ctx,
      resolveHumanDelayConfig: () => ({}),
      createReplyDispatcherWithTyping: () => ({
        dispatcher: {},
        replyOptions: {},
        markDispatchIdle() {},
      }),
      withReplyDispatcher: ({ run }: any) => run(),
      dispatchReplyFromConfig: async ({ ctx }: any) => {
        context = ctx;
        await onDispatch(ctx);
      },
    },
  };
  return {
    config,
    runtime,
    store,
    controller,
    context: () => context,
    dispatch: (fn: typeof onDispatch) => {
      onDispatch = fn;
    },
    process: (msg: WeixinMessage) =>
      processOneMessage(msg, {
        accountId: "account",
        config,
        channelRuntime: runtime as any,
        baseUrl: "https://offline.invalid",
        cdnBaseUrl: "https://offline.invalid",
        abortSignal: controller.signal,
        log() {},
        errLog() {},
      }),
  };
}

const paths = (ctx: any): string[] => ctx.MediaPaths ?? (ctx.MediaPath ? [ctx.MediaPath] : []);

describe("ordered inbound attachment lifetime and quote association", () => {
  it("downloads mixed attachments and gives them to the agent in original message order", async () => {
    const f = await fixture();
    await f.process(mergeInboundMessages([file(), image("picture"), video()]));
    expect(fetchOrder).toEqual(["file", "picture", "video"]);
    expect(paths(f.context()).map((p) => fs.readFileSync(p, "utf8"))).toEqual([
      "file",
      "picture",
      "video",
    ]);
    expect(f.context().media[0].fileName).toBe("report.pdf");
  });

  it("caches each original message separately so every batched attachment can be quoted", async () => {
    const f = await fixture();
    await f.process(mergeInboundMessages([image("first"), image("second")]));
    for (const id of ["first", "second"]) {
      const record = f.store.find("account", "owner", id);
      expect(record?.mediaPath).toEqual(expect.any(String));
      const quote: WeixinMessage = {
        from_user_id: "owner",
        item_list: [{ type: 1, text_item: { text: "explain" }, ref_msg: { svr_id: id } }],
      };
      const ctx = weixinMessageToMsgContext(quote, "account");
      resolveStoredQuoteContext(ctx, quote, "account", f.store);
      expect(ctx.MediaPaths?.map((p) => fs.readFileSync(p, "utf8"))).toEqual([id]);
    }
  });

  it("retains all attachments belonging to one message for later ID-only quotes", async () => {
    const f = await fixture();
    const msg = image("original");
    msg.item_list!.push(...image("extra").item_list!);
    await f.process(msg);
    const quote: WeixinMessage = {
      from_user_id: "owner",
      item_list: [{ type: 1, text_item: { text: "both" }, ref_msg: { svr_id: "original" } }],
    };
    const ctx = weixinMessageToMsgContext(quote, "account");
    resolveStoredQuoteContext(ctx, quote, "account", f.store);
    expect(ctx.MediaPaths?.map((p) => fs.readFileSync(p, "utf8"))).toEqual(["original", "extra"]);
    f.store.runGc();
    expect(paths(ctx).every((p) => fs.existsSync(p))).toBe(true);
  });

  it("keeps a batched text message separate from the image's original quote record", async () => {
    const f = await fixture();
    await f.process(
      mergeInboundMessages([
        image("picture"),
        {
          from_user_id: "owner",
          message_id: "question",
          create_time_ms: Date.now(),
          item_list: [{ type: 1, text_item: { text: "describe this picture" } }],
        },
      ]),
    );
    expect(f.store.find("account", "owner", "picture")).toMatchObject({
      body: "[图片]",
      mediaPath: expect.any(String),
    });
    expect(f.store.find("account", "owner", "question")).toMatchObject({
      body: "describe this picture",
    });
    expect(f.store.find("account", "owner", "question")?.mediaPath).toBeUndefined();
  });

  it("keeps earlier downloads alive while a later attachment is being downloaded", async () => {
    const f = await fixture();
    duringFetch = (id) => {
      if (id === "second") f.store.runGc();
    };
    await f.process(mergeInboundMessages([image("first"), image("second")]));
    expect(paths(f.context()).map((p) => fs.existsSync(p))).toEqual([true, true]);
  });

  it("survives the hundredth-write GC before agent dispatch", async () => {
    const f = await fixture();
    for (let i = 0; i < 99; i++)
      await f.store.put({
        accountId: "account",
        conversationId: "owner",
        messageId: `old-${i}`,
        direction: "inbound",
        body: "old",
        createdAt: Date.now(),
      });
    f.dispatch(async (ctx) => {
      expect(paths(ctx).map((p) => fs.existsSync(p))).toEqual([true, true]);
    });
    await f.process(mergeInboundMessages([image("first"), image("second")]));
  });

  it("protects files from byte-budget eviction until the agent has finished", async () => {
    const f = await fixture({ maxMediaBytesPerAccount: 1 });
    f.dispatch(async (ctx) => {
      f.store.runGc();
      expect(paths(ctx).map((p) => fs.existsSync(p))).toEqual([true, true]);
    });
    await f.process(mergeInboundMessages([image("first"), image("second")]));
    f.store.runGc();
    expect(paths(f.context()).map((p) => fs.existsSync(p))).toEqual([false, false]);
  });

  it("releases earlier downloaded files when a later download is cancelled", async () => {
    const f = await fixture();
    let downloadedPath: string | undefined;
    const save = f.store.saveMediaBuffer.bind(f.store);
    const spy = vi.spyOn(f.store, "saveMediaBuffer").mockImplementation(async (...args) => {
      const saved = await save(...args);
      downloadedPath = saved.path;
      return saved;
    });
    duringFetch = (id) => {
      if (id === "second") f.controller.abort(new Error("download cancelled"));
    };
    try {
      await expect(
        f.process(mergeInboundMessages([image("first"), image("second")])),
      ).rejects.toThrow("download cancelled");
      expect(downloadedPath).toEqual(expect.any(String));
      f.store.runGc();
      expect(fs.existsSync(downloadedPath!)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["success", "failure", "cancel"])(
    "protects files during a turn and releases them after %s",
    async (end) => {
      const f = await fixture({ maxSingleMediaBytes: 1 });
      f.dispatch(async (ctx) => {
        f.store.runGc();
        expect(paths(ctx).map((p) => fs.existsSync(p))).toEqual([true, true]);
        if (end === "cancel") {
          f.controller.abort(new Error("cancelled"));
          throw f.controller.signal.reason;
        }
        if (end === "failure") throw new Error("agent failed");
      });
      const pending = f.process(mergeInboundMessages([image("first"), image("second")]));
      if (end === "success") await pending;
      else await expect(pending).rejects.toThrow(end === "cancel" ? "cancelled" : "agent failed");
      f.store.runGc();
      expect(paths(f.context()).map((p) => fs.existsSync(p))).toEqual([false, false]);
    },
  );
});

it("restores an actual cancelled media download before admitting the agent", async () => {
  const f = await fixture();
  const mediaFetch = globalThis.fetch;
  let phase = 0;
  let downloadStarted = false;
  let polls = 0;
  let cursorOnRestart: string | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      if (url.includes("getconfig")) return Response.json({ ret: 0, typing_ticket: "" });
      if (url.includes("getupdates")) {
        const request = JSON.parse(options.body as string);
        if (phase === 1 && polls === 0) cursorOnRestart = request.get_updates_buf;
        if (polls++ === 0)
          return Response.json({
            ret: 0,
            msgs: phase === 0 ? [image("slow")] : [],
            get_updates_buf: "saved-cursor",
          });
        return new Promise<Response>((_, reject) => {
          options.signal!.throwIfAborted();
          options.signal!.addEventListener("abort", () => reject(options.signal!.reason), {
            once: true,
          });
        });
      }
      if (phase === 0) {
        downloadStarted = true;
        return new Promise<Response>((_, reject) => {
          options.signal!.throwIfAborted();
          options.signal!.addEventListener("abort", () => reject(options.signal!.reason), {
            once: true,
          });
        });
      }
      return mediaFetch(url, options);
    }),
  );
  const start = (controller: AbortController) =>
    monitorWeixinProvider({
      accountId: "account",
      baseUrl: "https://offline.invalid",
      cdnBaseUrl: "https://offline.invalid",
      config: f.config,
      channelRuntime: f.runtime as any,
      abortSignal: controller.signal,
    });
  const first = start(f.controller);
  await vi.waitFor(() => expect(downloadStarted).toBe(true));
  f.controller.abort();
  await first;
  const snapshot = () => JSON.parse(fs.readFileSync(getSyncBufFilePath("account"), "utf8"));
  expect(snapshot().inbound.records.map((r: any) => r.state)).toEqual(["pending"]);
  expect(f.context()).toBeUndefined();
  phase = 1;
  polls = 0;
  const nextController = new AbortController();
  const next = start(nextController);
  try {
    await vi.waitFor(() => expect(polls).toBeGreaterThanOrEqual(2));
    expect(cursorOnRestart).toBe("saved-cursor");
    expect(fs.readFileSync(paths(f.context())[0], "utf8")).toBe("slow");
    expect(snapshot().inbound.records).toEqual([]);
  } finally {
    nextController.abort();
    await next;
  }
});

function startBatchedMonitor(
  f: Awaited<ReturnType<typeof fixture>>,
  messages: WeixinMessage[],
  controller = f.controller,
) {
  const mediaFetch = globalThis.fetch;
  let polls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      if (url.includes("getconfig")) return Response.json({ ret: 0, typing_ticket: "" });
      if (url.includes("getupdates")) {
        if (polls++ === 0)
          return Response.json({ ret: 0, msgs: messages, get_updates_buf: "after-batch" });
        return new Promise<Response>((_, reject) => {
          options.signal!.throwIfAborted();
          options.signal!.addEventListener("abort", () => reject(options.signal!.reason), {
            once: true,
          });
        });
      }
      return mediaFetch(url, options);
    }),
  );
  const done = monitorWeixinProvider({
    accountId: "account",
    baseUrl: "https://offline.invalid",
    cdnBaseUrl: "https://offline.invalid",
    config: { ...f.config, messages: { inbound: { debounceMs: 1 } } },
    channelRuntime: f.runtime as any,
    abortSignal: controller.signal,
  });
  const snapshot = () => JSON.parse(fs.readFileSync(getSyncBufFilePath("account"), "utf8"));
  return { done, snapshot };
}

function failMedia(ids: string[]) {
  const fetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) =>
      ids.some((id) => url.endsWith(`/${id}`))
        ? new Response("unavailable", { status: 404 })
        : fetch(url, options),
    ),
  );
}

describe("failure isolation within a merged turn", () => {
  it.each([0, 1, 2])(
    "continues healthy sources when source %s fails and admits only those sources",
    async (failedIndex) => {
      const f = await fixture();
      const messages = [image("a"), image("b"), image("c")];
      const failed = ["a", "b", "c"][failedIndex];
      const healthy = ["a", "b", "c"].filter((id) => id !== failed);
      failMedia([failed]);
      let dispatches = 0;
      const run = startBatchedMonitor(f, messages);
      f.dispatch(async () => {
        dispatches++;
        expect(
          run.snapshot().inbound.records.map((r: any) => [r.message.message_id, r.state]),
        ).toEqual(healthy.map((id) => [id, "processing"]));
      });
      try {
        await vi.waitFor(() => expect(run.snapshot().inbound.recent).toHaveLength(3));
        expect(dispatches).toBe(1);
        expect(paths(f.context()).map((p) => fs.readFileSync(p, "utf8"))).toEqual(healthy);
        expect(fetchOrder).toEqual(healthy);
        for (const id of healthy)
          expect(f.store.find("account", "owner", id)?.mediaPath).toBeDefined();
        expect(f.store.find("account", "owner", failed)).toBeNull();
      } finally {
        f.controller.abort();
        await run.done;
      }
    },
  );
  it("does not dispatch when every original message fails", async () => {
    const f = await fixture();
    failMedia(["a", "b"]);
    const run = startBatchedMonitor(f, [image("a"), image("b")]);
    try {
      await vi.waitFor(() => expect(run.snapshot().inbound.recent).toHaveLength(2));
      expect(f.context()).toBeUndefined();
      expect(run.snapshot().inbound.records).toEqual([]);
    } finally {
      f.controller.abort();
      await run.done;
    }
  });
  it("excludes a failed source's text and partial media but keeps other text and images", async () => {
    const f = await fixture();
    const broken = image("broken-source");
    broken.item_list!.push(...image("missing").item_list!, {
      type: 1,
      text_item: { text: "discard this text" },
    });
    const goodText: WeixinMessage = {
      from_user_id: "owner",
      message_id: "text",
      item_list: [{ type: 1, text_item: { text: "keep this text" } }],
    };
    failMedia(["missing"]);
    await f.process(mergeInboundMessages([image("good"), broken, goodText]));
    expect(f.context()?.Body).toBe("keep this text");
    expect(paths(f.context()).map((p) => fs.readFileSync(p, "utf8"))).toEqual(["good"]);
    expect(f.store.find("account", "owner", "broken-source")).toBeNull();
    expect(f.store.find("account", "owner", "text")?.body).toBe("keep this text");
  });
});

it("recovers healthy sources cancelled during preparation without replaying an earlier failed source", async () => {
  const f = await fixture();
  const mediaFetch = globalThis.fetch;
  let waiting = false;
  const attempted: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      attempted.push(url.split("/").at(-1)!);
      if (url.endsWith("/broken")) return new Response("unavailable", { status: 404 });
      waiting = true;
      return new Promise<Response>((_, reject) => {
        options.signal!.addEventListener("abort", () => reject(options.signal!.reason), {
          once: true,
        });
      });
    }),
  );
  const first = startBatchedMonitor(f, [image("broken"), image("healthy")]);
  try {
    await vi.waitFor(() => expect(waiting).toBe(true));
    expect(
      first.snapshot().inbound.records.map((r: any) => [r.message.message_id, r.state]),
    ).toEqual([["healthy", "pending"]]);
  } finally {
    f.controller.abort();
    await first.done;
  }
  expect(f.context()).toBeUndefined();
  vi.stubGlobal("fetch", mediaFetch);
  const controller = new AbortController();
  const second = startBatchedMonitor(f, [], controller);
  try {
    await vi.waitFor(() => expect(second.snapshot().inbound.records).toEqual([]));
    expect(fetchOrder).toEqual(["healthy"]);
    expect(paths(f.context()).map((p) => fs.readFileSync(p, "utf8"))).toEqual(["healthy"]);
    expect(attempted).toEqual(["broken", "healthy"]);
  } finally {
    controller.abort();
    await second.done;
  }
});

it("stops dispatch if settling one failed source cannot be persisted", async () => {
  const f = await fixture();
  const mediaFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith("/broken")) {
        vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
          throw new Error("disk unavailable");
        });
        return new Response("unavailable", { status: 404 });
      }
      return mediaFetch(url, options);
    }),
  );
  const run = startBatchedMonitor(f, [image("broken"), image("healthy")]);
  try {
    await expect(run.done).rejects.toThrow("Cannot persist");
    expect(f.context()).toBeUndefined();
    expect(run.snapshot().inbound.records.map((r: any) => [r.message.message_id, r.state])).toEqual(
      [
        ["broken", "pending"],
        ["healthy", "pending"],
      ],
    );
    expect(fetchOrder).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    f.controller.abort();
    await run.done.catch(() => {});
  }
});

it("releases partial media owned by a failed source while retaining healthy media through dispatch", async () => {
  const f = await fixture();
  const saved: string[] = [];
  const originalSave = f.store.saveMediaBuffer.bind(f.store);
  const spy = vi.spyOn(f.store, "saveMediaBuffer").mockImplementation(async (...args) => {
    const result = await originalSave(...args);
    saved.push(result.path);
    return result;
  });
  const broken = image("partial");
  broken.item_list!.push(...image("missing").item_list!);
  failMedia(["missing"]);
  f.dispatch(async (ctx) => {
    expect(fs.existsSync(saved[0])).toBe(false);
    f.store.runGc();
    expect(paths(ctx).every((p) => fs.existsSync(p))).toBe(true);
  });
  try {
    await f.process(mergeInboundMessages([broken, image("healthy")]));
    expect(saved).toHaveLength(2);
    expect(fs.existsSync(saved[0])).toBe(false);
    expect(fs.readFileSync(saved[1], "utf8")).toBe("healthy");
  } finally {
    spy.mockRestore();
  }
});

it("does not split or rerun healthy sources after the merged agent has started and failed", async () => {
  const f = await fixture();
  failMedia(["broken"]);
  let dispatches = 0;
  f.dispatch(async () => {
    dispatches++;
    throw new Error("agent execution failed");
  });
  await expect(
    f.process(mergeInboundMessages([image("a"), image("broken"), image("c")])),
  ).rejects.toThrow("agent execution failed");
  expect(dispatches).toBe(1);
  expect(fetchOrder).toEqual(["a", "c"]);
});

it.each([
  ["svr_id", false],
  ["svr_id", true],
  ["nested_id", false],
  ["nested_id", true],
  ["empty_text_item", false],
  ["empty_text_item", true],
])(
  "preserves a healthy source's resolved quote through filtering (kind=%s partial=%s)",
  async (kind, partial) => {
    const f = await fixture();
    await f.store.put({
      accountId: "account",
      conversationId: "owner",
      messageId: "quoted",
      direction: "inbound",
      body: "prefix CACHED QUOTE BODY suffix",
      createdAt: Date.now(),
    });
    const quoted: WeixinMessage = {
      from_user_id: "owner",
      message_id: "question",
      item_list: [
        {
          type: 1,
          text_item: { text: "explain this" },
          ref_msg: {
            ...(kind === "nested_id"
              ? { message_item: { msg_id: "quoted" } }
              : kind === "empty_text_item"
                ? { svr_id: "quoted", message_item: { type: 1 } }
                : { svr_id: "quoted" }),
            ...(partial
              ? {
                  partial_text: {
                    start: "CACHED",
                    end: "BODY",
                    startindex: 0,
                    endindex: 0,
                  },
                }
              : {}),
          },
        },
      ],
    };
    failMedia(["broken"]);
    await f.process(mergeInboundMessages([quoted, image("healthy"), image("broken")]));
    expect(f.context().Body).toBe(
      partial
        ? "（引用：CACHED QUOTE BODY）explain this"
        : "（引用：prefix CACHED QUOTE BODY suffix）explain this",
    );
    expect(paths(f.context()).map((p) => fs.readFileSync(p, "utf8"))).toEqual(["healthy"]);
  },
);

it("isolates failures with quote caching disabled", async () => {
  const f = await fixture({ enabled: false });
  f.runtime.media.saveMediaBuffer = async (buffer) => {
    const filePath = path.join(root, "host-inbound.bin");
    await fs.promises.writeFile(filePath, buffer);
    return { path: filePath };
  };
  failMedia(["broken"]);
  const run = startBatchedMonitor(f, [image("broken"), image("healthy")]);
  try {
    await vi.waitFor(() => expect(run.snapshot().inbound.recent).toHaveLength(2));
    expect(paths(f.context()).map((p) => fs.readFileSync(p, "utf8"))).toEqual(["healthy"]);
    expect(run.snapshot().inbound.records).toEqual([]);
  } finally {
    f.controller.abort();
    await run.done;
  }
});

describe("quoted attachment failure isolation", () => {
  const question = (): WeixinMessage => ({
    from_user_id: "owner",
    message_id: "new-question",
    item_list: [
      {
        type: 1,
        text_item: { text: "answer this new question" },
        ref_msg: {
          svr_id: "old-image",
          message_item: image("old-image").item_list![0],
        },
      },
    ],
  });

  it("reuses a cached inline quoted attachment without fetching its old URL", async () => {
    const f = await fixture();
    await f.process(image("old-image"));
    const cachedPath = paths(f.context())[0];
    fetchOrder.length = 0;
    vi.mocked(fetch).mockRejectedValue(new Error("old URL unavailable"));
    await f.process(question());
    expect(fetchOrder).toEqual([]);
    expect(f.context().Body).toBe("answer this new question");
    expect(f.context().ReplyToBody).toBe("[图片]");
    expect(paths(f.context())).toEqual([cachedPath]);
    expect(f.context().media[0].messageId).toBe("old-image");
  });

  it.each([true, false])(
    "dispatches new text when a quoted URL returns 403 (cache enabled: %s)",
    async (enabled) => {
      const f = await fixture({ enabled });
      vi.mocked(fetch).mockResolvedValue(new Response("expired", { status: 403 }));
      await f.process(question());
      expect(f.context().Body).toBe("answer this new question");
      expect(f.context().ReplyToBody).toContain("引用附件暂不可用");
      expect(paths(f.context())).toEqual([]);
    },
  );

  it("preserves inline file metadata while reusing cached bytes", async () => {
    const f = await fixture();
    await f.process(file());
    const cachedPath = paths(f.context())[0];
    const msg = question();
    msg.item_list![0].ref_msg = {
      svr_id: "file",
      title: "original report",
      message_item: file().item_list![0],
    };
    const fetchCalls = vi.mocked(fetch).mock.calls.length;
    vi.mocked(fetch).mockRejectedValue(new Error("old URL unavailable"));
    await f.process(msg);
    expect(fetch).toHaveBeenCalledTimes(fetchCalls);
    expect(paths(f.context())).toEqual([cachedPath]);
    expect(f.context().ReplyToBody).toBe("original report | [文件]");
    expect(f.context().media[0]).toMatchObject({ fileName: "report.pdf", messageId: "file" });
  });

  it("downloads a quoted attachment when no usable local copy exists", async () => {
    const f = await fixture();
    await f.process(image("old-image"));
    fs.unlinkSync(paths(f.context())[0]);
    fetchOrder.length = 0;
    let contents: string[] = [];
    f.dispatch(async (ctx) => {
      contents = paths(ctx).map((p) => fs.readFileSync(p, "utf8"));
    });
    await f.process(question());
    expect(fetchOrder).toEqual(["old-image"]);
    expect(f.context().Body).toBe("answer this new question");
    expect(f.context().ReplyToBody).toBe("[图片]");
    expect(contents).toEqual(["old-image"]);
  });

  it.each([false, true])(
    "keeps the inline quote title if both the cached file and remote URL are unavailable (merged: %s)",
    async (merged) => {
      const f = await fixture();
      await f.process(image("old-image"));
      fs.unlinkSync(paths(f.context())[0]);
      const msg = question();
      msg.item_list![0].ref_msg!.title = "original image title";
      failMedia(["old-image"]);
      await f.process(merged ? mergeInboundMessages([msg, image("healthy")]) : msg);
      const quote = merged ? f.context().Body : f.context().ReplyToBody;
      expect(quote).toContain("original image title");
      expect(quote).toContain("引用附件暂不可用");
      expect(f.context().Body).toContain("answer this new question");
    },
  );

  it("keeps a new question in the merged turn when its quoted download fails", async () => {
    const f = await fixture();
    failMedia(["old-image"]);
    await f.process(mergeInboundMessages([question(), image("healthy")]));
    expect(f.context().Body).toContain("answer this new question");
    expect(f.context().Body).toContain("引用附件暂不可用");
    expect(paths(f.context()).map((p) => fs.readFileSync(p, "utf8"))).toEqual(["healthy"]);
    expect(f.store.find("account", "owner", "new-question")?.body).toBe("answer this new question");
  });

  it("propagates cancellation during a quoted download without dispatching", async () => {
    const f = await fixture();
    const dispatch = vi.fn();
    f.dispatch(dispatch);
    duringFetch = () => f.controller.abort(new Error("stop quoted download"));
    await expect(f.process(question())).rejects.toThrow("stop quoted download");
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.store.find("account", "owner", "new-question")).toBeNull();
  });

  it("admits the new question in the journal even when its quoted download fails", async () => {
    const f = await fixture();
    failMedia(["old-image"]);
    const run = startBatchedMonitor(f, [image("healthy"), question()]);
    const admissions: unknown[] = [];
    f.dispatch(async () => {
      admissions.push(
        run.snapshot().inbound.records.map((r: any) => [r.message.message_id, r.state]),
      );
    });
    try {
      await vi.waitFor(() => expect(run.snapshot().inbound.recent).toHaveLength(2));
      expect(admissions).toEqual([
        [
          ["healthy", "processing"],
          ["new-question", "processing"],
        ],
      ]);
      expect(f.context().Body).toContain("answer this new question");
      expect(run.snapshot().inbound.records).toEqual([]);
    } finally {
      f.controller.abort();
      await run.done;
    }
  });
});
