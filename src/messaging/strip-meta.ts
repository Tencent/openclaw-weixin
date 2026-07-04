/**
 * Strips OpenClaw-injected inbound metadata blocks from LLM output text.
 * These blocks are constructed by buildInboundUserContextPrefix() and
 * should never surface in user-visible chat output.
 *
 * Each block has the shape:
 *
 * [timestamp] Conversation info (untrusted metadata):
 * ```json
 * { … }
 * ```
 */

const INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Reply target of current user message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
];

// Regex to match lines ending with a known sentinel, optionally with a timestamp prefix
// e.g. "[Sat 2026-07-04 17:45 GMT+8] Conversation info (untrusted metadata):"
const SENTINEL_LINE_RE = new RegExp(
  "^(?:\\[[^\\]]+\\]\\s*)?(?:" +
    INBOUND_META_SENTINELS.map((s) =>
      s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ).join("|") +
    ")\\s*$",
);

const SENTINEL_FAST_RE = new RegExp(
  INBOUND_META_SENTINELS.map((s) =>
    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|"),
);

function isInboundMetaSentinelLine(line: string): boolean {
  return SENTINEL_LINE_RE.test(line);
}

export function stripInboundMetadata(text: string): string {
  if (!text || !SENTINEL_FAST_RE.test(text)) return text;

  const lines = text.split("\n");
  const result: string[] = [];
  let inMetaBlock = false;
  let inFencedJson = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inMetaBlock && isInboundMetaSentinelLine(line)) {
      // Check next non-empty line is ```json
      let nextIdx = i + 1;
      while (nextIdx < lines.length && lines[nextIdx].trim() === "") nextIdx++;
      if (nextIdx < lines.length && lines[nextIdx].trim() === "```json") {
        inMetaBlock = true;
        inFencedJson = false;
        i = nextIdx; // skip ahead to the ```json line
        continue;
      }
      result.push(line);
      continue;
    }

    if (inMetaBlock) {
      if (!inFencedJson && line.trim() === "```json") {
        inFencedJson = true;
        continue;
      }
      if (inFencedJson) {
        if (line.trim() === "```") {
          inMetaBlock = false;
          inFencedJson = false;
        }
        continue;
      }
      // Unexpected content — treat as not-a-metablock
      inMetaBlock = false;
    }

    result.push(line);
  }

  return result.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}
