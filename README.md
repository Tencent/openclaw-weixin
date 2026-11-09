# OpenClaw Weixin Channel

[![CI](https://github.com/Tencent/openclaw-weixin/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Tencent/openclaw-weixin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tencent-weixin/openclaw-weixin)](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
[![Node.js](https://img.shields.io/node/v/@tencent-weixin/openclaw-weixin)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

[简体中文](./README.zh_CN.md)

OpenClaw's Weixin channel plugin. Connect an OpenClaw Gateway to Weixin with QR-code login and receive and send messages through the Weixin backend.

For the product changes, merged work, and upgrade considerations in the binding and message-processing update, see the [Weixin plugin binding and message-processing release notes (3.0.0-beta-0 prerelease, Simplified Chinese)](./docs/release-notes-bot-realname-auth_zh_CN.md).

## Highlights

- QR-code login with automatic credential storage.
- Multiple Weixin accounts on one OpenClaw Gateway.
- Text, image, voice, file, and video messages.
- Long-poll message delivery and typing indicators.
- OpenClaw channel routing, pairing, and session isolation.

## Requirements

| Component | Requirement |
| --- | --- |
| Node.js | `>=22.13.0` |
| OpenClaw runtime check | `>=2026.3.22` |
| npm peer dependency | `>=2026.5.12` |

Use OpenClaw `>=2026.5.12` when possible. The runtime guard currently accepts `>=2026.3.22`; npm installations using strict peer-dependency validation require the peer-dependency version.

OpenClaw must be installed and the `openclaw` CLI must be available. See the [OpenClaw installation guide](https://docs.openclaw.ai/install).

```bash
openclaw --version
```

## Quick start

### 1. Install the plugin

```bash
npx -y @tencent-weixin/openclaw-weixin-cli install
```

If the installer is not suitable for your environment, install the plugin directly:

```bash
openclaw plugins install "@tencent-weixin/openclaw-weixin"
```

### 2. Enable the plugin

```bash
openclaw config set plugins.entries.openclaw-weixin.enabled true
```

### 3. Log in with Weixin

```bash
openclaw channels login --channel openclaw-weixin
```

Scan the QR code with Weixin and confirm the authorization. Credentials are stored locally after a successful login.

### 4. Restart and verify the Gateway

```bash
openclaw gateway restart
openclaw channels status
```

## Configuration

### Multiple accounts

Run the login command again for each account:

```bash
openclaw channels login --channel openclaw-weixin
```

When multiple accounts are logged in, isolate direct-message sessions by account, channel, and peer:

```bash
openclaw config set session.dmScope per-account-channel-peer
```

### Bind-ticket endpoint

The default URL is `https://weixin110.qq.com/security/acct/botrealnameverifycgi` (port 443). Set `channels.openclaw-weixin.acctwebBaseUrl` only when the origin itself changes. A per-account `accounts.<accountId>.acctwebBaseUrl` overrides the channel value.

To send those requests through an HTTP proxy, set `channels.openclaw-weixin.acctwebProxy`. The request target stays the origin above. Only the bind-ticket fetch and status query use this proxy. A per-account `accounts.<accountId>.acctwebProxy` overrides the channel value.

```bash
openclaw config set 'channels["openclaw-weixin"].acctwebProxy' '"http://proxy.example:8088"' --strict-json
```

When `channels.openclaw-weixin.routeTag` is set, every Weixin API request adds `_cradle_hostname=g<routeTag>`. A route tag of `10086` sends `_cradle_hostname=g10086`.

`channels.openclaw-weixin.promptBindOwner` is off by default. Login then shows the bot bind QR immediately. Set it to `true` to ask whether this OpenClaw connects to the operator's own WeChat ClawBot: Enter or Y shows the bind QR, and N completes real-name authorization first.

```bash
openclaw config set 'channels["openclaw-weixin"].promptBindOwner' true --strict-json
```

### Force the phone PIN

`channels.openclaw-weixin.verifyPin` is off by default. Set it to `true` and the bind QR request includes `bot_spam_business_data`, asking security to require the phone PIN. A normal login omits the field. Whether the phone actually shows the PIN is decided later by `need_verifycode` on `get_qrcode_status`. The QR response does not decide it.

`openclaw channels login` does not accept `--verify-pin`. That option never reaches the Weixin plugin.

#### Test a PIN bind

Use these steps in a test environment to confirm that the plugin requests PIN verification when acquiring the bind QR code.

1. Install a plugin build that logs the full QR request body. The current prerelease package is `3.0.0-beta-0`. From the plugin directory, build, pack, and replace the installed plugin:

```bash
npm run build
npm pack
openclaw plugins install ./tencent-weixin-openclaw-weixin-3.0.0-beta-0.tgz --force
openclaw plugins list
```

`openclaw-weixin` in that list must show Version `3.0.0-beta-0`. If the Gateway is already running, restart it so it does not keep an older plugin in memory:

```bash
openclaw gateway restart
```

2. Turn on the test route and the forced PIN. With `routeTag` set to `10086`, the QR request goes to `https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3&_cradle_hostname=g10086` and is handled by `GetBotQrcodeCgi` in `ilinkbotlogicsvr`. The body includes `bot_spam_business_data` only when `verifyPin` is `true`. For a self bind, leave `promptBindOwner` off so login skips real-name authorization and omits `bot_spam_ticket`. `acctwebProxy` proxies only the real-name CGI and does not change the QR host.

```bash
openclaw config set 'channels["openclaw-weixin"].routeTag' 10086 --strict-json
openclaw config set 'channels["openclaw-weixin"].verifyPin' true --strict-json
openclaw config set 'channels["openclaw-weixin"].promptBindOwner' false --strict-json
```

To force the PIN for one login without changing `verifyPin`, set `routeTag` first, then:

```bash
OPENCLAW_WEIXIN_VERIFY_PIN=1 openclaw channels login --channel openclaw-weixin
```

3. Log in. Do not pass `--verify-pin`:

```bash
openclaw channels login --channel openclaw-weixin
```

4. Read that day's log, `/tmp/openclaw/openclaw-YYYY-MM-DD.log`:

```bash
grep 'fetchQRCode: body=' /tmp/openclaw/openclaw-YYYY-MM-DD.log
```

The check passes when that body contains `"bot_spam_business_data":"eyJ2ZXJpZnlfcGluIjoxfQ=="`, the standard base64 of `{"verify_pin":1}`. The same stretch of log also has `fetchQRCode: bot_spam_business_data.verify_pin=1`, then `QR code received`. The older `POST ... body=` line keeps only the first 200 characters, so the field is past the cut. Do not use that line. A normal login logs `fetchQRCode: omit bot_spam_business_data`.

5. Turn the forced PIN off after the test:

```bash
openclaw config set 'channels["openclaw-weixin"].verifyPin' false --strict-json
```

### Custom BotAgent

Set an optional identifier for backend log attribution and monitoring:

```json
{
  "channels": {
    "openclaw-weixin": {
      "botAgent": "MyBot/1.2.0"
    }
  }
}
```

`botAgent` is used for observability only. It is not an authentication credential and does not control message routing.

**Format** (UA-style):

- One or more `Name/Version` tokens, space-separated
- Each token may optionally be followed by ` (comment)`
- ASCII only; total length ≤ 256 bytes
- Invalid tokens are silently dropped during sanitization; falls back to
  `OpenClaw` if nothing valid remains

Examples that pass through unchanged:

- `MyBot/1.2.0`
- `MyBot/1.2.0 (region=cn;env=prod)`
- `MyBot/1.2.0 LangChain/0.3.5`
- `MyBot/1.2.0-rc.1+build.5`

**Note**: `bot_agent` is for observability only — it is not used for
authentication or routing. All registered agents on this plugin instance
currently share the same `botAgent` declaration; per-agent overrides may be
added in a future version if needed.

### Inbound message batching

By default every inbound message gets its own reply. To merge messages that a user sends in quick succession, set an image batching window (milliseconds):

```bash
openclaw config set messages.inbound.byChannel.openclaw-weixin 3000
```

A window that is too short can split a multi-image send into two turns, while a longer one only delays image-only sends, so err on the longer side; around 3 seconds tolerates slower uploads on mobile networks. Text and voice never wait on this window: one arriving while images are pending joins them and dispatches at once. So if users often send images first and type or speak a few seconds later, set it to 30–60 seconds; the cost is that image-only sends wait the full window before a reply starts. `messages.inbound.debounceMs` is used as a fallback; `0` or unset keeps the default one-reply-per-message behavior. Restart the Gateway after changing it. When enabled, per sender:

- While idle, text, files, video, voice, and quoted replies are processed immediately.
- Images wait until no new image arrives within the window, so a multi-image send becomes a single turn. Any other message arriving inside the window joins the batch and flushes it.
- Everything that arrives while a reply is still running is merged into one follow-up turn: texts are joined, all attachments are downloaded, and quoted replies are rendered inline as text.
- Slash commands always run as their own turn, in arrival order.

Attachments are downloaded in the arrival order of the original messages and in the attachment order within each message, then passed to the Agent in that same order, without regrouping them by type such as images or videos. Batching affects only the current reply turn; the quote cache still stores the body and all attachments under each original message ID. Managed attachments are temporarily protected from cleanup as soon as they are written to disk. This protection is released after completion, failure, or cancellation, after which the existing cache cleanup policy applies.

Attachments in a batch are prepared separately for each original Weixin message. If downloading, decrypting, or saving an attachment fails, only that message fails; the remaining messages are still batched and passed to the Agent in their original order. The failed message's body, quotes, and incomplete attachments are excluded from the turn. If an original message has multiple attachments, failure of any attachment fails the entire message. Successfully downloaded attachments from the other messages are reused without downloading them again.

Inbox records are updated separately for failed messages. The remaining messages are marked as processing only immediately before they enter the Agent; explicit cancellation still preserves messages that have not started execution so they can be recovered after a restart. Partial-failure notices are sent only when `errorNotices` is explicitly enabled, and only after the remaining messages have been processed. If the batched Agent execution fails, the entire turn is treated as failed; it is not automatically split up and retried.

### Message recovery on stop and reload

The plugin atomically saves original inbound messages together with the polling cursor in the account's `accounts/<accountId>.sync.json`. This is independent of the quote cache and requires no additional setting. Messages remain pending during configuration preparation, attachment downloads, the image batching window, and queueing. On stop, the plugin cancels in-flight operations, clears batching timers, and waits for processing to finish without forcing queued messages to dispatch. After a restart, it requeues saved messages in their original receive order before accepting new messages. Batching remains isolated by sender, and commands retain their original order.

Before an Agent or local command starts executing, the plugin persists the processing state. It removes the original record after successful completion or a definite failure; failure of one message does not stop later messages. Records interrupted by a stop or process exit during execution are retained as interrupted. Their count is logged on startup, and they are not automatically retried, to avoid duplicate tool calls or message sends. To continue, first verify the execution result, then resend the request. If a write fails or the state file is corrupt, processing stops for that account and existing files are preserved for recovery; the plugin does not skip records and advance the cursor.

When an original message ID is available, deduplication uses the account, sender, and message ID. Pending and interrupted records continue to participate in deduplication; the most recent 10,000 completed message IDs are retained. Input without a message ID can still be recovered locally, but duplicate delivery from the server cannot be reliably detected. This mechanism does not guarantee exactly-once execution of external tools or message sends. A crash between persisting the processing state and making the actual call, or a persistence failure that prevents restoring the pending state, also conservatively leaves the record interrupted and requires manual verification.

The state file contains the original content of pending and interrupted messages, has permissions `0600`, and is backed up with the normal account state. Quote-cache size limits and expiration cleanup do not affect it. Original content is deleted after success or a definite failure; interrupted content is retained for verification. Older cursor-only files are migrated automatically, but messages already lost before upgrading cannot be recovered. Avoid downgrading to an older plugin version that still overwrites this file.

### Error notices and media downloads

If an inbound message fails, the plugin logs the error and continues processing the other messages in the batch. User-facing error notices are off by default and are sent only when `channels.openclaw-weixin.errorNotices: true` is explicitly set. Notices created by this version also check the setting before delivery resumes. Normal message replies are unaffected by this setting.

```bash
openclaw config set 'channels["openclaw-weixin"].errorNotices' true --strict-json
```

The current host interface cannot reliably identify unmarked notices that entered the host queue before the upgrade, so their delivery may still resume. Disabling the setting stops the plugin from actively resuming them, but cannot guarantee that the host's own recovery will be blocked.

Downloads of inbound attachments and outbound remote media have no total duration limit by default. They may run for more than 30 seconds as long as data keeps arriving, but are still interrupted after more than 30 seconds waiting for a response or receiving no data. Configure these two independent limits, in milliseconds, under `channels.openclaw-weixin.mediaDownload`:

| Setting | Default | Meaning |
| --- | ---: | --- |
| `timeoutMs` | `0` | Total download timeout, including waiting for the response and reading the body; `0` means no total duration limit. |
| `idleTimeoutMs` | `30000` | Maximum wait for a response or interval without valid data; must be greater than `0`. Resets when response headers or nonempty data arrive. |

For example, allow an unlimited total duration and up to 60 seconds without incoming data:

```bash
openclaw config set 'channels["openclaw-weixin"].mediaDownload' '{"timeoutMs":0,"idleTimeoutMs":60000}' --strict-json
```

To limit the total duration to 10 minutes, set `timeoutMs` to `600000`. These settings do not change Bot API request timeouts; stopping or reloading the channel can still cancel inbound downloads in progress. Restart the Gateway after changing them.

## Local quote cache

Newer WeChat clients may send only a server message ID for a quoted message. The plugin
stores the required text and media metadata locally so later quotes can restore their
context. The cache is enabled by default and failures do not interrupt normal message
delivery.

For quoted attachments, the plugin reuses an available local cache entry before attempting a download. If downloading an old attachment fails, it tells the Agent that the quoted attachment is temporarily unavailable, while still processing the current message body normally and without sending a failure notice for the entire request. This also applies to batched messages. Failures when downloading the current message's own attachments, and explicit cancellation, continue to follow the existing rules.

Configure it under `channels.openclaw-weixin.quoteCache` when you need different
retention or size limits. The default limits are 30 days and 10,000 text records per
account, plus 7 days, 256 MiB per account, and 25 MiB per media file.

By default, media stays in the existing plugin-managed directory under OpenClaw's `inbound` tree. You can also use the shared `inbound` directory directly or configure a separate directory outside `inbound`. The first two options may be affected by OpenClaw's general media cleanup, so ensure its retention period meets your quoting needs.

See the
[local quote cache guide](./docs/quote-cache_zh_CN.md) for the complete configuration,
storage behavior, and validation details.

## Uninstall

```bash
openclaw plugins uninstall @tencent-weixin/openclaw-weixin
```

## Troubleshooting

### The plugin reports an unsupported OpenClaw version

Check the host version:

```bash
openclaw --version
```

Upgrade OpenClaw to a supported version, then restart the Gateway.

### The channel shows `OK` but does not connect

Make sure the plugin is enabled and restart the Gateway:

```bash
openclaw config set plugins.entries.openclaw-weixin.enabled true
openclaw gateway restart
```

If the problem persists, inspect the Gateway log and verify that the account has completed QR-code login.

## Documentation

| Need | Start here |
| --- | --- |
| Backend integration | [Weixin backend API protocol](./docs/protocol.md) |
| CI and local quality checks | [CI guide](./docs/ci.md) |
| Development and local validation | [Development guide](./docs/development.md) |
| OpenClaw channel configuration | [OpenClaw channels](https://docs.openclaw.ai/channels) |
| Release history | [CHANGELOG.md](./CHANGELOG.md) |

The backend protocol document is intended for developers implementing or integrating a compatible backend. It is not required for normal plugin installation.

## Development

This repository uses npm and requires Node.js `>=22.13.0`.

```bash
npm ci --ignore-scripts --include=dev
npm run ci
```

Run coverage separately when changing behavior or tests:

```bash
npm run test:coverage
```

Pull requests run the same quality, unit-test, coverage, build, and package smoke checks in GitHub Actions. See the [CI guide](./docs/ci.md) for details.

See the [development guide](./docs/development.md) for the complete worktree, dependency, packaging, and local installation workflow.

## Contributing

Bug reports, documentation improvements, tests, and code contributions are welcome. Please keep pull requests focused and include validation details. For changes to the backend integration, update the [protocol documentation](./docs/protocol.md) together with the implementation.

## Maintainer

If you run into a problem or have a question, feel free to contact me through [GitHub](https://github.com/zengyi1001). My profile includes email and WeChat contact information.

## License

[MIT](./LICENSE)
