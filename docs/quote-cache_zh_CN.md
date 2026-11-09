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
| `mediaStorage.mode` | `managed` | 媒体存储方式：`managed` 保持旧版行为；`inbound` 直接使用 OpenClaw 通用 inbound 目录；`custom` 使用单独配置的目录。 |
| `mediaStorage.directory` | — | `mode: "custom"` 时必填，必须是绝对路径且目录本身不能是符号链接。插件在该目录下创建账号子目录并管理其中的缓存媒体。 |
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
        "mediaStorage": { "mode": "managed" },
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

选择 OpenClaw 通用 inbound 目录：

```json
{
  "channels": {
    "openclaw-weixin": {
      "quoteCache": {
        "mediaStorage": { "mode": "inbound" }
      }
    }
  }
}
```

此模式下，新写入 OpenClaw 通用 inbound 的媒体会作为非插件所有的引用记录路径；插件不会删除这些文件，也不会对它们应用媒体保留期和容量清理。OpenClaw 的通用 inbound 清理可能删除文件，用户需要自行设置 `attachments.ttlHours`，或保持该项未设置以关闭通用清理扫描。引用记录本身仍按 `retentionDays` 保留。切换到此模式前已标记为插件所有的媒体仍按原有所有权和清理策略处理。

`managed` 为兼容旧版仍使用 `media/inbound/openclaw-weixin-quotes/`，因此 OpenClaw 的递归通用 inbound 清理也可能删除该目录中的文件。若启用了 `attachments.ttlHours`，请确保清理期限符合引用媒体的使用需求；要完全避开 OpenClaw inbound 清理，请选择 `custom` 并配置 inbound 目录之外的独立路径。

选择独立目录：

```json
{
  "channels": {
    "openclaw-weixin": {
      "quoteCache": {
        "mediaStorage": {
          "mode": "custom",
          "directory": "/data/openclaw/weixin-quote-media"
        }
      }
    }
  }
}
```

Quote Cache 的 SQLite/元数据目录始终由插件创建和管理。`mediaStorage` 只决定新收到的媒体保存到哪里；切换配置不会搬动已有文件，也不会改写 SQLite 中已有的媒体路径。旧记录仍按其原路径读取，文件的后续清理由该文件对应的存储方式负责。切换存储方式需要重启 Gateway。

`custom` 目录应专门留给插件管理。插件对新写入该目录且标记为插件所有的媒体，按 `mediaRetentionDays`、`maxMediaBytesPerAccount` 和 `maxSingleMediaBytes` 执行清理。`inbound` 中的新文件由 OpenClaw 通用媒体存储管理；请自行确认 `attachments.ttlHours` 等清理策略不会在需要引用文件前将其删除。已经由插件管理的旧媒体仍按其 SQLite 所有权标记执行缓存清理，不因切换配置而搬迁。

`managed` 是为兼容升级保留的默认模式，继续使用原有的
`<OpenClaw 状态目录>/media/inbound/openclaw-weixin-quotes/<账号目录>/`。旧 SQLite 表会自动补充媒体所有权标记，已有记录按旧规则继续由插件管理；升级不会主动搬动这些文件。

修改配置后重启 Gateway：

```bash
openclaw gateway restart
```

## 数据和媒体生命周期

- 入站和出站引用元数据按账号和会话隔离，避免不同账号或会话之间串数据。
- 引用附件优先使用本地可用缓存，没有可用缓存时才尝试下载旧附件。旧附件下载失败只在 Agent 上下文中标记引用附件暂不可用，当前消息仍正常处理，不因此发送整条请求失败提示；主动取消仍立即中止处理。
- 连续消息合并后仍分别记录每条原消息的 ID 和正文；一条消息中的多个附件按原始顺序保存，后续单独处理、仅携带消息 ID 的引用也会还原全部仍可用的附件。新增多附件字段自动兼容已有单附件记录，历史记录继续按原路径读取。
- 当前轮次使用的受管附件在文件写入开始前被保护，引用缓存的过期、容量和孤儿文件清理会跳过这些文件。正常完成、失败和主动取消都会释放保护；保护期间延后的清理随后继续执行。该保护不改变 `inbound` 模式下 OpenClaw 通用媒体存储的所有权或清理规则。
- 默认 `managed` 模式将图片、视频、语音和附件写入现有插件专属目录，升级时保持原路径和清理行为；其他模式的媒体生命周期按上面的存储模式说明处理。
- 当媒体文件不属于插件受管的账号目录时，缓存只记录路径，不复制或删除该文件；引用时若文件已不存在，就无法还原附件。
- 还原附件时提供原文件名、受管源路径以及工作区 `media/inbound/` 提示，便于 file/PDF 工具访问。
- 启动时、每小时、每写入 100 条记录、媒体空间超限时执行清理；过期记录命中查询时也会惰性清理。
- 超过保留时间或账号记录数量时，删除对应引用记录；该删除操作不逐条 unlink 媒体路径。GC 仍会扫描当前配置的插件受管媒体目录并清理其中已无记录引用的文件；切换存储方式后，旧目录中的文件不随引用记录删除而搬迁或逐条删除。插件所有且仍有关联记录的媒体还按媒体保留期、账号媒体空间和单文件大小限制清理；非插件所有的路径不会被插件清理。`inbound` 模式新写入的路径属于非插件所有。
- 删除账号时删除该账号的引用记录；插件只删除数据库中无任何剩余引用的自有媒体，以及专属账号媒体目录中未登记且无人引用的文件，不递归删除整个目录。`inbound` 模式的新媒体文件不由插件删除。
- 早于缓存初始化的历史消息无法还原，会返回明确的缓存未命中占位信息。

## 兼容性和启动错误

- 项目要求 Node.js `>=22.13.0`，此版本开始 `node:sqlite` 无需使用实验性启动参数。
- 启用 Quote Cache 时，`custom` 目录必须可创建并可写；SQLite 或存储目录初始化失败会记录具体错误并抛出异常，微信通道账号启动失败，不会自动切换到其他媒体目录。
- 消息 ID 以字符串形式处理，避免超过 JavaScript 安全整数范围时发生精度丢失。
- 部分引用会进行必要的 MD5 校验；校验失败时不会伪造引用内容。
- 只有显式设置 `quoteCache.enabled: false` 时才会关闭引用缓存并继续启动；此时新媒体由 OpenClaw 默认保存逻辑处理。

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
