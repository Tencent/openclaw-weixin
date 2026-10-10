# Weixin Backend API Protocol

This document describes the HTTP JSON protocol used by the `openclaw-weixin` channel plugin. It is intended for developers implementing or integrating a compatible Weixin backend. Normal plugin users only need the [main README](../README.md).

[简体中文](./protocol_zh_CN.md)

## How to read this reference

This reference is based on the current repository's client code. It distinguishes three kinds of information:

- **Fields and examples** describe the wire format represented by the client types and request builders.
- **Client behavior** describes what this plugin currently sends, accepts, or retries.
- **Integration guidance** gives recommendations for other implementations.

Client types and behavior do not establish the complete server contract. In particular, a TypeScript optional field does not prove that the server accepts requests without it, and a field defined in a type does not imply that the plugin implements every associated feature.

Unless otherwise stated, JSON examples illustrate selected fields and are not verified minimal requests or exhaustive responses. Replace placeholders with actual values. `channel_version` is populated from package metadata; `2.4.8` is an example value.

Source references: [`src/api/api.ts`](../src/api/api.ts), [`src/api/types.ts`](../src/api/types.ts), and [`src/auth/login-qr.ts`](../src/auth/login-qr.ts). Server requirements beyond what these sources show need separate verification.

## Scope and transport

- API requests use JSON over HTTPS.
- API paths are relative to the current API base URL.
- Normal API methods use `POST`; QR-code status polling uses `GET`.
- JSON byte fields are represented as base64 strings.
- The default API base URL is `https://ilinkai.weixin.qq.com`.
- The default CDN base URL is `https://novac2c.cdn.weixin.qq.com/c2c`.

The QR-code flow starts at the fixed API base URL. After a successful redirect response, the client may poll QR status at the returned host. For CDN media, a server-provided full URL takes precedence over a URL constructed from the configured CDN base URL.

## Authentication and common metadata

### Request headers

The following headers are added by the plugin where applicable:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` for JSON POST requests |
| `AuthorizationType` | `ilink_bot_token` |
| `Authorization` | `Bearer <bot_token>` for authenticated bot API requests |
| `X-WECHAT-UIN` | Base64-encoded decimal representation of a random uint32 |
| `iLink-App-Id` | The plugin application ID, currently `bot` |
| `iLink-App-ClientVersion` | Plugin version encoded as `0x00MMNNPP` and sent as a decimal string |
| `SKRouteTag` | Optional route tag configured by the deployment |

Client behavior: QR-code status polling sends the application headers (`iLink-App-Id`, `iLink-App-ClientVersion`, and optional `SKRouteTag`). It does not add `AuthorizationType`, `Authorization`, or `X-WECHAT-UIN`. The QR-code POST request uses the JSON POST headers, including `AuthorizationType` and `X-WECHAT-UIN`, but omits `Authorization` and `base_info`.

### `base_info`

Authenticated bot POST requests include a `base_info` object:

```json
{
  "base_info": {
    "channel_version": "2.4.8",
    "bot_agent": "OpenClaw"
  }
}
```

`channel_version` is the plugin version. `bot_agent` is an optional, sanitized observability identifier configured through `channels.openclaw-weixin.botAgent`; it is not used for authentication or routing.

Client behavior: `buildBaseInfo()` always supplies both fields. `bot_agent` defaults to `OpenClaw`. Custom values use ASCII `Name/Version` tokens with optional comments, with a maximum of 256 bytes after sanitization. Invalid tokens are dropped; an empty result falls back to `OpenClaw`. This declaration is shared across accounts in the plugin instance.

### Return values and errors

The response types use fields such as `ret`, `errcode`, and `errmsg`; they are not present on every endpoint. `ret: 0` represents success where used.

Current client behavior differs by operation:

| Operation | Application response handling |
| --- | --- |
| `getUpdates` | The monitor checks non-zero `ret` or `errcode`. Either field equal to `-14` triggers a one-hour account session pause; other failures follow the monitor's retry/backoff policy. |
| `sendMessage` | A non-zero `ret` throws; an absent `ret` does not trigger this check. |
| `getUploadUrl` | The upload caller requires a nonempty `upload_full_url` or `upload_param`; it does not explicitly check `ret`. |
| `getConfig` | The cache layer accepts configuration only when `ret === 0`; failures use cached/default configuration and schedule another attempt. |
| `sendTyping` | The wrapper does not parse the response body or check its business return code. |
| `notifyStart` / `notifyStop` | Non-zero `ret` or request failures are logged as warnings by channel lifecycle handlers, without blocking startup/shutdown. |

The JSON fetch wrappers throw on non-successful HTTP status. `getUpdates` converts a timeout or external cancellation into an empty result; cancellation lets the monitor exit rather than continue polling. QR status polling converts request failures into `wait`.

Integration guidance: handle HTTP status separately from business return codes, define retry behavior per operation, and redact credentials in diagnostic output. These are recommendations, not a claim that the current client applies a single uniform error or redaction policy.

## QR-code login

### Get a QR code

```http
POST /ilink/bot/get_bot_qrcode?bot_type=3
```

Request body:

```json
{
  "local_token_list": []
}
```

`local_token_list` may be empty. The client sends at most the most recent ten locally stored bot tokens.

Response body:

```json
{
  "qrcode": "<qrcode value>",
  "qrcode_img_content": "<url or content to display as a QR code>"
}
```

### Poll QR-code status

```http
GET /ilink/bot/get_qrcode_status?qrcode=<encoded_qrcode>
```

When the server requests verification, the client adds:

```http
GET /ilink/bot/get_qrcode_status?qrcode=<encoded_qrcode>&verify_code=<encoded_code>
```

Response body:

```json
{
  "status": "confirmed",
  "bot_token": "<bot token>",
  "ilink_bot_id": "<bot account id>",
  "baseurl": "https://<api-host>",
  "ilink_user_id": "<scanning user id>"
}
```

The client handles these statuses:

| Status | Meaning |
| --- | --- |
| `wait` | Waiting for a scan or state change |
| `scaned` | QR code was scanned; verification continues |
| `confirmed` | Login succeeded and credentials can be stored |
| `expired` | QR code expired and may be refreshed |
| `need_verifycode` | The user must provide the displayed verification code |
| `verify_code_blocked` | Too many verification failures; refresh or stop |
| `scaned_but_redirect` | Continue polling at `redirect_host` when present |
| `binded_redirect` | The bot is already bound to this OpenClaw instance |

## Bot API

### Endpoint overview

| Operation | Method and path | Purpose |
| --- | --- | --- |
| `getUpdates` | `POST /ilink/bot/getupdates` | Long-poll for inbound messages |
| `getUploadUrl` | `POST /ilink/bot/getuploadurl` | Get media upload parameters |
| `sendMessage` | `POST /ilink/bot/sendmessage` | Send a message |
| `getConfig` | `POST /ilink/bot/getconfig` | Get account configuration and typing ticket |
| `sendTyping` | `POST /ilink/bot/sendtyping` | Set or cancel typing status |
| `notifyStart` | `POST /ilink/bot/msg/notifystart` | Notify the backend that the client started |
| `notifyStop` | `POST /ilink/bot/msg/notifystop` | Notify the backend that the client stopped |

All requests in this section include the common headers, bot authorization, and `base_info` unless stated otherwise.

### `getUpdates`

```http
POST /ilink/bot/getupdates
```

Request:

```json
{
  "get_updates_buf": "",
  "base_info": {
    "channel_version": "2.4.8",
    "bot_agent": "OpenClaw"
  }
}
```

The client sends the previous response's `get_updates_buf`. It sends an empty string for the first request or after a reset. The server should hold the request until a message is available or the long-poll timeout is reached.

Response:

```json
{
  "ret": 0,
  "msgs": [],
  "get_updates_buf": "<next cursor>",
  "longpolling_timeout_ms": 35000
}
```

| Field | Type | Description |
| --- | --- | --- |
| `ret` | `number` | `0` means success |
| `errcode` | `number` | Optional application error code |
| `errmsg` | `string` | Optional error description |
| `msgs` | `WeixinMessage[]` | Inbound messages |
| `get_updates_buf` | `string` | Cursor to send in the next request |
| `longpolling_timeout_ms` | `number` | Optional server-suggested timeout in milliseconds |

`sync_buf` remains deprecated in the TypeScript types. The current request builder sends only `get_updates_buf`, and the monitor does not use `sync_buf` as a response fallback. It saves a returned cursor only when `get_updates_buf` is nonempty.

### `sendMessage`

```http
POST /ilink/bot/sendmessage
```

Example matching the current text-message builder when a context token is available (`run_id` is additionally included when supplied):

```json
{
  "msg": {
    "from_user_id": "",
    "to_user_id": "<target user id>",
    "client_id": "<client-generated id>",
    "message_type": 2,
    "message_state": 2,
    "context_token": "<conversation context token>",
    "item_list": [
      {
        "type": 1,
        "text_item": { "text": "Hello" }
      }
    ]
  },
  "base_info": {
    "channel_version": "2.4.8",
    "bot_agent": "OpenClaw"
  }
}
```

Response:

```json
{
  "ret": 0,
  "errmsg": ""
}
```

Integration guidance: pass back the inbound `context_token` when replying to that conversation. Client behavior: the send helper logs a warning and still sends if the token is missing; this does not establish whether the server will accept that request. Media captions and media items are currently sent in separate requests, each with its own `client_id`.

### `getUploadUrl`

```http
POST /ilink/bot/getuploadurl
```

Request:

```json
{
  "filekey": "<client-generated file key>",
  "media_type": 1,
  "to_user_id": "<target user id>",
  "rawsize": 12345,
  "rawfilemd5": "<plaintext md5>",
  "filesize": 12352,
  "no_need_thumb": true,
  "aeskey": "<16-byte key as hex>",
  "base_info": {
    "channel_version": "2.4.8",
    "bot_agent": "OpenClaw"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `media_type` | `number` | `1` image, `2` video, `3` file, `4` voice |
| `rawsize` | `number` | Plaintext size in bytes |
| `rawfilemd5` | `string` | Plaintext MD5 |
| `filesize` | `number` | Ciphertext size after AES-128-ECB with PKCS#7 padding |
| `thumb_rawsize` | `number` | Thumbnail plaintext size when needed |
| `thumb_rawfilemd5` | `string` | Thumbnail plaintext MD5 when needed |
| `thumb_filesize` | `number` | Thumbnail ciphertext size when needed |
| `no_need_thumb` | `boolean` | Set when no thumbnail upload is needed |
| `aeskey` | `string` | AES key as a hexadecimal string |

Response:

```json
{
  "upload_param": "<encrypted upload parameter>",
  "thumb_upload_param": "<encrypted thumbnail parameter>",
  "upload_full_url": "<optional complete upload URL>"
}
```

The client prefers `upload_full_url`. If it is absent, it constructs a CDN upload URL from `upload_param` and `filekey`.

The types expose thumbnail request fields and `thumb_upload_param`. Current client behavior: the shared upload pipeline always sends `no_need_thumb: true`, uploads only the original file, and does not consume `thumb_upload_param`. These fields do not indicate implemented thumbnail upload support. Likewise, `media_type: 4` is defined in the types, while the current file-send pipeline selects image, video, or file upload.

### `getConfig`

```http
POST /ilink/bot/getconfig
```

Request:

```json
{
  "ilink_user_id": "<user id>",
  "context_token": "<optional conversation context token>",
  "base_info": {
    "channel_version": "2.4.8",
    "bot_agent": "OpenClaw"
  }
}
```

Response:

```json
{
  "ret": 0,
  "typing_ticket": "<base64 typing ticket>"
}
```

### `sendTyping`

```http
POST /ilink/bot/sendtyping
```

Request:

```json
{
  "ilink_user_id": "<user id>",
  "typing_ticket": "<ticket from getConfig>",
  "status": 1,
  "base_info": {
    "channel_version": "2.4.8",
    "bot_agent": "OpenClaw"
  }
}
```

`status` is `1` for typing and `2` for cancel typing.

### `notifyStart` and `notifyStop`

```http
POST /ilink/bot/msg/notifystart
POST /ilink/bot/msg/notifystop
```

Request:

```json
{
  "base_info": {
    "channel_version": "2.4.8",
    "bot_agent": "OpenClaw"
  }
}
```

Response:

```json
{
  "ret": 0,
  "errmsg": ""
}
```

The plugin sends `notifyStart` when a channel client starts and `notifyStop` when it stops.

## Message model

These tables summarize client-side types. `WeixinMessage`, `MessageItem`, and media-object properties are optional in the TypeScript definitions; the tables do not declare server-required fields. Fields such as `group_id` describe the type surface, not a guarantee of plugin feature support.

### `WeixinMessage`

| Field | Type | Description |
| --- | --- | --- |
| `seq` | `number` | Message sequence number |
| `message_id` | `number` | Message ID |
| `from_user_id` | `string` | Sender ID |
| `to_user_id` | `string` | Receiver ID |
| `client_id` | `string` | Client-generated or client-associated ID |
| `create_time_ms` | `number` | Creation timestamp in milliseconds |
| `update_time_ms` | `number` | Update timestamp in milliseconds |
| `delete_time_ms` | `number` | Deletion timestamp in milliseconds |
| `session_id` | `string` | Session ID |
| `group_id` | `string` | Group ID when applicable |
| `message_type` | `number` | `1` user, `2` bot |
| `message_state` | `number` | `0` new, `1` generating, `2` finished |
| `item_list` | `MessageItem[]` | Message content items |
| `context_token` | `string` | Conversation context for replies |
| `run_id` | `string` | Generation or run ID when applicable |

### `MessageItem`

| `type` | Content |
| ---: | --- |
| `1` | `text_item` |
| `2` | `image_item` |
| `3` | `voice_item` |
| `4` | `file_item` |
| `5` | `video_item` |
| `11` | `tool_call_start_item` |
| `12` | `tool_call_result_item` |

Common item fields include `create_time_ms`, `update_time_ms`, `is_completed`, `msg_id`, and an optional `ref_msg` containing a referenced message item.

`voice_item` may include a transcript in `text`. Media items can include a `media` object, and images and videos can additionally include `thumb_media`.

### Media fields used by the client

| Field | Type | Current use |
| --- | --- | --- |
| `image_item.aeskey` | `string` | Inbound AES key as 32 hex characters; takes precedence over `media.aes_key`. |
| `image_item.mid_size` | `number` | Ciphertext byte count set by the image sender. |
| `video_item.video_size` | `number` | Ciphertext byte count set by the video sender. |
| `file_item.file_name` | `string` | Attachment filename. |
| `file_item.len` | `string` | Plaintext byte count encoded as a decimal string by the file sender. |
| `voice_item.text` | `string` | Transcript when present. |
| `voice_item.encode_type` | `number` | Codec identifier in the types; does not imply decoding support for every codec. |
| `voice_item.sample_rate` / `playtime` | `number` | Sample rate in Hz / duration in milliseconds. |

See [protocol types](../src/api/types.ts) for the remaining fields and [message builders](../src/messaging/send.ts) for outgoing payloads.

### CDN media reference

```json
{
  "encrypt_query_param": "<download parameter>",
  "aes_key": "<base64 encoded AES key>",
  "encrypt_type": 1,
  "full_url": "<optional complete download URL>"
}
```

The client prefers `full_url`. When a full URL is unavailable, a compatible deployment can construct a download URL as:

```text
<cdn_base_url>/download?encrypted_query_param=<url-encoded encrypt_query_param>
```

The download decoder accepts base64 of either 16 raw bytes or a 32-character hexadecimal key. Current image, video, and file senders all encode the hexadecimal key string as base64. These describe accepted encodings and outgoing behavior, respectively; they are not a mandatory encoding split by media type.

## CDN media flow

### Upload

1. Read the plaintext file and calculate its size and MD5.
2. Generate a 16-byte AES key and a file key.
3. Calculate the padded ciphertext size.
4. Call `getUploadUrl`.
5. Encrypt the content with AES-128-ECB and PKCS#7 padding.
6. Send the encrypted bytes to the returned upload URL with `Content-Type: application/octet-stream`.
7. Read the `x-encrypted-param` response header.
8. Put the returned download parameter and AES key into the media reference sent through `sendMessage`.

Current client behavior: uploads use HTTP `POST`. Only original files are uploaded, with `no_need_thumb: true`; there is no thumbnail upload step.

Success requires HTTP `200` and a nonempty `x-encrypted-param` response header. HTTP 4xx errors abort immediately. Other failures, including a missing response header, are attempted up to three times total. This is the plugin's current acceptance and retry policy.

### Download

1. Prefer `full_url`. The current client enables URL fallback and constructs a CDN download URL from `encrypt_query_param` when a full URL is absent.
2. Download the bytes with HTTP `GET`.
3. For images, prefer the hex key in `image_item.aeskey`, then `image_item.media.aes_key`. If neither is available, use the downloaded image bytes as plaintext.
4. For encrypted images, voice, files, and videos, decode the key and decrypt with AES-128-ECB and PKCS#7 padding. Voice, file, and video items without `media.aes_key` are skipped by the current media downloader.

## Source references

- [API request implementation](../src/api/api.ts)
- [Protocol types](../src/api/types.ts)
- [QR-code login flow](../src/auth/login-qr.ts)
- [CDN upload implementation](../src/cdn/upload.ts)
- [CDN encryption utilities](../src/cdn/aes-ecb.ts)
- [Message builders](../src/messaging/send.ts)
- [Inbound media handling](../src/media/media-download.ts)
- [CDN upload transport](../src/cdn/cdn-upload.ts)
- [Message polling and retries](../src/monitor/monitor.ts)
- [Configuration cache](../src/api/config-cache.ts)
- [Channel lifecycle](../src/channel.ts)
