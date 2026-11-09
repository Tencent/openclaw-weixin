import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import type { WeixinMessage } from "../api/types.js";
import { MessageItemType } from "../api/types.js";
import { mergeInboundMessages } from "../messaging/inbound-sources.js";
export { mergeInboundMessages } from "../messaging/inbound-sources.js";

const CHANNEL_ID = "openclaw-weixin";

/**
 * Resolve the image batching window from `messages.inbound.byChannel["openclaw-weixin"]`,
 * falling back to `messages.inbound.debounceMs`. Returns 0 (batching disabled) when unset.
 */
export function resolveInboundBatchWindowMs(config: OpenClawConfig | undefined): number {
  const inbound = (
    config as
      | { messages?: { inbound?: { debounceMs?: unknown; byChannel?: Record<string, unknown> } } }
      | undefined
  )?.messages?.inbound;
  const value = Number(inbound?.byChannel?.[CHANNEL_ID] ?? inbound?.debounceMs ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isImageMessage(msg: WeixinMessage): boolean {
  return (
    (msg.item_list?.length ?? 0) > 0 &&
    msg.item_list!.every((i) => i.type === MessageItemType.IMAGE)
  );
}

function isCommandMessage(msg: WeixinMessage): boolean {
  const item = msg.item_list?.length === 1 ? msg.item_list[0] : undefined;
  return (
    item?.type === MessageItemType.TEXT &&
    String(item.text_item?.text ?? "")
      .trimStart()
      .startsWith("/")
  );
}

type BatchUnit = { batch: WeixinMessage[] } | { single: WeixinMessage };

type SenderState = {
  running: boolean;
  /** Image burst still waiting for its quiet window to elapse. */
  open: WeixinMessage[] | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  queue: BatchUnit[];
};

export type InboundBatcherOpts = {
  /** Quiet window used to collect a burst of images before dispatching them together. */
  imageWindowMs: number;
  /** Processes one (possibly merged) message; called serially per sender. */
  process: (msg: WeixinMessage) => Promise<void>;
  onError?: (err: unknown) => void;
  onMerged?: (info: { from: string; count: number; media: number }) => void;
};

/**
 * Per-sender inbound batching:
 * - while idle, text / file / video / voice / quote messages dispatch immediately;
 * - images wait `imageWindowMs` after the last image so a multi-image send becomes one turn;
 *   any non-command message arriving inside that window joins the batch and flushes it;
 * - everything (except slash commands) that arrives while a turn is running is merged
 *   into a single follow-up turn;
 * - slash commands always run as their own turn, in arrival order.
 */
export function createInboundBatcher(opts: InboundBatcherOpts) {
  const senders = new Map<string, SenderState>();
  const active = new Set<Promise<void>>();
  let stopped = false;

  const stateOf = (sender: string): SenderState => {
    let s = senders.get(sender);
    if (!s) {
      s = { running: false, open: null, timer: undefined, queue: [] };
      senders.set(sender, s);
    }
    return s;
  };

  const merge = (msgs: WeixinMessage[]): WeixinMessage => {
    const merged = mergeInboundMessages(msgs);
    if (msgs.length > 1) {
      opts.onMerged?.({
        from: msgs[0].from_user_id ?? "",
        count: msgs.length,
        media: merged.item_list?.filter((i) => i.type !== MessageItemType.TEXT).length ?? 0,
      });
    }
    return merged;
  };

  const pump = (sender: string): void => {
    const s = stateOf(sender);
    if (stopped || s.running || s.queue.length === 0) return;
    const unit = s.queue.shift()!;
    let msg: WeixinMessage;
    if ("batch" in unit) {
      const msgs = [...unit.batch];
      while (s.queue[0] && "batch" in s.queue[0]) {
        msgs.push(...(s.queue.shift() as { batch: WeixinMessage[] }).batch);
      }
      // Images still inside their window arrived during the previous turn, after this
      // batch; fold them in unless a queued command sits between them.
      if (s.open && s.queue.length === 0) {
        clearTimeout(s.timer);
        msgs.push(...s.open);
        s.open = null;
      }
      msg = merge(msgs);
    } else {
      msg = unit.single;
    }
    s.running = true;
    const task = opts
      .process(msg)
      .catch((err) => opts.onError?.(err))
      .finally(() => {
        active.delete(task);
        s.running = false;
        pump(sender);
      });
    active.add(task);
  };

  const closeOpen = (s: SenderState): void => {
    if (!s.open) return;
    clearTimeout(s.timer);
    s.queue.push({ batch: s.open });
    s.open = null;
  };

  return {
    push(msg: WeixinMessage): void {
      if (stopped) return;
      const sender = msg.from_user_id ?? "";
      const s = stateOf(sender);
      if (isImageMessage(msg)) {
        s.open ??= [];
        s.open.push(msg);
        clearTimeout(s.timer);
        s.timer = setTimeout(() => {
          closeOpen(s);
          pump(sender);
        }, opts.imageWindowMs);
        return;
      }
      if (isCommandMessage(msg)) {
        closeOpen(s);
        s.queue.push({ single: msg });
      } else if (s.open) {
        s.open.push(msg);
        closeOpen(s);
      } else {
        s.queue.push({ batch: [msg] });
      }
      pump(sender);
    },
    /** Dispatch pending image bursts immediately while accepting work. */
    flush(): void {
      if (stopped) return;
      for (const [sender, s] of senders) {
        closeOpen(s);
        pump(sender);
      }
    },
    /** Stop dispatching, discard in-memory queues, and await owned preparation/dispatch. */
    async stop(): Promise<void> {
      stopped = true;
      for (const s of senders.values()) {
        clearTimeout(s.timer);
        s.open = null;
        s.queue = [];
      }
      await Promise.allSettled(active);
    },
  };
}
