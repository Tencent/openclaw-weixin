# 引用消息本地缓存

本文说明引用消息本地缓存的设计、配置和验证方式。普通用户只需要关注
README 中的配置入口；本文面向需要排查行为、维护代码或验证发布包的开发者。

## 功能目的

新版微信客户端可能只在引用消息中提供服务端消息 ID（`svr_id`），而不再携带
被引用消息的正文或媒体内容。插件使用按账号、会话隔离的 SQLite 旁路存储，
在后续引用到来时还原可用的文本、媒体元数据和附件访问信息。

缓存默认开启，正常消息投递不依赖缓存是否命中。

## 配置

配置路径为 `channels.openclaw-weixin.quoteCache`：

| 配置项 | 默认值 | 说明 |
| --- | ---: | --- |
| `enabled` | `true` | 是否启用本地引用消息还原。 |
| `retentionDays` | `30` | 文本及消息元数据的保留天数。 |
| `maxMessagesPerAccount` | `10000` | 每个账号最多保留的消息记录数。 |
| `mediaRetentionDays` | `7` | 引用媒体文件的保留天数。 |
| `maxMediaBytesPerAccount` | `268435456` | 每个账号最多保留的媒体总大小，单位为字节（256 MiB）。 |
| `maxSingleMediaBytes` | `26214400` | 单个可保留媒体文件的最大大小，单位为字节（25 MiB）。 |

示例：

```json
{
  "channels": {
    "openclaw-weixin": {
      "quoteCache": {
        "enabled": true,
        "retentionDays": 14,
        "maxMessagesPerAccount": 5000,
        "mediaRetentionDays": 3,
        "maxMediaBytesPerAccount": 134217728,
        "maxSingleMediaBytes": 26214400
      }
    }
  }
}
```

修改配置后重启 Gateway：

```bash
openclaw gateway restart
```

## 数据和媒体生命周期

- 入站和出站引用元数据按账号和会话隔离，避免不同账号或会话之间串数据。
- 图片、视频、语音和附件写入插件专属的 OpenClaw 受管目录；当前消息和后续引用复用同一份文件。
- 还原附件时提供原文件名、受管源路径以及工作区 `media/inbound/` 提示，便于 file/PDF 工具访问。
- 启动时、每小时、每写入 100 条记录、媒体空间超限时执行清理；过期记录命中查询时也会惰性清理。
- 超过保留时间、账号记录数量、账号媒体空间或单文件大小限制时，按限制淘汰旧数据或跳过媒体保留。
- 删除账号时同步删除该账号的引用记录和保留媒体。
- 早于缓存初始化的历史消息无法还原，会返回明确的缓存未命中占位信息。

## 兼容性和降级

- 项目要求 Node.js `>=22.13.0`，此版本开始 `node:sqlite` 无需使用实验性启动参数。
- 消息 ID 以字符串形式处理，避免超过 JavaScript 安全整数范围时发生精度丢失。
- 部分引用会进行必要的 MD5 校验；校验失败时不会伪造引用内容。
- 当前 Node.js 不提供 `node:sqlite`，或数据库无法打开时，插件记录警告并关闭引用缓存。
- 缓存关闭或不可用时不使用内存缓存替代，缓存故障也不会中断正常消息收发。

## 开发验证

重点单元测试：

```bash
npx vitest run --coverage=false src/messaging/quote-store.test.ts src/messaging/partial-quote.test.ts
```

完整质量检查：

```bash
npm ci --ignore-scripts
npm run ci
npm run test:coverage
```

手工验证至少覆盖以下场景：

1. 发送文本后，用只携带 `svr_id` 的引用消息进行引用，Agent 能看到原文。
2. 引用图片、视频、语音和文件，Agent 能获得对应媒体信息和可访问路径。
3. 重启 Gateway 后再次引用，已缓存消息仍可还原。
4. 多账号、多会话之间不存在引用数据串线。
5. 缓存关闭、SQLite 不可用和媒体超过大小限制时，普通消息仍能正常收发。
