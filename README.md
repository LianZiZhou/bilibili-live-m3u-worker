# bilibili-live-m3u-worker

把 B 站直播间和 YouTube 直播转换成 IPTV 播放器可用的 m3u / m3u8 / XMLTV(EPG)。

## 安装与运行

```sh
bun install
cp config.example.json config.json   # 按需修改
bun run dev      # 开发（热重载）
bun run start    # 生产，也可以用 pm2 start pm2.json
bun test         # 测试（播放集成测试需要本地 redis，mux 相关测试需要 ffmpeg）
```

依赖：
- Redis（缓存）
- ffmpeg（可选，仅 `mux` 播放模式和自定义占位图需要；没有时自动退回 `passthrough` / 内置占位画面）

## 接口

| 路径 | 说明 |
| --- | --- |
| `/subscribe/all/live.m3u` | B 站 + YouTube 合并订阅，按 `group-title` 分组 |
| `/subscribe/all/guide.xml` | 合并 EPG |
| `/subscribe/bili/live.m3u` / `guide.xml` | B 站订阅 / EPG |
| `/subscribe/yt/live.m3u` / `guide.xml` | YouTube 订阅 / EPG |
| `/play/live/bili/:roomId/index.m3u8` | B 站直播间 |
| `/play/live/yt/channel/:channel/index.m3u8` | YouTube 频道（`UC...` 或 `@handle`），固定地址：在播放当前直播，未开播显示占位画面，开播后自动切换 |
| `/play/live/yt/:videoId/index.m3u8` | 指定 YouTube 直播视频 |
| `/meta/live/yt/avatar/:channel.jpg` | 频道头像 |
| `/meta/live/yt/cover/:channel.jpg` | 直播封面（未开播时为头像） |

YouTube 播放地址支持参数：`?mode=passthrough|mux`、`?quality=720|1080|best`，覆盖配置文件中的默认值。

## 配置

配置文件默认读取 `./config.json`（可用 `CONFIG_PATH` 指定），环境变量优先级高于配置文件。完整示例见 `config.example.json`。

| 配置项 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `serviceUrl` | `SERVICE_URL` | 请求的 Host | 对外访问地址，playlist 中的绝对链接使用它 |
| `port` | `PORT` | `10028` | |
| `redisUrl` | `REDIS_URL` | `redis://localhost:6379` | |
| `bilibili.sessdata` | `BILI_SESSDATA` | | B 站登录 Cookie `SESSDATA` |
| `youtube.source` | `YT_SOURCE` | `local` | 直播状态数据源：`local` / `dataapi` / `holodex` |
| `youtube.dataApiKey` | `YT_DATA_API_KEY` | | YouTube Data API v3 key |
| `youtube.holodexApiKey` | `HOLODEX_API_KEY` | | Holodex API key |
| `youtube.channels` | `YT_CHANNELS` | `[]` | 关注的频道；环境变量格式 `UCxxx:显示名,@handle` |
| `youtube.holodexOrgs` | `HOLODEX_ORGS` | `[]` | 仅 holodex：额外订阅这些组织（如 `Hololive`）正在直播 / 即将开播的频道 |
| `youtube.statusCacheSeconds` | | 按数据源 | 直播状态缓存秒数，默认 local/holodex 60，dataapi 300 |
| `youtube.playback` | `YT_PLAYBACK` | `passthrough` | 播放模式，见下文 |
| `youtube.quality` | `YT_QUALITY` | `best` | 最大画面高度，如 `720`、`1080` |
| `youtube.muxCodecs` | | `["avc1"]` | mux 模式允许的视频编码，可加 `vp9`、`av1` |
| `youtube.cookiesPath` | `YT_COOKIES_PATH` | `./cookies.json` | 可选，YouTube Cookie（浏览器插件导出的 JSON、Netscape cookies.txt 或原始 Cookie 字符串） |
| `youtube.proxy` | `YT_PROXY` | 直连 | 访问 YouTube / Holodex / Google API 使用的代理，支持 `http://`、`https://`、`socks4://`、`socks5://`、`socks5h://`（可带 `user:pass@`） |
| `youtube.placeholderImage` | `YT_PLACEHOLDER_IMAGE` | 内置 | 自定义未开播占位图（需要 ffmpeg） |

### 直播状态数据源

- **local**：直接请求 `youtube.com/channel/<id>/live` 页面解析，无需任何 key。频道多时请求量较大。
- **dataapi**：[YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com)。每次刷新每个频道约消耗 1 配额（读取上传列表），另外每 50 个视频 1 配额；默认每日配额 10000，频道较多时请调大 `statusCacheSeconds`。
- **holodex**：[Holodex](https://holodex.net) API（VTuber 直播聚合），在 holodex.net 登录后于账户设置中获取 API key。支持 `holodexOrgs` 按组织订阅；会员限定直播会被忽略。

dataapi / holodex 请求失败时会自动退回 local。

### 播放模式

- **passthrough**（默认）：使用 YouTube 直播 HLS 中自带音轨的变体（最高 1080p），不需要 ffmpeg，分片由本服务代理转发（YouTube 分片地址绑定服务器 IP，不能直接给客户端）。
- **mux**：分别取 DASH 视频流和音频流，用 ffmpeg 按分片合成为 MPEG-TS（不转码）。默认只选 H.264；在 `muxCodecs` 中加入 `vp9` / `av1` 可以取得 1440p/4K 等更高画质，但 TS 中的 VP9/AV1 只有基于 ffmpeg 的播放器（VLC、mpv、Kodi 等）支持。取不到 DASH 分片时自动退回对应的 HLS 分片。

### 未开播占位

频道未开播时返回一个不断滚动的占位直播流（`assets/offline.png`），播放器会持续刷新，主播开播后自动切换到直播画面。EPG 中标题显示为 `【未开播】频道名`、`【预定 MM-DD HH:mm】直播标题`（北京时间）或 `【待机中】直播标题`。
