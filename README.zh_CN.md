# OpenClaw 微信渠道

[![CI](https://github.com/Tencent/openclaw-weixin/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Tencent/openclaw-weixin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tencent-weixin/openclaw-weixin)](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
[![Node.js](https://img.shields.io/node/v/@tencent-weixin/openclaw-weixin)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

[English](./README.md)

OpenClaw 的微信渠道插件。通过扫码登录将 OpenClaw Gateway 连接到微信，并通过微信后端收发消息。

## 主要能力

- 扫码登录并自动保存登录凭证。
- 一个 OpenClaw Gateway 同时运行多个微信账号。
- 支持文本、图片、语音、文件和视频消息。
- 长轮询收取消息，并支持输入状态提示。
- 集成 OpenClaw 渠道路由、配对和会话隔离能力。

## 环境要求

| 组件 | 要求 |
| --- | --- |
| Node.js | `>=22` |
| OpenClaw 运行时检查 | `>=2026.3.22` |
| npm peer dependency | `>=2026.5.12` |

建议尽量使用 `OpenClaw >=2026.5.12`。当前运行时兼容检查接受 `>=2026.3.22`；如果 npm 使用严格的 peer dependency 校验，则需要满足 peer dependency 要求的版本。

必须先安装 OpenClaw，并确保 `openclaw` 命令可用。请参阅 [OpenClaw 安装指南](https://docs.openclaw.ai/install)。

```bash
openclaw --version
```

## 快速开始

### 1. 安装插件

```bash
npx -y @tencent-weixin/openclaw-weixin-cli install
```

如果当前环境不适合使用安装器，也可以直接安装插件：

```bash
openclaw plugins install "@tencent-weixin/openclaw-weixin"
```

### 2. 启用插件

```bash
openclaw config set plugins.entries.openclaw-weixin.enabled true
```

### 3. 使用微信扫码登录

```bash
openclaw channels login --channel openclaw-weixin
```

使用微信扫描二维码并确认授权。登录成功后，凭证会自动保存到本地。

### 4. 重启并检查 Gateway

```bash
openclaw gateway restart
openclaw channels status
```

## 配置

### 多账号

每个账号再次执行登录命令：

```bash
openclaw channels login --channel openclaw-weixin
```

同时登录多个账号时，建议按账号、渠道和对端隔离私聊会话：

```bash
openclaw config set session.dmScope per-account-channel-peer
```

### 自定义 BotAgent

可以设置一个用于后台日志归因和监控的标识：

```json
{
  "channels": {
    "openclaw-weixin": {
      "botAgent": "MyBot/1.2.0"
    }
  }
}
```

`botAgent` 仅用于观测，不是鉴权凭证，也不控制消息路由。

## 卸载

```bash
openclaw plugins uninstall @tencent-weixin/openclaw-weixin
```

## 故障排查

### 插件报告 OpenClaw 版本不受支持

检查宿主版本：

```bash
openclaw --version
```

将 OpenClaw 升级到受支持的版本，然后重启 Gateway。

### Channel 显示 `OK` 但没有连接

确认插件已启用，然后重启 Gateway：

```bash
openclaw config set plugins.entries.openclaw-weixin.enabled true
openclaw gateway restart
```

如果问题仍然存在，请检查 Gateway 日志，并确认账号已经完成扫码登录。

## 文档

| 需求 | 文档 |
| --- | --- |
| 后端对接 | [微信后端 API 协议](./docs/protocol_zh_CN.md) |
| CI 和本地质量检查 | [CI 指南](./docs/ci_zh_CN.md) |
| OpenClaw 渠道配置 | [OpenClaw Channels](https://docs.openclaw.ai/channels) |
| 发布历史 | [CHANGELOG.zh_CN.md](./CHANGELOG.zh_CN.md) |

后端协议文档面向实现或对接兼容后端的开发者，普通用户安装插件时不需要阅读。

## 开发

本项目使用 npm，并要求 Node.js `>=22`。

```bash
npm ci --ignore-scripts
npm run ci
```

修改功能或测试时，可以单独运行覆盖率检查：

```bash
npm run test:coverage
```

Pull Request 会在 GitHub Actions 中执行质量检查、单元测试、覆盖率、构建和 npm 包冒烟测试。详细说明见 [CI 指南](./docs/ci_zh_CN.md)。

## 参与贡献

欢迎提交问题、改进文档、补充测试和贡献代码。请保持 Pull Request 聚焦，并附上验证结果。修改后端集成时，请同步更新[协议文档](./docs/protocol_zh_CN.md)。

## License

[MIT](./LICENSE)
