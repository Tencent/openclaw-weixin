# OpenClaw Weixin Channel

[![CI](https://github.com/Tencent/openclaw-weixin/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Tencent/openclaw-weixin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tencent-weixin/openclaw-weixin)](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
[![Node.js](https://img.shields.io/node/v/@tencent-weixin/openclaw-weixin)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

[简体中文](./README.zh_CN.md)

OpenClaw's Weixin channel plugin. Connect an OpenClaw Gateway to Weixin with QR-code login and receive and send messages through the Weixin backend.

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

Use these steps to confirm, on the test route, that the plugin sends the forced PIN on the bind QR request. Do not publish this test package to the production npm registry.

1. Install a plugin build that logs the full QR request body. The current development package is `3.0.4`. From the plugin directory, build, pack, and replace the installed plugin:

```bash
npm run build
npm pack
openclaw plugins install ./tencent-weixin-openclaw-weixin-3.0.4.tgz --force
openclaw plugins list
```

`openclaw-weixin` in that list must show Version `3.0.4`. If the Gateway is already running, restart it so it does not keep an older plugin in memory:

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

## Local quote cache

Newer WeChat clients may send only a server message ID for a quoted message. The plugin
stores the required text and media metadata locally so later quotes can restore their
context. The cache is enabled by default and failures do not interrupt normal message
delivery.

Configure it under `channels.openclaw-weixin.quoteCache` when you need different
retention or size limits. The default limits are 30 days and 10,000 text records per
account, plus 7 days, 256 MiB per account, and 25 MiB per media file. See the
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
