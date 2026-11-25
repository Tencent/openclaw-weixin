import { beforeEach, expect, it, vi } from "vitest";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import type { WeixinMessage } from "../api/types.js";
import { MessageType } from "../api/types.js";
import { downloadMediaFromItem } from "../media/media-download.js";
import { mergeInboundMessages } from "./inbound-sources.js";
import { processOneMessage, type ProcessMessageDeps } from "./process-message.js";

const account = vi.hoisted(() => ({ userId: "Fixture-User" }));
vi.mock("../auth/accounts.js", () => ({ loadWeixinAccount: () => account }));
vi.mock("./quote-store.js", () => ({
  getQuoteStore: () => undefined,
  getActiveQuoteMediaSubdir: () => "fixture",
}));
vi.mock("./debug-mode.js", () => ({ isDebugMode: () => false }));
vi.mock("../media/media-download.js", () => ({ downloadMediaFromItem: vi.fn() }));
vi.mock("../util/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

function message(id: string, overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    from_user_id: "Fixture-User",
    message_id: id,
    message_type: MessageType.USER,
    item_list: [{ type: 1, text_item: { text: id } }],
    ...overrides,
  };
}

function fixture() {
  const ingress = { resolveStable: vi.fn(resolveStableChannelMessageIngress) };
  const buildContext = vi.fn(buildChannelInboundEventContext);
  const dispatch = vi.fn().mockResolvedValue({});
  const runtime = {
    media: { saveMediaBuffer: vi.fn() },
    commands: { shouldComputeCommandAuthorized: () => false },
    routing: {
      resolveAgentRoute: () => ({
        agentId: "fixture",
        sessionKey: "test:dm",
        mainSessionKey: "main",
      }),
    },
    session: { resolveStorePath: () => "/unused", recordInboundSession: vi.fn() },
    inbound: { ingress, buildContext },
    reply: {
      finalizeInboundContext,
      resolveHumanDelayConfig: () => ({}),
      createReplyDispatcherWithTyping: () => ({
        dispatcher: {},
        replyOptions: {},
        markDispatchIdle() {},
      }),
      withReplyDispatcher: ({ run }: { run: () => Promise<unknown> }) => run(),
      dispatchReplyFromConfig: dispatch,
    },
  };
  const deps: ProcessMessageDeps = {
    accountId: "fixture-account",
    baseUrl: "https://unused.invalid",
    cdnBaseUrl: "https://unused.invalid",
    config: {
      channels: { "openclaw-weixin": { errorNotices: false, replyProgressMessages: false } },
    },
    channelRuntime: runtime as unknown as ProcessMessageDeps["channelRuntime"],
    log() {},
    errLog() {},
  };
  return { deps, ingress, buildContext, dispatch };
}
beforeEach(() => {
  account.userId = "Fixture-User";
});

it("passes each admitted DM result from the host to its context builder in source order", async () => {
  const f = fixture();
  await processOneMessage(mergeInboundMessages([message("one"), message("two")]), f.deps);
  expect(f.ingress.resolveStable).toHaveBeenCalledTimes(2);
  const bindings = f.ingress.resolveStable.mock.calls.map(([args]) => args.contextBinding);
  expect(bindings.map((b) => b?.messageId)).toEqual(["one", "two"]);
  expect(bindings[1]).toMatchObject({
    agentId: "fixture",
    sessionKey: "test:dm",
    inboundEventKind: "user_request",
  });
  const inputs = f.buildContext.mock.calls[0][0];
  const decisions = await Promise.all(f.ingress.resolveStable.mock.results.map((r) => r.value));
  const passed = inputs.channelIngress;
  if (!Array.isArray(passed)) throw new Error("expected ordered ingress results");
  for (const [i, item] of decisions.entries()) expect(passed[i]).toBe(item);
  expect(f.dispatch.mock.calls[0][0].ctx).toMatchObject({
    SenderId: "Fixture-User",
    MessageSidFull: "two",
    Body: "one\ntwo",
    SessionKey: "test:dm",
  });
});

it.each([
  ["bot", { message_type: MessageType.BOT }],
  ["group", { group_id: "room" }],
  ["unknown type", { message_type: undefined }],
])("keeps a batch containing a %s source out of owner ingress", async (_, overrides) => {
  const f = fixture();
  await processOneMessage(
    mergeInboundMessages([message("one", overrides as Partial<WeixinMessage>), message("two")]),
    f.deps,
  );
  expect(f.ingress.resolveStable).not.toHaveBeenCalled();
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it("keeps unbound legacy accounts on the ordinary chat path", async () => {
  account.userId = "";
  const f = fixture();
  await processOneMessage(message("one"), f.deps);
  expect(f.ingress.resolveStable).not.toHaveBeenCalled();
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it("rejects a sender with a different case before dispatch", async () => {
  const f = fixture();
  await processOneMessage(message("one", { from_user_id: "fixture-user" }), f.deps);
  expect(f.ingress.resolveStable).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it("honors a host refusal without falling back to legacy dispatch", async () => {
  const f = fixture();
  f.ingress.resolveStable.mockImplementationOnce((input) =>
    resolveStableChannelMessageIngress({ ...input, dmPolicy: "disabled" }),
  );
  await processOneMessage(message("rejected"), f.deps);
  expect(f.buildContext).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it("retains a downloaded attachment and the referenced message on the verified DM", async () => {
  const f = fixture();
  vi.mocked(downloadMediaFromItem).mockResolvedValueOnce({ decryptedPicPath: "/tmp/fixture.jpg" });
  await processOneMessage(
    message("photo", {
      item_list: [
        {
          type: 1,
          text_item: { text: "caption" },
          ref_msg: {
            svr_id: "quoted",
            message_item: { type: 1, text_item: { text: "prior" } },
          },
        },
        { type: 2, image_item: { media: { full_url: "https://unused.invalid/photo" } } },
      ],
    }),
    f.deps,
  );
  expect(f.dispatch.mock.calls[0][0].ctx).toMatchObject({
    SenderId: "Fixture-User",
    MessageSidFull: "photo",
    ReplyToId: "quoted",
    ReplyToIsQuote: true,
    media: [expect.objectContaining({ path: "/tmp/fixture.jpg" })],
  });
});
