# Changelog

[简体中文](CHANGELOG.zh_CN.md)

This project follows the [Keep a Changelog](https://keepachangelog.com/) format.

## [2.4.8] - 2026-07-16

### Added

- **Group chat support:** Route Webox `group_id` / `@chatroom` conversations, sessions, context tokens, and replies by group while preserving the member identity in `SenderId`.

### Security

- Keep plugin-local slash commands and direct-message route metadata isolated from group traffic; group replies also skip direct-user typing configuration.

## [2.4.7] - 2026-07-12

### Changed

- Published the fork as `@netcat-ai/openclaw-weixin`.
- Added channel- and account-level `baseUrl` configuration for custom iLink backends; account configuration takes precedence over channel configuration and saved credentials.
- QR login and QR refresh now use the resolved account base URL instead of the fixed Tencent endpoint.

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
