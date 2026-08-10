# Changelog

[简体中文](CHANGELOG.md)

This project follows the [Keep a Changelog](https://keepachangelog.com/) format.

## [Unreleased]

### Fixed

- **Refuse to send when `contextToken` is missing (avoid silent-drop):** the 5
  send entry points (`sendMessageWeixin`, `sendMessageItemWeixin`,
  `sendImageMessageWeixin`, `sendVideoMessageWeixin`, `sendFileMessageWeixin`)
  now throw instead of `logger.warn`-and-continue when `contextToken` is absent,
  preventing iLink from silently dropping the message (empty 200 body) while the
  caller still receives a fake success (`messageId`). Recipient IDs are no longer
  logged in plaintext; they are redacted via `redactToken`
  (see Tencent/openclaw-weixin#247).

## [3.1.0] - 2026-08-10

### Fixed

- **OpenClaw SDK entry compatibility:** `createTypingCallbacks` now imports from
  `openclaw/plugin-sdk/channel-message`, supporting both the minimum host that
  still exposes the legacy entry and modern hosts that removed `channel-runtime`.
  CI builds and imports this boundary and runs an unmocked plugin-registration
  smoke against both real SDK profiles.
- **Context-token user ID case normalization (outbound ret=-3):** account-scoped
  in-memory and persisted context-token keys now lowercase the user ID. Mixed-case
  IDs from getUpdates, lowercased OpenClaw session targets, and legacy persisted
  files therefore resolve the same token after restart
  (see Tencent/openclaw-weixin#243).
- **Persist stable `--account` aliases on QR login (logical mapping):** after
  `channels login --account <alias>` succeeds, credentials and state stay under
  the server `ilink_bot_id` (primary hash) and a 1:1 `alias → hash` map is stored
  for bindings / outbound resolution. `listAccountIds` / monitors use only the
  primary; `config.isEnabled` returns false for aliases so host `start(alias)` is
  rejected before a lifecycle task (no restart loop). The host `default` sentinel
  is never treated as an alias; `alreadyConnected` only records the mapping when
  unambiguous and is a no-op for existing primary-hash relogin; conflicting alias
  credentials are rejected without moving sync/context/allow-list state; the
  account index is written atomically and left intact if publish fails.

## [3.0.2] - 2026-08-05

### Changed

- **Per-agent inbound media isolation:** images, videos, files, and voice messages
  are now stored under `weixin/<agentId>/inbound` for the routed agent, preventing
  mixed media and cross-agent access in multi-agent deployments. Unresolved
  routes continue to use the legacy-compatible `inbound` path.

### Fixed

- **Inbound getUpdates duplicate delivery:** ordinary and approval admission
  lanes claim a stable dedupe key (`message_id` → `client_id` → `seq` → body
  fingerprint) via OpenClaw `createClaimableDedupe` (account-scoped
  `resolveFilePath` under `openclaw-weixin/replay-dedupe/`, compatible with the
  minimum host `2026.6.1`) before processing, then commit a 24h tombstone so
  at-least-once iLink long-poll replays (~1s) and longer redeliveries after
  stuck long turns do not run the AI pipeline twice — including across process
  restart. Failures and abort release the claim for retry. In-flight replays
  release the admission lane immediately, observe the owner out of band, and
  re-enqueue only if the owner releases — so a distinct follow-up message is
  not blocked. Claim ownership wraps every step after admission. Fallback keys
  prefer item `msg_id` digests and never key by sender alone. Duplicate logs
  record only a non-sensitive identity kind. The window is a **replay-dedupe /
  tombstone window**, not a content dedupe that swallows intentional re-sends
  with a new `message_id`. Stable `MessageSid` uses the same key when transport
  ids are present. Port of
  [Tencent/openclaw-weixin#240](https://github.com/Tencent/openclaw-weixin/pull/240);
  tracks [NewFuture/openclaw-weixin#36](https://github.com/NewFuture/openclaw-weixin/issues/36).

## [3.0.1] - 2026-08-02

### Changed

- Bound npm publishing to the protected `npm-publish` environment, requiring a
  repository administrator's approval after automated validation and granting
  OIDC publish permission only to the approved job.
- Made the same workflow mirror each npmjs release to GitHub Packages as
  `@newfuture/openclaw-weixin`, then create a GitHub Release from the bilingual
  changelogs; retries skip existing package versions and reconcile missing
  destinations; publication remains blocked, including when the registry is
  empty, until the preceding repository release reaches GitHub Packages.
- Expanded the minimum supported OpenClaw host to `2026.6.1`, retained
  `2026.7.1` as the normal development baseline, and added a full minimum-host
  CI build and test.

## [3.0.0] - 2026-07-31

### Added

- Exec approval prompts now expose separate copy-friendly `/approve` code blocks:
  forwarded prompts append each allowed short-ID action, while direct prompts
  split each command under `Other options` into its own block.

### Changed

- Set the community package and plugin version to `3.0.0` for the first release
  after consolidating on the single `openclaw-weixin` identity.
- Standardized the repository, npm package, plugin, and channel name on
  `openclaw-weixin`, and simplified releases to publish one package.
- Standardized the MIT license text and packaged an informational `NOTICE`
  preserving Tencent's upstream attribution and the community modification
  notice.
- Added a release metadata gate and idempotent release reconciliation after
  successful `main` CI, with immutable transition-commit tagging and ordered npm
  publication.
- Made Chinese the primary README and moved the English version to
  `README_EN.md`, while retaining `README.zh_CN.md` as a compatibility link.
- Raised the minimum supported OpenClaw host to `2026.7.1` and aligned the
  runtime guard, package metadata, development environment, and CI Node.js
  floors with that release.
- Unified plugin installation and in-place Tencent-package replacement around
  one `--force` command, with separate account setup, reload verification, and
  agent guidance; moved detailed usage and protocol reference into the packaged
  `docs/` directory.

### Security

- Overrode vulnerable transitive development dependencies with patched versions
  and added a moderate-or-higher dependency audit gate to CI and npm releases.

## [2.4.6] - 2026-07-23

### Changed

- Prepared the first community-maintained npm distribution as the unscoped
  `openclaw-weixin` package, derived from Tencent's
  `@tencent-weixin/openclaw-weixin`.
- Preserved the internal `openclaw-weixin` plugin/channel id, configuration
  keys, and state paths for in-place migration.
- Added community repository metadata, package-content checks, and an
  npm Trusted Publishing workflow.
- Aligned the runtime compatibility guard and documentation with OpenClaw
  `>=2026.5.12` and Node.js `>=22`.

## [2.4.5] - 2026-06-22

### Added

- **`classifyFetchError` — network error classification:** New `classifyFetchError` utility in `src/api/api.ts` classifies fetch-level errors into `dns` / `tcp` / `tls` / `timeout` / `unknown`. `apiGetFetch` and `apiPostFetch` now log structured error details (type, description, code) on failure, making network troubleshooting significantly easier. Includes full test coverage for ENOTFOUND, ECONNREFUSED, ETIMEDOUT, SSL/TLS, AbortError, and more.
- **`sendMessage` response validation:** `sendMessage` now parses the server response (`SendMessageResp` with `ret` / `errmsg`) and throws on non-zero `ret`, preventing silent delivery failures.

### Changed

- **`SESSION_EXPIRED_ERRCODE` → `STALE_TOKEN_ERRCODE`:** Renamed in `src/api/session-guard.ts` to more accurately describe the token-stale condition (the error code -14 indicates a stale/expired token, not a session expiry). All references in `monitor.ts` and tests updated.
- **Error logging improvements:**
  - `getUpdates` errors in `monitor.ts` now include `classifyFetchError` classification (type, description, code).
  - Removed duplicate `errLog` lines in `monitor.ts`; only `aLog.error` remains.
  - CDN upload failure logs (`cdn-upload.ts`) now include redacted URL and error cause.
  - `downloadRemoteImageToTemp` (`upload.ts`) now logs detailed fetch network errors with cause.
  - API GET/POST fetch failures (`api.ts`) now log redacted URL, timeout, and error classification.
- **Minimum host version bumped:** `peerDependencies.openclaw` and `install.minHostVersion` raised from `>=2026.3.22` to `>=2026.5.12`.

### Added (Dev/Engineering)

- **`outbound-hooks.test.ts`:** New test file covering `applyWeixinMessageSendingHook` (no hooks, content modification, cancellation, error recovery) and `emitWeixinMessageSent` (no hooks, success, failure with fire-and-forget) scenarios.

### Fixed

- **`pairing.test.ts` mock path:** `vi.mock` target corrected from `"openclaw/plugin-sdk"` to `"openclaw/plugin-sdk/infra-runtime"`.
- **`api.test.ts` sendMessage mock response:** Success test case mock now returns `"{}"` instead of `""`, matching the updated `sendMessage` logic that parses the response body.

## [2.4.4] - 2026-05-22

### Added

- **Tool-call progress messages:** `WeixinReplyProgressSender` sends `TOOL_CALL_START` / `TOOL_CALL_RESULT` progress messages when the model executes tools. Configurable via the `replyProgressMessages` channel option (default: `true`).
- **Abort signal support for in-flight requests:** `apiPostFetch` / `getUpdates` now accept an external `AbortSignal`. When the gateway stops or hot-reloads a channel, the in-flight long-poll is cancelled immediately instead of waiting for the server-side timeout.

## [2.4.3] - 2026-05-08

### Fixed

- **`iLink-App-Id` / `iLink-App-ClientVersion` headers were empty / `0` in production.** `readPackageJson` resolved `package.json` via a fixed `../../` from `import.meta.url`, but the TypeScript build (with `index.ts` plus `src/**/*.ts` in `tsconfig.include`) emits `dist/src/api/api.js` (extra `src/` segment), so the resolved path landed on the non-existent `dist/package.json` and the catch returned `{}`. Replaced with a walk-up that searches for the plugin's own `package.json` (validated by `name` containing `openclaw-weixin` or by the presence of `ilink_appid`), tolerating both dev (`src/api/`) and built (`dist/src/api/`) layouts. Adds tests in `src/api/api.test.ts` covering the compiled layout, dev layout, nested `node_modules/<dep>/package.json` shadowing, missing manifest, and malformed manifest.
- **`openclaw channels login` exited non-zero when the bot was already bound to this OpenClaw**, which caused automated installers (e.g. `openclaw-weixin-installer`) to report a misleading "首次连接未完成" message and continue past a successful state. The QR poller now returns `alreadyConnected: true` for the server's `binded_redirect` status, and `auth.login` in `channel.ts` treats it as a successful no-op (no save, no throw) so the CLI exits cleanly.

## [2.4.2] - 2026-05-07

### Fixed

- **Node 24 / undici compatibility — `TypeError: fetch failed` on every request.** Drop the manually-set `Content-Length` header from `buildHeaders`. The bundled undici in Node 24 rejects pre-set `Content-Length` with `UND_ERR_INVALID_ARG: invalid content-length header`, breaking all CGI calls. Letting `fetch` compute it from the request body restores network calls on Node 24.
- **OpenClaw ≥ 2026.5.x — Weixin runtime initialization timeout restart loop.** Replace the module-scope `pluginRuntime` global (and remove `src/runtime.ts` along with it) with the `ctx.channelRuntime` injected by the gateway per call. The previous global was set during plugin registration, but newer hosts inject a per-call runtime surface, so the global was missing/stale at startup and the channel kept timing out and restarting.

### Removed

- **Dead scripts and shims:** `scripts/test-full-upload.ts` / `scripts/test-upload-url.ts` debug scripts and the unused legacy `index.ts` re-exports. No behavior change for consumers.

## [2.4.1] - 2026-05-04

### Added

- **Ship compiled runtime in the npm tarball:** `dist/` is added to `files` and `package.json#openclaw.runtimeExtensions` is set to `["./dist/index.js"]`. The host loads the prebuilt JS entry directly instead of relying on source-only TypeScript at install time, which avoids the `requires compiled runtime output for TypeScript entry index.ts` error on stricter host versions.
- **`openclaw.plugin.json` channel config:** Declare `channels` and `channelConfigs` in `openclaw.plugin.json` so newer hosts (≥ 2026.4.x) can render the channel selection UI without falling back to `package.json#openclaw`.

## [2.3.1] - 2026-04-28

### Added

- **`bot_agent` request field:** Outgoing CGI requests now carry an upstream-app-supplied `bot_agent` (UA-style `name/version (comment)` grammar, multi-product allowed). Configurable per upstream app via channel config and sanitized by `sanitizeBotAgent` in `src/api/api.ts`; falls back to `OpenClaw` when missing or invalid.
- **`local_token_list` on QR fetch:** `fetchQRCode` now posts the most recent local `bot_token`s (up to 10), enabling the server to recognize already-bound bots and reply with `binded_redirect` instead of issuing a duplicate session.
- **Pair-code login flow:** Support entering a pair-code (`verify_code`) when the QR scan triggers a server-side challenge; `waitForWeixinLogin` handles `need_verifycode` / `verify_code_blocked` states with a stdin prompt and bounded retries.
- **`binded_redirect` handling:** New status branch in QR polling that prints `✅ 已连接过此 OpenClaw，无需重复连接。` and returns gracefully when the scanned bot is already bound to this OpenClaw.
- **Connection status notify (start/stop):** Emit `notifyStart` from `gateway.startAccount` (after the provider is announced) and `notifyStop` from a new `gateway.stopAccount` hook, so the upstream Weixin server can reconcile per-account online state.

### Changed

- **QR login UX:** Reword the QR/scan prompts and remove the client-side timeout from `fetchQRCode` / `startWeixinLoginWithQr` — only server / stack limits now bound the long-poll.

## [2.1.10] - 2026-04-24

### Added

- **Connection status notify (start/stop) — initial introduction:** `notifyStart` on account startup and `notifyStop` on shutdown via the new `gateway.stopAccount` hook. (Carried into the 2.3.x line as well.)

## [2.1.9] - 2026-04-20

### Added

- **Outbound hook support:** Add `message_sending` (pre-send interception/modification) and `message_sent` (post-send notification) hook integration for all outbound paths — `sendText`, `sendMedia`, and the inbound-reply `deliver` in `process-message`. Hook logic is extracted into a shared `src/messaging/outbound-hooks.ts` module.

### Changed

- **Cleanup:** Remove unused `mediaUrl` parameter from `sendWeixinOutbound` signature.

## [2.1.8] - 2026-04-07

### Changed

- **Markdown filter:** `StreamingMarkdownFilter` now preserves more Markdown constructs in outbound text.

## [2.1.7] - 2026-04-07

### Fixed

- **Plugin registration re-entrance:** Lazy-import `monitorWeixinProvider` inside `startAccount` in `channel.ts` to avoid pulling in the monitor → process-message → command-auth chain at plugin registration time, which could re-enter the plugin/provider registry before the account starts.
- **Initialization side effect:** Lazy-import `resolveSenderCommandAuthorizationWithRuntime` / `resolveDirectDmAuthorizationOutcome` in `process-message.ts` to prevent `ensureContextWindowCacheLoaded` from being triggered during module initialization, which caused `loadOpenClawPlugins` re-entrance.

### Changed

- **Tool-call outbound path:** `sendWeixinOutbound` now applies `StreamingMarkdownFilter` to the outbound text, consistent with the model-output path in `process-message`.

## [2.1.4] - 2026-04-03

### Changed

- **QR login:** Remove client-side timeout for `get_bot_qrcode`; the request is no longer aborted on a fixed deadline (server / stack limits still apply).

## [2.1.3] - 2026-04-02

### Added

- **`StreamingMarkdownFilter`** (`src/messaging/markdown-filter.ts`): outbound text no longer runs through whole-string `markdownToPlainText` stripping; a streaming character filter replaces it, so Markdown goes from **effectively unsupported** to **partially supported**.

### Changed

- **Outbound text path:** `process-message` uses `StreamingMarkdownFilter` (`feed` / `flush`) per deliver chunk instead of `markdownToPlainText`.

### Removed

- **`markdownToPlainText`** from `src/messaging/send.ts` (and its tests from `send.test.ts`); coverage moves to `markdown-filter.test.ts`.

## [2.1.2] - 2026-04-02

### Changed

- **Config reload after login:** On each successful Weixin login, bump `channels.openclaw-weixin.channelConfigUpdatedAt` (ISO 8601) in `openclaw.json` so the gateway reloads config from disk, instead of writing an empty `accounts: {}` placeholder.
- **QR login:** Increase client timeout for `get_bot_qrcode` from 5s to 10s.
- **Docs:** Uninstall instructions now use `openclaw plugins uninstall @tencent-weixin/openclaw-weixin` (aligned with the plugins CLI).
- **Logging:** `debug-check` log line no longer includes `stateDir` / `OPENCLAW_STATE_DIR`.

### Removed

- **`openclaw-weixin` CLI subcommands** (`src/weixin-cli.ts` and registration in `index.ts`). Use the host `openclaw plugins uninstall …` flow instead.

### Fixed

- Resolves the **dangerous code pattern** warning when installing the plugin on **OpenClaw 2026.3.31+** (host plugin install / static checks).
