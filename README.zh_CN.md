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
| Node.js | `>=22.13.0` |
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

### 绑定凭证接口地址

默认地址是 `https://weixin110.qq.com/security/acct/botrealnameverifycgi`（443）。需要更换源站时配置 `channels.openclaw-weixin.acctwebBaseUrl`。账号级 `accounts.<accountId>.acctwebBaseUrl` 优先于渠道级配置。

前面有 HTTP 代理时，把代理配到 `channels.openclaw-weixin.acctwebProxy`。请求目标仍是上面的源站，只有获取和查询绑定凭证会走这个代理。账号级 `accounts.<accountId>.acctwebProxy` 优先于渠道级配置。

```bash
openclaw config set 'channels["openclaw-weixin"].acctwebProxy' '"http://proxy.example:8088"' --strict-json
```

配置了 `channels.openclaw-weixin.routeTag` 时，所有微信接口请求都会带上 `_cradle_hostname=g<routeTag>`。例如 `routeTag` 为 `10086` 时，参数是 `_cradle_hostname=g10086`。

`channels.openclaw-weixin.promptBindOwner` 默认关闭。关闭时登录直接弹出 bot 绑定二维码。设为 `true` 后，终端会询问是否连到本人的微信 ClawBot：回车或 Y 直接出绑定码，N 先完成实名授权再出绑定码。

```bash
openclaw config set 'channels["openclaw-weixin"].promptBindOwner' true --strict-json
```

### 强制弹出手机 Pin

`channels.openclaw-weixin.verifyPin` 默认关闭。设为 `true` 后，取绑定二维码会带上 `bot_spam_business_data`，要求这次绑定弹出手机 Pin。普通登录不带这个字段，是否出 Pin 仍由安全侧决定。

`openclaw channels login` 不接受 `--verify-pin`。这个参数到不了微信插件。用上面的配置，或设置环境变量 `OPENCLAW_WEIXIN_VERIFY_PIN=1`。

1. 确认插件版本。列表里 `openclaw-weixin` 的 Version 需要是带这个配置的版本（当前开发包是 `3.0.3`）：

```bash
openclaw plugins list
```

2. 打开开关：

```bash
openclaw config set 'channels["openclaw-weixin"].verifyPin' true --strict-json
openclaw config get 'channels["openclaw-weixin"].verifyPin'
```

3. 登录。`channels login` 在当前命令里加载插件。Gateway 没在跑时，直接登录就会用到已安装的插件。Gateway 已经在跑、而且内存里还是旧插件时，先重启再登录：

```bash
openclaw gateway restart
openclaw channels login --channel openclaw-weixin
```

4. 看当天日志，例如 `/tmp/openclaw/openclaw-YYYY-MM-DD.log`。强制出 Pin 时有 `fetchQRCode: bot_spam_business_data.verify_pin=1`。请求体里的字段是 `{"verify_pin":1}` 的标准 base64：`eyJ2ZXJpZnlfcGluIjoxfQ==`。普通登录是 `fetchQRCode: omit bot_spam_business_data`。

5. 测完关掉：

```bash
openclaw config set 'channels["openclaw-weixin"].verifyPin' false --strict-json
```

也可以不改配置，只对这一次登录生效：

```bash
OPENCLAW_WEIXIN_VERIFY_PIN=1 openclaw channels login --channel openclaw-weixin
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

**格式规范**（UA 风格）：

- 一个或多个 `Name/Version` token，空格分隔
- 每个 token 可选地跟一个 ` (comment)`
- 仅允许 ASCII 字符；总长 ≤ 256 字节
- 不合规的 token 在清洗时静默丢弃；如果最终为空，回退到 `OpenClaw`

可直接使用的示例：

- `MyBot/1.2.0`
- `MyBot/1.2.0 (region=cn;env=prod)`
- `MyBot/1.2.0 LangChain/0.3.5`
- `MyBot/1.2.0-rc.1+build.5`

**注意**：`bot_agent` 仅用于观测，**不参与鉴权或路由**。当前本插件实例下所有
已注册的 agent 共享同一个 `botAgent` 声明；如有需要按 agent 单独标识的场景，
可在后续版本扩展配置。

### 连续消息合并

默认每条入站消息都单独回复一次。如需合并用户连续发送的消息，设置图片合并窗口（毫秒）：

```bash
openclaw config set messages.inbound.byChannel.openclaw-weixin 3000
```

窗口太短可能把一次发送的多张图片拆成两轮，太长只会让只发图片时的回复晚开始几秒，建议宁长勿短；3 秒左右可以容纳移动网络下较慢的上传。文字和语音不受这个窗口限制：图片等待期间一到达就与图片合并并立即发出。因此如果用户常先发图、隔一会儿再打字或说语音，可以设到 30–60 秒，代价是只发图片时要等满窗口才开始回复。未设置时回退到 `messages.inbound.debounceMs`；为 `0` 或未配置时保持逐条回复。修改后需重启 Gateway。启用后按发送人处理：

- 空闲时，文字、文件、视频、语音和引用回复立即处理。
- 图片在窗口内没有新图片到达后才处理，一次发送的多张图片合并为一轮；窗口内到达的其他消息并入这一批并立即发出。
- 回复进行中到达的所有消息，在本轮结束后合并为一轮：文字拼接，附件全部下载，引用回复以文字形式内联。
- `/` 命令始终单独成轮，保持到达顺序。

## 引用消息本地缓存

新版微信客户端可能只在引用消息中提供服务端消息 ID。插件会在本地保存必要的文本和媒体元数据，
以便后续引用消息还原上下文。缓存默认开启，缓存故障不会中断正常消息收发。

如需调整保留时间或空间限制，可配置 `channels.openclaw-weixin.quoteCache`。默认文本缓存保留 30 天、
每个账号最多 10,000 条；媒体缓存保留 7 天、每个账号最多 256 MiB、单个文件最多 25 MiB。
媒体默认沿用原有的插件受管目录（它仍位于 OpenClaw 的 inbound 树下）。也可直接使用通用 inbound 目录，或配置 inbound 之外的独立目录；前两种方式都可能受 OpenClaw 通用媒体清理影响，需自行确保清理期限符合引用需求。
完整配置、存储行为和验证说明见[引用消息本地缓存开发说明](./docs/quote-cache_zh_CN.md)。

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
| 开发与本地验证 | [开发者指南](./docs/development_zh_CN.md) |
| OpenClaw 渠道配置 | [OpenClaw Channels](https://docs.openclaw.ai/channels) |
| 发布历史 | [CHANGELOG.zh_CN.md](./CHANGELOG.zh_CN.md) |

后端协议文档面向实现或对接兼容后端的开发者，普通用户安装插件时不需要阅读。

## 开发

本项目使用 npm，并要求 Node.js `>=22.13.0`。

```bash
npm ci --ignore-scripts
npm run ci
```

修改功能或测试时，可以单独运行覆盖率检查：

```bash
npm run test:coverage
```

Pull Request 会在 GitHub Actions 中执行质量检查、单元测试、覆盖率、构建和 npm 包冒烟测试。详细说明见 [CI 指南](./docs/ci_zh_CN.md)。

从 worktree 创建、依赖安装到本地打包和插件安装的完整流程见[开发者指南](./docs/development_zh_CN.md)。

## 参与贡献

欢迎提交问题、改进文档、补充测试和贡献代码。请保持 Pull Request 聚焦，并附上验证结果。修改后端集成时，请同步更新[协议文档](./docs/protocol_zh_CN.md)。

## 维护者

如果你遇到问题或有任何疑问，欢迎通过 [GitHub 主页](https://github.com/zengyi1001) 联系我。主页上提供了邮箱、微信等联系方式。

## License

[MIT](./LICENSE)
