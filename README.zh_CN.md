# OpenClaw 微信渠道

[![CI](https://github.com/Tencent/openclaw-weixin/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Tencent/openclaw-weixin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tencent-weixin/openclaw-weixin)](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
[![Node.js](https://img.shields.io/node/v/@tencent-weixin/openclaw-weixin)](https://nodejs.org/)
[![许可证](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

[English](./README.md)

OpenClaw 的微信渠道插件。通过扫码登录将 OpenClaw Gateway 连接到微信，并通过微信后端收发消息。

本次绑定流程与消息处理升级的产品变化、合入内容及升级注意事项，见[微信插件绑定与消息处理升级说明（3.0.0-beta-0 预发布）](./docs/release-notes-bot-realname-auth_zh_CN.md)。

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
| npm 同级依赖 | `>=2026.5.12` |

建议尽量使用 `OpenClaw >=2026.5.12`。当前运行时兼容检查接受 `>=2026.3.22`；如果 npm 使用严格的同级依赖校验，则需要满足同级依赖要求的版本。

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

`channels.openclaw-weixin.promptBindOwner` 默认关闭。关闭时登录直接弹出 bot 绑定二维码。设为 `true` 后，终端会询问是否连到本人的微信 ClawBot：回车或 Y 直接出绑定码，N 先完成实名授权再出绑定码。

```bash
openclaw config set 'channels["openclaw-weixin"].promptBindOwner' true --strict-json
```

### 强制弹出手机 Pin

`channels.openclaw-weixin.verifyPin` 默认关闭。设为 `true` 后，取绑定二维码会带上 `bot_spam_business_data`，要求这次绑定弹出手机 Pin。普通登录不带这个字段。手机上是否真的弹出 Pin，仍由安全侧在 `get_qrcode_status` 里用 `need_verifycode` 决定，取码响应本身不决定。

`openclaw channels login` 不接受 `--verify-pin`。这个参数到不了微信插件。

#### 在现网测试 PIN 校验与绑定

使用正常的微信服务，通过以下功能开关测试对应绑定流程。

1. 安装支持 `verifyPin` 和 `promptBindOwner` 的插件版本。例如，从 npm 安装 `3.0.0-beta-0` 预发布包，检查已安装版本，并重启 Gateway 以加载插件：

```bash
openclaw plugins install "@tencent-weixin/openclaw-weixin@3.0.0-beta-0" --force
openclaw plugins list
openclaw gateway restart
```

2. 测试绑定本人的微信 ClawBot 时的 PIN 校验，打开 `verifyPin`，保持 `promptBindOwner` 关闭，然后登录：

```bash
openclaw config set 'channels["openclaw-weixin"].verifyPin' true --strict-json
openclaw config set 'channels["openclaw-weixin"].promptBindOwner' false --strict-json
openclaw channels login --channel openclaw-weixin
```

使用微信扫描绑定二维码。如果手机显示 PIN，且终端提示输入，请输入该 PIN 继续。是否需要 PIN 校验由后端通过二维码状态响应决定；打开开关表示主动请求校验，并不代表手机一定已经显示 PIN。登录命令不要加 `--verify-pin`。

如果只对一次登录开启校验，无需持久修改配置，可保持 `verifyPin` 未设置或为 `false`，再执行：

```bash
OPENCLAW_WEIXIN_VERIFY_PIN=1 openclaw channels login --channel openclaw-weixin
```

3. 测试绑定对象选择时，打开 `promptBindOwner`，再执行登录：

```bash
openclaw config set 'channels["openclaw-weixin"].promptBindOwner' true --strict-json
openclaw channels login --channel openclaw-weixin
```

回车或选择 Y，直接绑定本人的微信 ClawBot。测试绑定他人的 ClawBot 时，再次执行登录，选择 N，按照提示完成实名授权后，再扫描绑定二维码。两种流程中的 PIN 请求都由 `verifyPin` 独立控制。若配置了 `acctwebProxy`，它只代理实名授权请求，不改变绑定二维码接口地址。

4. 如需确认插件已请求 PIN 校验，可在当天日志中检查简短的请求标记：

```bash
grep 'fetchQRCode: bot_spam_business_data.verify_pin=1' /tmp/openclaw/openclaw-YYYY-MM-DD.log
```

该标记只确认请求开关，不代表手机端的校验结果。`verifyPin` 关闭且没有单次登录覆盖时，插件会记录 `fetchQRCode: omit bot_spam_business_data`。

5. 测试后将两个开关恢复为默认值，或恢复到测试前的配置：

```bash
openclaw config set 'channels["openclaw-weixin"].verifyPin' false --strict-json
openclaw config set 'channels["openclaw-weixin"].promptBindOwner' false --strict-json
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

附件按原消息的到达顺序、以及每条消息内部的附件顺序下载，并按相同顺序交给 Agent，不再按图片、视频等类型调整顺序。合并只影响当前回复轮次；引用缓存仍按每条原消息的 ID 保存正文及全部附件。处理中的受管附件从落盘开始受到临时保护，正常结束、失败或取消后释放，再按原有缓存策略清理。

合并批次按微信原始消息分别准备附件。某一条下载、解密或保存失败时，只结束这一条，其他正常消息仍按原顺序合并交给 Agent；失败消息的正文、引用及残缺附件不进入本轮输入。单条原始消息有多个附件时，其中任一附件失败则整条消息失败。已成功下载的正常附件直接复用，不重复下载。

失败消息单独更新收件记录，正常消息仅在进入 Agent 前标记为处理中；主动取消仍保留尚未执行的正常消息供重启恢复。部分失败提示只在 `errorNotices` 显式开启时发送，并在正常消息处理后发送。合并后的 Agent 执行失败仍按整轮失败处理，不自动拆开重跑。

### 停止与重载时的消息恢复

插件把原始入站消息和轮询游标一起原子保存到账号的 `accounts/<accountId>.sync.json`，独立于引用缓存，无需开启额外开关。配置准备、附件下载、图片合并窗口及队列中的消息保持待处理状态；停止时取消在途操作，清理合并计时器并等待处理收尾，不再强制派发队列。重启后先按原接收顺序重新入队，再接收新消息；合并仍按发送人隔离，命令保持原顺序。

Agent 或本地命令开始执行前会先落盘“处理中”状态。正常完成或明确失败后移除原始记录；单条失败继续处理后面的消息。执行期间停止或进程退出的记录保留为“已中断”，启动时在日志中报告数量，不自动重跑，避免重复工具调用或发送消息；需要继续时请先核实执行结果，再重新发送请求。写入失败或状态文件损坏时停止该账号处理，保留已有文件供恢复，不跳过记录继续推进游标。

有原始消息 ID 时，按账号、发送人和消息 ID 去重；待处理及已中断记录持续参与去重，已结束消息保留最近 10000 个 ID。没有消息 ID 的输入仍可从本地恢复，但无法可靠识别服务端重复投递。本机制不能保证外部工具或消息发送恰好执行一次。如果在写入“处理中”和实际调用之间崩溃，或持久化故障导致无法回写待处理状态，也会保守地保留为已中断，需要人工核实。

状态文件包含待处理及已中断消息原文，文件权限为 `0600`，随正常账号状态一起备份；它不受引用缓存的容量及过期清理影响。成功或明确失败后删除对应原文，已中断原文保留供核实。旧版只有游标的文件会自动迁移；升级前已经丢失的消息无法补回。请避免降级到仍会覆盖该文件的旧版插件。

### 失败提示与媒体下载

单条入站消息处理失败后，插件会记录错误并继续处理同批次中的其他消息。给用户发送失败提示默认关闭；只有显式设置 `channels.openclaw-weixin.errorNotices: true` 才会发送。本版本创建的提示在恢复发送前也会检查开关。正常消息回复不受该开关影响。

```bash
openclaw config set 'channels["openclaw-weixin"].errorNotices' true --strict-json
```

升级前已进入宿主队列、且没有通知标记的提示，当前宿主接口无法可靠识别，仍可能恢复发送；关闭开关会停止插件主动恢复它们，但不能保证拦截宿主自己的恢复。

入站附件及出站远程媒体下载默认不限制总时长，只要持续收到数据，就可以下载超过 30 秒；等待响应或连续没有收到数据超过 30 秒时仍会中断。可在 `channels.openclaw-weixin.mediaDownload` 配置这两个独立时限，单位为毫秒：

| 配置项 | 默认值 | 含义 |
| --- | ---: | --- |
| `timeoutMs` | `0` | 总下载时限，包含等待响应和读取正文；`0` 表示不限制总时长。 |
| `idleTimeoutMs` | `30000` | 等待响应或连续没有收到有效数据的最长时间，必须大于 `0`；收到响应头或非空数据后重新计时。 |

例如，总时长不限制，并允许连续等待数据最多 60 秒：

```bash
openclaw config set 'channels["openclaw-weixin"].mediaDownload' '{"timeoutMs":0,"idleTimeoutMs":60000}' --strict-json
```

要限制总时长为 10 分钟，把 `timeoutMs` 设为 `600000`。这些配置不改变 Bot API 的请求时限；通道停止或重载仍可主动取消进行中的入站下载。修改后重启 Gateway。

## 引用消息本地缓存

新版微信客户端可能只在引用消息中提供服务端消息 ID。插件会在本地保存必要的文本和媒体元数据，
以便后续引用消息还原上下文。缓存默认开启，缓存故障不会中断正常消息收发。

引用旧附件时优先复用本地可用缓存；没有可用缓存才尝试下载。旧附件下载失败时，会向 Agent 标记引用附件暂不可用，当前消息的正文仍正常处理，也不会因此发送整条请求失败提示。此行为同样适用于合并消息；当前消息自身的附件下载失败和主动取消仍按原有规则处理。

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

### 渠道显示 `OK` 但没有连接

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
| OpenClaw 渠道配置 | [OpenClaw 渠道文档](https://docs.openclaw.ai/channels) |
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

拉取请求会在 GitHub Actions 中执行质量检查、单元测试、覆盖率、构建和 npm 包冒烟测试。详细说明见 [CI 指南](./docs/ci_zh_CN.md)。

从 Git 工作区创建、依赖安装到本地打包和插件安装的完整流程见[开发者指南](./docs/development_zh_CN.md)。

## 参与贡献

欢迎提交问题、改进文档、补充测试和贡献代码。请保持拉取请求聚焦，并附上验证结果。修改后端集成时，请同步更新[协议文档](./docs/protocol_zh_CN.md)。

## 维护者

如果你遇到问题或有任何疑问，欢迎通过 [GitHub 主页](https://github.com/zengyi1001) 联系我。主页上提供了邮箱、微信等联系方式。

## 许可证

[MIT](./LICENSE)
