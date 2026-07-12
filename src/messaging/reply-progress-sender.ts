import type { WeixinApiOptions } from "../api/api.js";
import type { MessageItem } from "../api/types.js";
import { MessageItemType } from "../api/types.js";
import { logger } from "../util/logger.js";

import { sendMessageItemWeixin } from "./send.js";

export type WeixinReplyProgressSenderDeps = {
  runId: string;
  to: string;
  accountId: string;
  opts: WeixinApiOptions & {
    contextToken?: string;
    runId?: string;
  };
};

type ToolItemEventPayload = {
  itemId?: string;
  kind?: string;
  title?: string;
  name?: string;
  phase?: string;
  status?: string;
};

function normalizeToolStatus(status?: string): string {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  return "unknown";
}

export class WeixinReplyProgressSender {
  readonly runId: string;

  private readonly to: string;
  private readonly accountId: string;
  private readonly opts: WeixinReplyProgressSenderDeps["opts"];
  private finalized = false;
  private sendChain: Promise<void> = Promise.resolve();

  constructor(deps: WeixinReplyProgressSenderDeps) {
    this.runId = deps.runId;
    this.to = deps.to;
    this.accountId = deps.accountId;
    this.opts = { ...deps.opts, runId: deps.runId };
  }

  get replyOptions() {
    return {
      runId: this.runId,
      onItemEvent: (payload: ToolItemEventPayload) => this.handleToolItemEvent(payload),
    };
  }

  private enqueueMessage(item: MessageItem, label: string): void {
    if (this.finalized) return;
    this.sendChain = this.sendChain
      .then(async () => {
        await sendMessageItemWeixin({
          to: this.to,
          item,
          opts: this.opts,
          label,
        });
      })
      .catch((err) => {
        logger.warn(`${label}: failed to=${this.to} accountId=${this.accountId} runId=${this.runId} err=${String(err)}`);
      });
  }

  private handleToolItemEvent(payload: ToolItemEventPayload): void {
    if (this.finalized) return;
    if (payload.kind !== "tool") return;
    if (payload.phase !== "start" && payload.phase !== "end") return;

    const now = Date.now();
    const toolName = payload.name?.trim() || payload.title?.trim() || "tool";
    const toolCallId = payload.itemId?.trim() || undefined;

    if (payload.phase === "start") {
      this.enqueueMessage(
        {
          type: MessageItemType.TOOL_CALL_START,
          create_time_ms: now,
          is_completed: false,
          tool_call_start_item: {
            tool_name: toolName,
            tool_call_id: toolCallId,
          },
        },
        "sendToolCallStartMessage",
      );
      return;
    }

    this.enqueueMessage(
      {
        type: MessageItemType.TOOL_CALL_RESULT,
        create_time_ms: now,
        is_completed: true,
        tool_call_result_item: {
          tool_name: toolName,
          tool_call_id: toolCallId,
          status: normalizeToolStatus(payload.status),
        },
      },
      "sendToolCallResultMessage",
    );
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    try {
      await this.sendChain;
    } catch (err) {
      logger.warn(`WeixinReplyProgressSender.finalize: send drain failed runId=${this.runId} err=${String(err)}`);
    }
  }
}
