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
| Node.js | `>=22` |
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
| OpenClaw channel configuration | [OpenClaw channels](https://docs.openclaw.ai/channels) |
| Release history | [CHANGELOG.md](./CHANGELOG.md) |

The backend protocol document is intended for developers implementing or integrating a compatible backend. It is not required for normal plugin installation.

## Development

This repository uses npm and requires Node.js `>=22`.

```bash
npm ci --ignore-scripts
npm run ci
```

Run coverage separately when changing behavior or tests:

```bash
npm run test:coverage
```

Pull requests run the same quality, unit-test, coverage, build, and package smoke checks in GitHub Actions. See the [CI guide](./docs/ci.md) for details.

## Contributing

Bug reports, documentation improvements, tests, and code contributions are welcome. Please keep pull requests focused and include validation details. For changes to the backend integration, update the [protocol documentation](./docs/protocol.md) together with the implementation.

## License

[MIT](./LICENSE)
