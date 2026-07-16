# 变更日志

[English](CHANGELOG.md)

本项目遵循 [Keep a Changelog](https://keepachangelog.com/) 格式。

## [2.4.8] - 2026-07-16

### 新增

- **群聊支持：** 按 Webox `group_id` / `@chatroom` 路由群会话、上下文 token 和回复，同时通过 `SenderId` 保留实际群成员身份。

### 安全

- 插件内置 slash command 和私聊路由元数据与群消息隔离；群回复也不再读取私聊用户的正在输入配置。

## [2.4.7] - 2026-07-12

### 变更

- fork 改为通过 `@netcat-ai/openclaw-weixin` 发布。
- 自定义 iLink 后端支持 channel 和 account 两级 `baseUrl`；account 配置优先于 channel 配置和已保存凭据。
- 二维码登录及刷新使用解析后的 account base URL，不再固定请求腾讯端点。

## [2.4.5] - 2026-06-22

### 新增

- **`classifyFetchError` — 网络错误分类：** `src/api/api.ts` 新增 `classifyFetchError` 工具函数，将 fetch 级错误分类为 `dns` / `tcp` / `tls` / `timeout` / `unknown`。`apiGetFetch` 与 `apiPostFetch` 在失败时输出结构化日志（type, description, code），便于排查网络问题。覆盖 ENOTFOUND、ECONNREFUSED、ETIMEDOUT、SSL/TLS、AbortError 等场景的完整测试。
- **`sendMessage` 返回值校验：** `sendMessage` 现在解析服务端返回的 `SendMessageResp`（`ret` / `errmsg`），`ret` 非零时抛错，避免消息发送静默失败。

### 变更

- **`SESSION_EXPIRED_ERRCODE` → `STALE_TOKEN_ERRCODE`：** 在 `src/api/session-guard.ts` 中重命名，更准确地描述 token 过期（-14 表示 token 失效，而非 session 过期）。`monitor.ts` 与测试中所有引用同步更新。
- **错误日志改进：**
  - `monitor.ts` 中 `getUpdates` 的错误日志使用 `classifyFetchError` 输出分类信息（type, description, code）。
  - `monitor.ts` 移除重复的 `errLog` 日志行，仅保留 `aLog.error`。
  - CDN 上传失败日志（`cdn-upload.ts`）增加脱敏 URL 和错误 cause 信息。
  - `downloadRemoteImageToTemp`（`upload.ts`）增加 fetch 网络错误详情日志。
  - API GET/POST fetch 失败日志（`api.ts`）增加脱敏 URL、超时设置及错误分类信息。
- **最低宿主版本升级：** `peerDependencies.openclaw` 和 `install.minHostVersion` 从 `>=2026.3.22` 升至 `>=2026.5.12`。

### 新增（开发/工程）

- **`outbound-hooks.test.ts`：** 新增测试文件，覆盖 `applyWeixinMessageSendingHook`（无 hook、内容修改、取消、错误容错）和 `emitWeixinMessageSent`（无 hook、成功、失败走 fire-and-forget）各场景。

### 修复

- **`pairing.test.ts` mock 路径：** `vi.mock` 目标从 `"openclaw/plugin-sdk"` 修正为 `"openclaw/plugin-sdk/infra-runtime"`。
- **`api.test.ts` sendMessage 测试 mock：** 成功用例的 mock 返回值从 `""` 改为 `"{}"`，与 `sendMessage` 新增的响应解析逻辑一致。

## [2.4.4] - 2026-05-22

### 新增

- **工具调用进度消息：** 模型执行 tool 时，发送 `TOOL_CALL_START` / `TOOL_CALL_RESULT` 进度消息，可通过 `replyProgressMessages` 开关控制（默认开启）。
- **请求中断信号支持：** `apiPostFetch` / `getUpdates` 现在接受外部的 `AbortSignal`。当网关停止或热重载频道时，正在进行的 long-poll 请求会被立即取消，无需等待服务端超时。

## [2.4.3] - 2026-05-08

### 修复

- **`iLink-App-Id` / `iLink-App-ClientVersion` 请求头在生产环境为空 / `0`。** `readPackageJson` 用固定的 `../../` 从 `import.meta.url` 推算 `package.json`，但 TypeScript 构建（`tsconfig.include` 同时包含 `index.ts` 和 `src/**/*.ts`）实际产物是 `dist/src/api/api.js`（多出一层 `src/`），导致解析到不存在的 `dist/package.json`，catch 返回 `{}`。改为从当前模块所在目录向上逐级查找，并通过 `name` 包含 `openclaw-weixin` 或存在 `ilink_appid` 字段来确认是本插件自己的 `package.json`，同时兼容开发态（`src/api/`）和发布态（`dist/src/api/`）布局。`src/api/api.test.ts` 新增 5 个用例覆盖编译产物布局、开发布局、途经 `node_modules/<dep>/package.json` 不被误识别、找不到时返回 `{}`、坏 JSON 容错继续向上查找。
- **`openclaw channels login` 在 "已连接过此 OpenClaw" 场景下被误判为失败。** 服务端返回 `binded_redirect` 时本地凭据其实仍有效，但旧逻辑返回 `connected: false`，`channel.ts` 的 `auth.login` 据此 `throw`，CLI 非零退出，导致 `openclaw-weixin-installer` 等自动化脚本误打印"首次连接未完成"。`WeixinQrWaitResult` 新增 `alreadyConnected` 字段，QR 轮询在 `binded_redirect` 时置为 `true`；`auth.login` 据此仅记录消息、不抛错，CLI 以 0 退出。

## [2.4.2] - 2026-05-07

### 修复

- **Node 24 / undici 兼容性——所有请求 `TypeError: fetch failed`。** 从 `buildHeaders` 中移除手动设置的 `Content-Length`。Node 24 自带的 undici 不允许调用方预设 `Content-Length`，会以 `UND_ERR_INVALID_ARG: invalid content-length header` 拒绝整个请求，导致所有 CGI 调用失败。改由 `fetch` 根据请求体自动计算，恢复在 Node 24 下的网络调用。
- **OpenClaw ≥ 2026.5.x——微信 runtime 初始化超时无限重启。** 移除模块作用域的 `pluginRuntime` 全局变量（同时删掉 `src/runtime.ts`），改为按调用从网关 ctx 中读取 `ctx.channelRuntime`。原先的全局是在插件注册阶段写入的，但较新宿主改为按调用注入 runtime surface，启动时拿不到/拿到旧值，channel 启动一直超时进而被反复重启。

### 移除

- **冗余脚本与入口：** 删除调试用的 `scripts/test-full-upload.ts` / `scripts/test-upload-url.ts`，以及遗留的 `index.ts` 转发文件。对调用方无行为变更。

## [2.4.1] - 2026-05-04

### 新增

- **npm 包内携带 dist 产物作为 channel 入口：** `package.json` 的 `files` 加入 `dist/`，`openclaw.runtimeExtensions` 设为 `["./dist/index.js"]`；宿主直接加载预编译的 JS 入口，不再依赖装包时的 TypeScript 源码，避免在较严格的宿主版本上出现 `requires compiled runtime output for TypeScript entry index.ts` 错误。
- **`openclaw.plugin.json` 频道配置：** 在 `openclaw.plugin.json` 中声明 `channels` 与 `channelConfigs`，使较新宿主（≥ 2026.4.x）能直接渲染频道选择 UI，无需回退到 `package.json#openclaw`。

## [2.3.1] - 2026-04-28

### 新增

- **`bot_agent` 请求字段：** 上行 CGI 现在携带由上层应用提供的 `bot_agent`（类似 UA 的 `name/version (comment)` 语法，支持多个 product），按上层应用的 channel 配置传入；`src/api/api.ts` 中的 `sanitizeBotAgent` 负责清洗与长度上限，缺失或不合法时回落为 `OpenClaw`。
- **扫码时上送 `local_token_list`：** `fetchQRCode` 现在带上本地最近 10 个 `bot_token`，让服务端识别"已绑定到本端"的 bot 并下发 `binded_redirect`，避免重复发会话。
- **配对码登录流程：** 服务端要求二次校验时（`need_verifycode` / `verify_code_blocked`），`waitForWeixinLogin` 通过 stdin 提示用户输入 `verify_code` 并做有限次重试。
- **`binded_redirect` 处理：** QR 轮询新增分支，输出 `✅ 已连接过此 OpenClaw，无需重复连接。` 并优雅返回。
- **连接状态通知（start/stop）：** `gateway.startAccount` 在 provider 注册后调用 `notifyStart`，新增的 `gateway.stopAccount` hook 调用 `notifyStop`，便于上游微信服务端对账户在线状态进行对账。

### 变更

- **扫码登录文案：** 调整 QR / 扫码相关的提示文案；同时移除 `fetchQRCode` / `startWeixinLoginWithQr` 的客户端超时，长轮询仅受服务端与网络栈限制。

## [2.1.10] - 2026-04-24

### 新增

- **连接状态通知（start/stop）首次引入：** 账号启动时发送 `notifyStart`，关闭时通过新的 `gateway.stopAccount` hook 发送 `notifyStop`。该能力在后续 2.3.x 中保留。

## [2.1.9] - 2026-04-20

### 新增

- **外发 hook 支持：** 为所有外发路径（`sendText`、`sendMedia`、`process-message` 中的入站回复 `deliver`）接入 `message_sending`（发送前拦截/修改）和 `message_sent`（发送后通知）hook。hook 逻辑抽取至共享模块 `src/messaging/outbound-hooks.ts`。

### 变更

- **清理：** 移除 `sendWeixinOutbound` 签名中未使用的 `mediaUrl` 参数。

## [2.1.8] - 2026-04-07

### 变更

- **Markdown 过滤器：** `StreamingMarkdownFilter` 放开了更多 Markdown 格式的保留。

## [2.1.7] - 2026-04-07

### 修复

- **插件注册重入：** `channel.ts` 中将 `monitorWeixinProvider` 改为在 `startAccount` 内部懒加载（`await import(...)`），避免插件注册阶段提前拉取 monitor → process-message → command-auth 依赖链，导致 plugin/provider registry 重入。
- **初始化副作用：** `process-message.ts` 中将 `resolveSenderCommandAuthorizationWithRuntime` / `resolveDirectDmAuthorizationOutcome` 改为懒加载，避免模块初始化时触发宿主的 `ensureContextWindowCacheLoaded` 副作用，进而导致 `loadOpenClawPlugins` 重入。

### 变更

- **tool-call 外发路径：** `sendWeixinOutbound` 现在对发送文本应用 `StreamingMarkdownFilter`，与 `process-message` 中的 model-output 路径保持一致。

## [2.1.4] - 2026-04-03

### 变更

- **扫码登录：** 移除 `get_bot_qrcode` 的客户端超时，请求不再因固定时限被 abort（仍受服务端与网络栈限制）。

## [2.1.3] - 2026-04-02

### 新增

- **`StreamingMarkdownFilter`**（`src/messaging/markdown-filter.ts`）：外发文本由原先 `markdownToPlainText` 整段剥离 Markdown，改为流式逐字符过滤；**对 Markdown 从完全不支持变为部分支持**。

### 变更

- **外发文本：** `process-message` 在每次 `deliver` 时用 `StreamingMarkdownFilter`（`feed` / `flush`）处理回复，替代 `markdownToPlainText`。

### 移除

- 从 `src/messaging/send.ts` 删除 **`markdownToPlainText`**（相关用例从 `send.test.ts` 迁至 `markdown-filter.test.ts`）。

## [2.1.2] - 2026-04-02

### 变更

- **登录后配置刷新：** 每次微信登录成功后，在 `openclaw.json` 中更新 `channels.openclaw-weixin.channelConfigUpdatedAt`（ISO 8601），让网关从磁盘重新加载配置；不再写入空的 `accounts: {}` 占位。
- **扫码登录：** `get_bot_qrcode` 客户端超时由 5s 调整为 10s。
- **文档：** 卸载说明改为使用 `openclaw plugins uninstall @tencent-weixin/openclaw-weixin`，与插件 CLI 一致。
- **日志：** `debug-check` 日志不再输出 `stateDir` / `OPENCLAW_STATE_DIR`。

### 移除

- **`openclaw-weixin` 子命令**（删除 `src/weixin-cli.ts` 及 `index.ts` 中的注册）。请使用宿主自带的 `openclaw plugins uninstall …` 卸载流程。

### 修复

- 解决在 **OpenClaw 2026.3.31 及更新版本**上安装插件时出现的 **dangerous code pattern** 提示（宿主插件安装 / 静态检查）。
