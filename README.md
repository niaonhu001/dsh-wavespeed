# dsh-wavespeed

把 [WaveSpeedAI](https://wavespeed.ai/docs) 的模型接进 DSH：一个目录查询、一条任务提交、一路轮询，图片直接变成对话里的附件，视频落地成本地文件。

## 能做什么

| 工具 | 用途 |
| --- | --- |
| `wavespeed_models` | 搜模型目录（`query` / `type`），或按 `model` 拿到它**真实的参数表**（必填项、枚举、默认值、范围） |
| `wavespeed_generate` | 提交任务并等结果：`model` + `prompt` + 模型自己的 `params`；本地图片/视频路径会自动上传 |
| `wavespeed_result` | 按 prediction id 接着取结果（长视频用；可重复调用，不重复扣费） |
| `wavespeed_balance` | 查账户余额（美元） |

生图：`wavespeed_generate model=wavespeed-ai/z-image/turbo prompt="..." params={size:"1024*1024"}`
生视频：先用 `wavespeed_models type=text-to-video`（或 `image-to-video`）挑模型，再把它的参数原样放进 `params`。

图片产出经 DSH 附件服务落地，聊天里直接显示、下一轮模型也能看见；视频、音频等其它产物下载到 `downloadDir`（默认 `<DSH_HOME>/wavespeed-cache`）并以绝对路径回报。

## 安装

```bash
# 在 DSH 里
plugin_manager install_bundle  target=<本目录绝对路径>
```

装完用 `wavespeed_balance` 验一下密钥。

## 设置面板

装好后在 **Settings → WaveSpeed** 里可以直接：

- 填 / 换 API Key（写进 DSH 凭据库的 `WAVESPEED_API_KEY`，不会进 `cordis.patch.yml`）
- 一键测试连接，顺便看到当前余额
- 清除密钥
- 高级项：服务地址、单次等待上限、产物下载目录（留空即回到配置默认）

面板通过宿主注册的 `/dsh-wavespeed/settings` 与 `/dsh-wavespeed/test` 两个路由工作；工具每次调用都会重新读取一遍偏好，所以改完不用重启。

## 密钥

插件按顺序取：`config.apiKey`（不建议）→ DSH 凭据里名为 `config.apiKeyEnv` 的条目（默认 `WAVESPEED_API_KEY`）→ 同名环境变量。

在设置面板里存一次即可，密钥不会进入 `cordis.patch.yml`。密钥在 <https://wavespeed.ai/accesskey> 生成。

## 配置

写在 `cordis.patch.yml` 对应行的 `config` 里，全部有默认值：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `WAVESPEED_API_KEY` | 凭据/环境变量名 |
| `apiKey` | 空 | 直接给密钥（会明文进配置，不推荐） |
| `baseUrl` | `https://api.wavespeed.ai/api/v3` | API 根地址 |
| `pollIntervalMs` / `maxPollIntervalMs` | `2000` / `8000` | 轮询起步间隔与上限（服务端要求 ≥2s，别再调小） |
| `waitMs` | `300000` | 单次工具调用最多等多久；超时返回 prediction id |
| `downloadDir` | `<DSH_HOME>/wavespeed-cache` | 产物落盘目录 |
| `catalogTtlMs` | `600000` | 模型目录缓存时长 |
| `maxImages` | `8` | 单次最多转几张附件（其余落盘） |
| `maxDownloadBytes` | `536870912` | 单个产物大小上限（512MB） |

## 几个约定

- **不重复提交**：提交接口不做自动重试——网络中断后重试会重复扣费。中断时工具会明确要求先去控制台确认。轮询接口才退避重试（429/5xx）。
- **参数预校验**：提交前用目录里的真实 schema 校验必填项与枚举，缺参数直接报错，不花冤枉钱。目录拉不到时跳过校验，由 API 报错。
- **产物会过期**：WaveSpeed 的输出 URL 7 天有效，插件下载到本地，所以本地文件才是长期可用的那份。

## 开发

```bash
node --test tests/plugin.test.mjs   # 本地 mock API，不需要密钥
```

## 许可

MIT
