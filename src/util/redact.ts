const DEFAULT_BODY_MAX_LEN = 200;
const DEFAULT_TOKEN_PREFIX_LEN = 6;

/**
 * Truncate a string, appending a length indicator when trimmed.
 * Returns `""` for empty/undefined input.
 */
export function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(len=${s.length})`;
}

/**
 * Redact a token/secret: show only the first few chars + total length.
 * Returns `"(none)"` when absent.
 */
export function redactToken(token: string | undefined, prefixLen = DEFAULT_TOKEN_PREFIX_LEN): string {
  if (!token) return "(none)";
  if (token.length <= prefixLen) return `****(len=${token.length})`;
  return `${token.slice(0, prefixLen)}…(len=${token.length})`;
}

/** Field names whose values should be masked in logged JSON bodies. */
const SENSITIVE_FIELD_NAMES = [
  "authorization",
  "token",
  "bot_token",
  "context_token",
  "local_token_list",
  "aeskey",
  "aes_key",
  "encrypt_query_param",
  "upload_param",
  "thumb_upload_param",
  "upload_full_url",
  "full_url",
  "qrcode",
  "qrcode_url",
  "verify_code",
] as const;

const SENSITIVE_FIELDS = new Set<string>(SENSITIVE_FIELD_NAMES);
const SENSITIVE_FIELD_PATTERN = SENSITIVE_FIELD_NAMES.join("|");
const SENSITIVE_STRING_FIELD_RE = new RegExp(
  `"(${SENSITIVE_FIELD_PATTERN})"\\s*:\\s*"(?:\\\\.|[^"\\\\])*"`,
  "gi",
);
const SENSITIVE_COMPOSITE_FIELD_RE = new RegExp(
  `"(${SENSITIVE_FIELD_PATTERN})"\\s*:\\s*(?:\\[[^\\]]*\\]|\\{[^}]*\\})`,
  "gi",
);

function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SENSITIVE_FIELDS.has(key.toLowerCase()) ? "<redacted>" : redactJsonValue(child),
    ]),
  );
}

/**
 * Truncate a JSON body string to `maxLen` chars for safe logging.
 * Redacts known sensitive fields before truncating.
 */
export function redactBody(body: string | undefined, maxLen = DEFAULT_BODY_MAX_LEN): string {
  if (!body) return "(empty)";
  let redacted: string;
  try {
    redacted = JSON.stringify(redactJsonValue(JSON.parse(body)));
  } catch {
    // Best-effort fallback for malformed or partial JSON returned by an upstream service.
    redacted = body
      .replace(SENSITIVE_STRING_FIELD_RE, '"$1":"<redacted>"')
      .replace(SENSITIVE_COMPOSITE_FIELD_RE, '"$1":"<redacted>"');
  }
  if (redacted.length <= maxLen) return redacted;
  return `${redacted.slice(0, maxLen)}…(truncated, totalLen=${redacted.length})`;
}

/**
 * Strip query string (which often contains signatures/tokens) from a URL,
 * keeping only origin + pathname.
 */
export function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const base = `${u.origin}${u.pathname}`;
    return u.search ? `${base}?<redacted>` : base;
  } catch {
    return truncate(rawUrl, 80);
  }
}
