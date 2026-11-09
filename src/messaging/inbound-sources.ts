import type { MessageItem, RefMessage, WeixinMessage } from "../api/types.js";
import { MessageItemType } from "../api/types.js";

// Keep local batching metadata outside the protocol envelope.
const batchSources = new WeakMap<WeixinMessage, readonly WeixinMessage[]>();

export function getInboundSources(message: WeixinMessage): readonly WeixinMessage[] {
  return batchSources.get(message) ?? [message];
}

export function setInboundSources(merged: WeixinMessage, messages: readonly WeixinMessage[]): void {
  batchSources.set(
    merged,
    messages.flatMap((message) => [...getInboundSources(message)]),
  );
}

const MEDIA_LABELS: Record<number, string> = {
  [MessageItemType.IMAGE]: "[图片]",
  [MessageItemType.VIDEO]: "[视频]",
  [MessageItemType.FILE]: "[文件]",
  [MessageItemType.VOICE]: "[语音]",
};

/** Render a quote as inline text, since merged messages lose native ReplyTo* context. */
function quoteSummary(ref: RefMessage, resolvedBody?: string): string {
  if (resolvedBody) return `（引用：${resolvedBody}）`;
  const parts: string[] = [];
  if (ref.title?.trim()) parts.push(ref.title.trim());
  const item = ref.message_item;
  if (item?.type === MessageItemType.TEXT && item.text_item?.text) {
    parts.push(String(item.text_item.text));
  } else if (item?.type === MessageItemType.VOICE && item.voice_item?.text) {
    parts.push(String(item.voice_item.text));
  } else if (item?.type === MessageItemType.FILE && item.file_item?.file_name) {
    parts.push(`[文件 ${item.file_item.file_name}]`);
  } else if (item?.type !== undefined && MEDIA_LABELS[item.type]) {
    parts.push(MEDIA_LABELS[item.type]);
  }
  return parts.length ? `（引用：${parts.join(" | ")}）` : "（引用了之前的一条消息）";
}

/**
 * Merge several inbound messages from one sender into a single message: all texts
 * (including transcribed voice and inline-rendered quotes) joined into one TEXT item,
 * followed by every media item. Envelope fields (context_token, message_id, ...) come
 * from the last message so replies use the freshest context token.
 */
export function mergeInboundMessages(
  msgs: WeixinMessage[],
  resolvedQuotes?: ReadonlyMap<RefMessage, string>,
): WeixinMessage {
  if (msgs.length === 1) return msgs[0];
  const texts: string[] = [];
  const media: MessageItem[] = [];
  for (const msg of msgs) {
    for (const item of msg.item_list ?? []) {
      if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
        texts.push(
          (item.ref_msg ? quoteSummary(item.ref_msg, resolvedQuotes?.get(item.ref_msg)) : "") +
            String(item.text_item.text),
        );
      } else if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
        texts.push(String(item.voice_item.text));
      } else if (item.type !== undefined && MEDIA_LABELS[item.type]) {
        media.push(item);
      }
    }
  }
  const item_list: MessageItem[] = [];
  if (texts.length) {
    item_list.push({ type: MessageItemType.TEXT, text_item: { text: texts.join("\n") } });
  }
  item_list.push(...media);
  const merged = { ...msgs[msgs.length - 1], item_list };
  setInboundSources(merged, msgs);
  return merged;
}
