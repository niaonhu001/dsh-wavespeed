/**
 * wavespeed: WaveSpeedAI 模型接入（生图 / 生视频 / 其它产出）。
 *
 * 链路：查模型目录 → 提交任务 → 轮询结果 → 产物落盘（图片进 DSH 附件直接显示，
 * 视频等文件下载到本地并回报路径）。
 *
 * 密钥：DSH 凭据里同名条目（默认 WAVESPEED_API_KEY）优先，其次进程环境变量。
 */
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const name = 'wavespeed'
export const inject = ['tools']

/** 设置面板路由前缀；客户端与宿主共用这一处定义。 */
const ROUTE_PREFIX = '/dsh-wavespeed'

const DEFAULTS = {
  apiKeyEnv: 'WAVESPEED_API_KEY',
  apiKey: '',
  baseUrl: 'https://api.wavespeed.ai/api/v3',
  pollIntervalMs: 2000,
  maxPollIntervalMs: 8000,
  waitMs: 300000,
  downloadDir: '',
  catalogTtlMs: 600000,
  maxImages: 8,
  maxDownloadBytes: 512 * 1024 * 1024,
}

/** 已终态但失败的预测状态。 */
const FAILURE_STATUSES = new Set(['failed', 'cancelled', 'timeout', 'deleted'])

/** 值可能是本地文件的模型参数名；命中且文件存在时自动上传成 URL。 */
const MEDIA_KEYS = new Set([
  'image', 'images', 'mask', 'last_frame_image', 'reference_image', 'reference_images',
  'init_image', 'source_image', 'input_image', 'start_image', 'end_image', 'first_frame_image',
  'video', 'videos', 'audio', 'audio_file', 'image_url', 'video_url',
])

const EXT_BY_TYPE = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'application/zip': '.zip',
}

/** 一次 API 调用失败；`kind` 让调用方区分「提交未成」与「任务本身失败」。 */
class WaveSpeedError extends Error {
  constructor(message, { status, code, kind, payload } = {}) {
    super(message)
    this.name = 'WaveSpeedError'
    this.status = status
    this.code = code
    this.kind = kind
    this.payload = payload
  }
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 设置面板写入的非机密偏好（密钥单独进 DSH 凭据库，不落这里）。 */
function prefsFile() {
  return join(dshHome(), 'dsh-wavespeed', 'settings.json')
}

/**
 * 读取偏好文件；缺失、损坏或字段类型不对时按默认值处理。
 * @returns {{baseUrl?: string, waitMs?: number, downloadDir?: string}} 清洗后的偏好。
 */
function loadPrefs() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(prefsFile(), 'utf8'))
  } catch {
    return {}
  }
  const prefs = {}
  if (typeof parsed?.baseUrl === 'string' && /^https?:\/\//.test(parsed.baseUrl)) prefs.baseUrl = parsed.baseUrl
  if (Number.isFinite(parsed?.waitMs) && parsed.waitMs >= 5000) prefs.waitMs = Math.min(parsed.waitMs, 3600000)
  if (typeof parsed?.downloadDir === 'string' && parsed.downloadDir.trim() !== '') prefs.downloadDir = parsed.downloadDir
  return prefs
}

/**
 * 合并并写回偏好；空串或 undefined 表示删除该覆盖，回到 cordis 配置的默认值。
 * @param {object} patch - 要覆盖或清除的字段。
 * @returns {Promise<object>} 写回后的偏好。
 */
async function savePrefs(patch) {
  const next = { ...loadPrefs() }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '') delete next[key]
    else next[key] = value
  }
  await mkdir(dirname(prefsFile()), { recursive: true })
  await writeFile(prefsFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/**
 * cordis 配置叠加设置面板保存的偏好，得到本次调用真正生效的配置。
 * @param {object} base - cordis 配置解析结果。
 * @returns {object} 合并后的配置。
 */
function effectiveSettings(base) {
  return resolveConfig({ ...base, ...loadPrefs() })
}

function respondJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk.toString('utf8')
      if (data.length > limit) {
        req.destroy()
        reject(new Error('请求体过大'))
      }
    })
    req.on('end', () => {
      if (data === '') return resolvePromise({})
      try {
        resolvePromise(JSON.parse(data))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 设置面板读的那份状态：密钥只报「有没有、从哪来、能不能写」，永不回传值。
 * @param {object} ctx - 插件上下文（用于取凭据服务）。
 * @param {object} base - cordis 配置解析结果。
 * @param {() => object} current - 读取当前生效配置。
 * @returns {Promise<object>} 面板状态。
 */
async function describeSettings(ctx, base, current) {
  const settings = current()
  const credentials = service(ctx, 'credentials')
  let info = { configured: false, writable: false, source: undefined }
  if (credentials && typeof credentials.describe === 'function') {
    try {
      info = await credentials.describe(base.apiKeyEnv)
    } catch {
      // 凭据服务不认识该条目时按「未配置」展示，面板仍可保存。
    }
  }
  const envSet = Boolean(process.env[base.apiKeyEnv])
  return {
    keyName: base.apiKeyEnv,
    keyConfigured: Boolean(base.apiKey) || Boolean(info.configured) || envSet,
    keySource: base.apiKey ? 'config' : (info.source ?? (envSet ? 'env' : null)),
    keyWritable: Boolean(info.writable),
    baseUrl: settings.baseUrl,
    defaultBaseUrl: base.baseUrl,
    waitMs: settings.waitMs,
    downloadDir: settings.downloadDir,
    defaultDownloadDir: base.downloadDir,
  }
}

/**
 * GET 返回面板状态；POST 保存密钥（进凭据库）与偏好（进 settings.json）。
 * @param {object} ctx - 插件上下文。
 * @param {object} base - cordis 配置解析结果。
 * @param {() => object} current - 读取当前生效配置。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @returns {Promise<void>} 响应写完后返回。
 */
async function handleSettingsRoute(ctx, base, current, req, res) {
  if (req.method === 'GET') {
    try {
      respondJson(res, 200, { ok: true, value: await describeSettings(ctx, base, current) })
    } catch (error) {
      respondJson(res, 200, { ok: false, error: error?.message ?? String(error) })
    }
    return
  }
  if (req.method !== 'POST') {
    respondJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  try {
    const body = await readJsonBody(req)
    const credentials = service(ctx, 'credentials')
    if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') {
      if (typeof credentials?.set !== 'function') throw new Error('宿主没有挂载凭据服务，无法保存密钥')
      await credentials.set(base.apiKeyEnv, body.apiKey.trim())
    }
    if (body.clearApiKey === true) {
      if (typeof credentials?.unset !== 'function') throw new Error('宿主没有挂载凭据服务，无法清除密钥')
      await credentials.unset(base.apiKeyEnv)
    }
    const patch = {}
    if (typeof body.baseUrl === 'string') {
      const value = body.baseUrl.trim().replace(/\/+$/, '')
      if (value !== '' && !/^https?:\/\//.test(value)) throw new Error('服务地址必须是 http(s) URL')
      patch.baseUrl = value
    }
    if (typeof body.waitMs === 'number') {
      if (!Number.isFinite(body.waitMs) || body.waitMs < 5000 || body.waitMs > 3600000) throw new Error('等待时长需在 5–3600 秒之间')
      patch.waitMs = Math.round(body.waitMs)
    }
    if (typeof body.downloadDir === 'string') patch.downloadDir = body.downloadDir.trim()
    if (Object.keys(patch).length > 0) await savePrefs(patch)
    respondJson(res, 200, { ok: true, value: await describeSettings(ctx, base, current) })
  } catch (error) {
    respondJson(res, 200, { ok: false, error: error?.message ?? String(error) })
  }
}

/**
 * 用当前密钥打一次余额接口，验证配置是否真的能用。
 * @param {object} ctx - 插件上下文。
 * @param {object} base - cordis 配置解析结果。
 * @param {() => object} current - 读取当前生效配置。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @returns {Promise<void>} 响应写完后返回。
 */
async function handleTestRoute(ctx, base, current, req, res) {
  if (req.method !== 'POST') {
    respondJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  const started = Date.now()
  try {
    const settings = current()
    const key = await resolveApiKey(ctx, settings)
    const payload = await requestJson(`${settings.baseUrl}/balance`, { key, retries: 0, timeoutMs: 20000 })
    const balance = payload?.data?.balance
    respondJson(res, 200, { ok: true, value: { balance: balance === undefined ? null : Number(balance), latencyMs: Date.now() - started } })
  } catch (error) {
    respondJson(res, 200, { ok: false, error: error?.message ?? String(error) })
  }
}

function service(ctx, key) {
  if (!ctx) return undefined
  try {
    if (typeof ctx.get === 'function') return ctx.get(key)
  } catch {
    // 服务未挂载：宿主没有该能力，交给调用方降级。
  }
  return ctx[key]
}

function sleep(ms, signal) {
  signal?.throwIfAborted()
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('已取消'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function withTimeout(signal, ms) {
  const timer = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timer]) : timer
}

function positive(config, key, fallback) {
  const value = config[key] ?? fallback
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name}: 配置项 ${key} 必须是正数`)
  return value
}

/**
 * 校验并补全配置。
 * @param {Record<string, unknown>} config - cordis.patch.yml 里该行的 config。
 * @returns {object} 完整配置。
 */
export function resolveConfig(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${name}: config 必须是对象`)
  }
  const baseUrl = String(config.baseUrl ?? DEFAULTS.baseUrl)
  if (!/^https?:\/\//.test(baseUrl)) throw new Error(`${name}: baseUrl 必须是 http(s) 地址`)
  const apiKeyEnv = String(config.apiKeyEnv ?? DEFAULTS.apiKeyEnv)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error(`${name}: apiKeyEnv 必须是 POSIX 环境变量名（例如 WAVESPEED_API_KEY）`)
  }
  return {
    apiKeyEnv,
    apiKey: String(config.apiKey ?? ''),
    baseUrl: baseUrl.replace(/\/+$/, ''),
    pollIntervalMs: positive(config, 'pollIntervalMs', DEFAULTS.pollIntervalMs),
    maxPollIntervalMs: positive(config, 'maxPollIntervalMs', DEFAULTS.maxPollIntervalMs),
    waitMs: positive(config, 'waitMs', DEFAULTS.waitMs),
    downloadDir: String(config.downloadDir || join(dshHome(), 'wavespeed-cache')),
    catalogTtlMs: positive(config, 'catalogTtlMs', DEFAULTS.catalogTtlMs),
    maxImages: positive(config, 'maxImages', DEFAULTS.maxImages),
    maxDownloadBytes: positive(config, 'maxDownloadBytes', DEFAULTS.maxDownloadBytes),
  }
}

/**
 * 解析 API Key：显式配置 > DSH 凭据 > 环境变量。
 * @param {object} ctx - 插件上下文。
 * @param {object} settings - resolveConfig 的结果。
 * @returns {Promise<string>} 非空密钥。
 */
export async function resolveApiKey(ctx, settings) {
  if (settings.apiKey) return settings.apiKey
  const credentials = service(ctx, 'credentials')
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(settings.apiKeyEnv)
      if (hit && typeof hit.value === 'string' && hit.value) return hit.value
    } catch {
      // 凭据服务读不到（未挂载或不认识该条目）时退回环境变量。
    }
  }
  const ambient = process.env[settings.apiKeyEnv]
  if (ambient) return ambient
  throw new Error(
    `没有拿到 WaveSpeed API Key：在 DSH 凭据里设置 ${settings.apiKeyEnv}（或在启动 DSH 前导出同名环境变量）。`
    + ' 密钥在 https://wavespeed.ai/accesskey 生成。',
  )
}

function retryDelay(response, attempt) {
  const header = response?.headers?.get?.('retry-after')
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30000)
  return Math.min(2000 * 2 ** attempt, 15000)
}

/**
 * 调一次 WaveSpeed 接口并返回已解析的 JSON。
 * GET 对 429/5xx/网络错误自动退避重试；POST 不重试（重复提交会重复扣费）。
 * @param {string} url - 完整地址。
 * @param {object} options - 方法、请求体、密钥、取消信号、超时与重试次数。
 * @returns {Promise<object>} 响应 JSON。
 */
async function requestJson(url, { method = 'GET', key, body, signal, timeoutMs = 60000, retries } = {}) {
  const maxRetries = retries ?? (method === 'GET' ? 3 : 0)
  const headers = { Authorization: `Bearer ${key}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: withTimeout(signal, timeoutMs),
      })
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      if (attempt < maxRetries) {
        await sleep(Math.min(2000 * 2 ** attempt, 15000), signal)
        continue
      }
      throw new WaveSpeedError(
        method === 'POST'
          ? '提交请求没有拿到响应（网络中断）。不要立刻重试：重复提交会重复扣费，先去 WaveSpeed 控制台确认有没有已创建的任务。'
          : `请求失败：${error?.message ?? error}`,
        { kind: 'network' },
      )
    }
    const text = await response.text()
    let payload
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      throw new WaveSpeedError(
        `WaveSpeed 返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 400)}`,
        { status: response.status, kind: 'protocol' },
      )
    }
    const code = payload?.code ?? response.status
    if (response.ok && code === 200) return payload
    const retryable = response.status === 429 || response.status >= 500
    if (retryable && attempt < maxRetries) {
      await sleep(retryDelay(response, attempt), signal)
      continue
    }
    const message = payload?.message || `HTTP ${response.status}`
    const scope = payload?.error_code === 'API_KEY_PERMISSION_FORBIDDEN'
      ? `（这把 key 的权限是 ${payload.key_scope ?? '未知'}，需要 ${payload.required_scope ?? 'inference'}）`
      : ''
    throw new WaveSpeedError(`${message}${scope}`, {
      status: response.status,
      code,
      kind: 'api',
      payload: { error_code: payload?.error_code, required_scope: payload?.required_scope, key_scope: payload?.key_scope },
    })
  }
}

const TYPE_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_TYPE).map(([type, ext]) => [ext, type]))

function contentExt(mediaType, ext = '') {
  const type = String(mediaType ?? '').split(';')[0].trim().toLowerCase()
  if (EXT_BY_TYPE[type]) return { ext: EXT_BY_TYPE[type], mediaType: type }
  const fromExt = TYPE_BY_EXT[ext.toLowerCase()]
  if (fromExt) return { ext: ext.toLowerCase(), mediaType: fromExt }
  return { ext: '.bin', mediaType: type || 'application/octet-stream' }
}

function extensionFromUrl(url) {
  try {
    const found = extname(new URL(url).pathname).toLowerCase()
    return found && found.length <= 6 ? found : ''
  } catch {
    return ''
  }
}

function safeName(predictionId, index, ext) {
  const stem = String(predictionId).replace(/[^\w.-]+/g, '_').slice(0, 80)
  return `${stem}-${index}${ext}`
}

/**
 * 把远程产物下载到本地；边写边计数，超过上限立刻中止。
 * @param {string} url - 产物地址。
 * @param {string} dest - 目标文件路径。
 * @param {object} options - 取消信号与字节上限。
 * @returns {Promise<number>} 落盘字节数。
 */
async function downloadToFile(url, dest, { signal, maxBytes }) {
  const response = await fetch(url, { signal: withTimeout(signal, 600000) })
  if (!response.ok) throw new WaveSpeedError(`下载产物失败（HTTP ${response.status}）：${url}`, { kind: 'download' })
  if (!response.body) throw new WaveSpeedError(`产物响应没有内容：${url}`, { kind: 'download' })
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WaveSpeedError(`产物超过 ${Math.round(maxBytes / 1048576)}MB 上限，未下载：${url}`, { kind: 'download' })
  }
  let total = 0
  await pipeline(
    Readable.fromWeb(response.body),
    async function* guard(source) {
      for await (const chunk of source) {
        total += chunk.length
        if (total > maxBytes) throw new WaveSpeedError(`产物超过上限，已中止下载：${url}`, { kind: 'download' })
        yield chunk
      }
    },
    createWriteStream(dest),
  )
  return total
}

async function downloadBytes(url, { signal, maxBytes }) {
  const response = await fetch(url, { signal: withTimeout(signal, 300000) })
  if (!response.ok) throw new WaveSpeedError(`下载产物失败（HTTP ${response.status}）：${url}`, { kind: 'download' })
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WaveSpeedError(`产物超过 ${Math.round(maxBytes / 1048576)}MB 上限`, { kind: 'download' })
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > maxBytes) throw new WaveSpeedError('产物超过大小上限', { kind: 'download' })
  return { bytes, mediaType: String(response.headers.get('content-type') ?? '') }
}

/**
 * 把一个本地媒体文件上传到 WaveSpeed，拿回可给模型当输入的 URL。
 * @param {string} path - 本地文件路径。
 * @param {object} options - 密钥、API 根地址与取消信号。
 * @returns {Promise<string>} download_url。
 */
async function uploadFile(path, { key, baseUrl, signal }) {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`不是文件：${path}`)
  if (info.size > 200 * 1024 * 1024) throw new Error(`文件超过 WaveSpeed 上传上限 200MB：${path}`)
  const ext = extname(path).toLowerCase()
  const contentType = Object.entries(EXT_BY_TYPE).find(([, value]) => value === ext)?.[0]
  const ticket = await requestJson(`${baseUrl}/media/uploads`, {
    method: 'POST',
    key,
    body: { filename: basename(path), size: info.size, ...(contentType ? { content_type: contentType } : {}) },
    signal,
  })
  const upload = ticket?.data?.upload
  const downloadUrl = ticket?.data?.download_url
  if (!upload?.url || !downloadUrl) {
    throw new WaveSpeedError('上传初始化没有返回上传地址或 download_url', { kind: 'protocol' })
  }
  const bytes = await readFile(path)
  const response = await fetch(upload.url, {
    method: upload.method || 'PUT',
    headers: upload.headers ?? {},
    body: bytes,
    signal: withTimeout(signal, 300000),
  })
  if (!response.ok) {
    throw new WaveSpeedError(`上传字节失败（HTTP ${response.status}）：${path}`, { kind: 'upload' })
  }
  return downloadUrl
}

function isLocalFile(value) {
  return typeof value === 'string'
    && value.length > 0
    && !/^https?:\/\//i.test(value)
    && !/^data:/i.test(value)
    && existsSync(value)
}

async function uploadLocalMedia(body, options) {
  const uploaded = []
  for (const [key, value] of Object.entries(body)) {
    if (!MEDIA_KEYS.has(key)) continue
    if (isLocalFile(value)) {
      body[key] = await uploadFile(value, options)
      uploaded.push(`${key}: ${basename(value)}`)
    } else if (Array.isArray(value)) {
      const next = []
      for (const item of value) {
        if (isLocalFile(item)) {
          next.push(await uploadFile(item, options))
          uploaded.push(`${key}: ${basename(item)}`)
        } else {
          next.push(item)
        }
      }
      body[key] = next
    }
  }
  return uploaded
}

function describeType(node) {
  if (!node || typeof node !== 'object') return 'any'
  if (Array.isArray(node.enum)) return `enum(${node.enum.join('|')})`
  if (node.type) return node.type
  return 'any'
}

/**
 * 渲染一个模型的参数表，供模型自己核对后再调用。
 * @param {object} model - 目录里的模型条目。
 * @returns {string} 多行文本。
 */
export function formatModelSchema(model) {
  const run = model?.api_schema?.api_schemas?.find(entry => entry?.type === 'model_run')
    ?? model?.api_schema?.api_schemas?.[0]
  const schema = run?.request_schema
  const props = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  const lines = []
  for (const [key, node] of Object.entries(props)) {
    const flag = required.has(key) ? '必填' : '可选'
    const bits = [`- ${key} (${flag}, ${describeType(node)})`]
    if (node?.default !== undefined) bits.push(`默认 ${JSON.stringify(node.default)}`)
    if (node?.minimum !== undefined || node?.maximum !== undefined) {
      bits.push(`范围 ${node.minimum ?? '-∞'}..${node.maximum ?? '+∞'}`)
    }
    const description = String(node?.description ?? '').replace(/\s+/g, ' ').trim()
    if (description) bits.push(description.slice(0, 160))
    lines.push(bits.join(' · '))
  }
  return lines.join('\n') || '（该模型没有公开参数表）'
}

function validateAgainstSchema(modelId, schema, body, warnings) {
  const props = schema?.properties
  if (!props || typeof props !== 'object') return
  const missing = (schema.required ?? []).filter(key => body[key] === undefined)
  if (missing.length) {
    throw new Error(
      `${modelId} 缺少必填参数：${missing.join('、')}。先用 wavespeed_models model="${modelId}" 看参数表。`,
    )
  }
  for (const [key, value] of Object.entries(body)) {
    const node = props[key]
    if (!node) {
      warnings.push(`参数 ${key} 不在该模型的参数表里；若被拒，请核对参数名。`)
      continue
    }
    if (Array.isArray(node.enum) && !node.enum.includes(value)) {
      warnings.push(`参数 ${key}=${JSON.stringify(value)} 不在枚举 ${node.enum.join('|')} 里。`)
    }
  }
}

/**
 * 轮询一个预测直到终态或超过等待预算。
 * @param {string} id - prediction id。
 * @param {object} options - 密钥、地址、间隔、截止时间与取消信号。
 * @returns {Promise<object>} 预测数据；仍有余量时带 `pending: true`。
 */
async function pollPrediction(id, { key, baseUrl, signal, intervalMs, maxIntervalMs, deadline }) {
  let attempt = 0
  for (;;) {
    const payload = await requestJson(`${baseUrl}/predictions/${encodeURIComponent(id)}/result`, { key, signal })
    const data = payload?.data ?? {}
    const status = data.status
    if (status === 'completed') return data
    if (FAILURE_STATUSES.has(status)) {
      const reason = data.error || data.message || status
      throw new WaveSpeedError(`任务 ${id} ${status}：${reason}`, { kind: 'prediction', status })
    }
    if (Date.now() >= deadline) return { ...data, pending: true }
    await sleep(Math.min(intervalMs * 1.6 ** attempt, maxIntervalMs), signal)
    attempt++
  }
}

/**
 * 产物落地：图片进 DSH 附件（聊天里直接显示），其余写成本地文件。
 * @param {string[]} outputs - 产物 URL 列表。
 * @param {object} options - 上下文、配置、预测 id 与取消信号。
 * @returns {Promise<{images: object[], files: object[], notes: string[]}>} 落地结果。
 */
async function materializeOutputs(outputs, { ctx, settings, predictionId, signal }) {
  const images = []
  const files = []
  const notes = []
  const attachments = service(ctx, 'attachments')
  const allowed = new Set(attachments?.imageLimits?.mediaTypes ?? [])
  const imageCap = Math.min(settings.maxImages, attachments?.imageLimits?.maxImagesPerMessage ?? settings.maxImages)
  const dir = settings.downloadDir
  await mkdir(dir, { recursive: true })
  for (const [index, raw] of outputs.entries()) {
    signal?.throwIfAborted()
    const url = String(raw)
    if (!url) continue
    const urlExt = extensionFromUrl(url)
    let urlPath = ''
    try {
      urlPath = new URL(url).pathname
    } catch {
      // 不是合法 URL：交给下载步骤报错。
    }
    const looksImage = /\.(png|jpe?g|webp|gif)$/i.test(urlPath) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)
    if (looksImage && attachments && images.length < imageCap) {
      try {
        const { bytes, mediaType } = await downloadBytes(url, { signal, maxBytes: 64 * 1024 * 1024 })
        const kind = contentExt(mediaType, urlExt)
        if (kind.mediaType.startsWith('image/') && (!allowed.size || allowed.has(kind.mediaType))) {
          const [ref] = await attachments.saveImages([{ data: bytes, mediaType: kind.mediaType, name: safeName(predictionId, index, kind.ext) }])
          images.push(ref)
          continue
        }
        notes.push(`第 ${index + 1} 张图片的类型 ${kind.mediaType || '未知'} 不被当前附件服务接受，已另存为文件。`)
      } catch (error) {
        notes.push(`第 ${index + 1} 张图片没能作为附件保存（${error?.message ?? error}），已另存为文件。`)
      }
    }
    const path = join(dir, safeName(predictionId, index, urlExt || '.bin'))
    try {
      const bytes = await downloadToFile(url, path, { signal, maxBytes: settings.maxDownloadBytes })
      files.push({ path, url, bytes })
    } catch (error) {
      notes.push(`第 ${index + 1} 个产物下载失败：${error?.message ?? error}`)
      files.push({ path: '', url, bytes: 0 })
    }
  }
  return { images, files, notes }
}

function formatBytes(bytes) {
  if (!bytes) return '未知大小'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

/**
 * 把一次任务结果写成模型可读的文本。
 * @param {object} options - 模型、预测数据、落地产物与提示。
 * @returns {string} 面向模型的文本。
 */
function renderOutcome({ model, data, images, files, notes, pending, warnings }) {
  const lines = []
  lines.push(`model: ${model ?? data.model ?? '未知'}`)
  lines.push(`prediction: ${data.id}   status: ${data.status ?? '未知'}`)
  if (data.created_at) lines.push(`created: ${data.created_at}`)
  if (pending) {
    lines.push('')
    lines.push('任务还在跑，产物未就绪。用 wavespeed_result 带上这个 prediction id 继续取；不要重复提交（会重复扣费）。')
  } else if (images.length || files.length) {
    lines.push('')
    lines.push(`产出 ${images.length} 张图片、${files.length} 个文件：`)
    for (const item of files) {
      lines.push(item.path ? `- ${item.path} (${formatBytes(item.bytes)})` : `- 下载失败，原始地址：${item.url}`)
    }
  } else if (!pending) {
    lines.push('')
    lines.push('任务已完成，但没有返回产物。')
  }
  if (notes.length) lines.push('', ...notes.map(note => `[说明] ${note}`))
  if (warnings.length) lines.push('', ...warnings.map(warning => `[提示] ${warning}`))
  return lines.join('\n')
}

const TOOL_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      images: { type: 'array', items: { type: 'object' } },
      files: { type: 'array', items: { type: 'object' } },
    },
    required: ['text', 'images', 'files'],
  },
  render: (_args, value) => [
    { type: 'text', text: value.text },
    ...value.images.map(attachment => ({ type: 'image', attachment })),
  ],
}

export function apply(ctx, config = {}) {
  const base = resolveConfig(config)
  const runtime = { catalog: null, catalogAt: 0 }
  const current = () => effectiveSettings(base)

  async function catalogFor(settings, key, signal, refresh) {
    if (!refresh && runtime.catalog && Date.now() - runtime.catalogAt < settings.catalogTtlMs) {
      return runtime.catalog
    }
    const payload = await requestJson(`${settings.baseUrl}/models`, { key, signal, timeoutMs: 120000 })
    runtime.catalog = Array.isArray(payload?.data) ? payload.data : []
    runtime.catalogAt = Date.now()
    return runtime.catalog
  }

  async function schemaFor(settings, model, key, signal) {
    try {
      const models = await catalogFor(settings, key, signal, false)
      const hit = models.find(entry => entry?.model_id === model)
      if (!hit) return { schema: null, known: false }
      const run = hit.api_schema?.api_schemas?.find(entry => entry?.type === 'model_run')
        ?? hit.api_schema?.api_schemas?.[0]
      return { schema: run?.request_schema ?? null, known: true }
    } catch {
      // 目录拿不到不该挡住生成：跳过参数预校验，直接让 API 说话。
      return { schema: null, known: true }
    }
  }

  async function collect(settings, data, model, signal, extra = {}) {
    const outputs = Array.isArray(data.outputs) ? data.outputs : []
    const landed = data.pending || !outputs.length
      ? { images: [], files: [], notes: [] }
      : await materializeOutputs(outputs, { ctx, settings, predictionId: data.id, signal })
    return {
      text: renderOutcome({ model, data, pending: data.pending === true, warnings: extra.warnings ?? [], ...landed }),
      images: landed.images,
      files: landed.files,
    }
  }

  ctx.effect(() => ctx.tools.register({
    name: 'wavespeed_models',
    description: '查询 WaveSpeedAI 模型目录：用 query/type 找模型 id；给 model 返回该模型完整的参数表（必填项、枚举、默认值、范围）。'
      + '生图先查 type=text-to-image（或 image-to-image），生视频查 text-to-video / image-to-video。'
      + '把参数写进 wavespeed_generate 之前，先用这里核对参数名——模型之间参数不通用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        model: { type: 'string', description: '精确模型 id（例如 wavespeed-ai/z-image/turbo）；给了就只返回它的参数表' },
        query: { type: 'string', description: '关键词，匹配模型 id 与描述（例如 flux、kling、seedream）' },
        type: { type: 'string', description: '模型类型过滤，例如 text-to-image、image-to-video、text-to-video' },
        limit: { type: 'integer', description: '最多返回多少个模型，默认 20，上限 100' },
        refresh: { type: 'boolean', description: '绕过目录缓存重新拉取' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          models: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'models'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      const signal = exec?.signal
      const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 100) : 20
      const settings = current()
      const key = await resolveApiKey(ctx, settings)
      const models = await catalogFor(settings, key, signal, args.refresh === true)
      if (args.model) {
        const hit = models.find(entry => entry?.model_id === args.model)
        if (!hit) {
          const near = models
            .map(entry => String(entry?.model_id ?? ''))
            .filter(id => id.includes(String(args.model).split('/').pop() ?? ''))
            .slice(0, 8)
          return {
            text: `目录里没有 ${args.model}。`
              + (near.length ? `相近的有：\n${near.map(id => `- ${id}`).join('\n')}` : '换个关键词或用 query/types 再找。'),
            models: near,
          }
        }
        const price = hit.base_price === undefined ? '未知' : `$${hit.base_price}`
        const text = [
          `${hit.model_id}  [${hit.type ?? '未知类型'}]  基础价 ${price}`,
          '（base_price 不是报价：视频按时长/分辨率、图片按尺寸另算，扣费以提交时服务端计价为准）',
          hit.description ? String(hit.description).slice(0, 400) : '',
          '',
          '参数表（写进 wavespeed_generate 的 params）：',
          formatModelSchema(hit),
        ].filter(Boolean).join('\n')
        return { text, models: [hit.model_id] }
      }
      const typeFilter = String(args.type ?? '').toLowerCase()
      const query = String(args.query ?? '').toLowerCase()
      const matched = models.filter((entry) => {
        const modelId = String(entry?.model_id ?? '')
        const type = String(entry?.type ?? '').toLowerCase()
        if (typeFilter && !type.includes(typeFilter)) return false
        if (query && !(`${modelId} ${entry?.description ?? ''}`.toLowerCase().includes(query))) return false
        return true
      })
      const slice = matched.slice(0, limit)
      const types = [...new Set(models.map(entry => String(entry?.type ?? '')).filter(Boolean))].sort()
      const lines = [
        `目录共 ${models.length} 个模型，命中 ${matched.length} 个${matched.length > slice.length ? `（只列前 ${slice.length} 个）` : ''}：`,
        '（价格是 base_price 基础价，不是报价；视频按时长/分辨率另算）',
        ...slice.map((entry) => {
          const price = entry?.base_price === undefined ? '?' : `$${entry.base_price}`
          const description = String(entry?.description ?? '').replace(/\s+/g, ' ').slice(0, 70)
          return `- ${entry?.model_id} [${entry?.type ?? '?'}] ${price}${description ? ` — ${description}` : ''}`
        }),
      ]
      if (!matched.length) lines.push('', `可用的 type 有：${types.join('、')}`)
      return { text: lines.join('\n'), models: slice.map(entry => String(entry?.model_id ?? '')) }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'wavespeed_generate',
    description: '提交一个 WaveSpeedAI 模型任务并等结果。model 必填（先用 wavespeed_models 查 id 和参数表）；'
      + 'prompt 单独传，其余模型参数放 params（size、duration、resolution、image、seed…）。'
      + 'params 里给本地图片/视频路径会自动上传成 URL（图生视频直接传本地图即可）。'
      + '图片产出直接作为附件显示；视频等文件下载到本地并回报路径。'
      + '视频耗时较长，超过等待预算会返回 prediction id，用 wavespeed_result 继续取；不要重复提交。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        model: { type: 'string', description: '模型 id，必须是 wavespeed_models 里出现过的完整 id' },
        prompt: { type: 'string', description: '提示词（有些模型不需要，交给 params 也行）' },
        params: {
          type: 'object',
          additionalProperties: true,
          description: '模型自身参数对象；本地媒体文件路径会自动上传',
        },
        waitSeconds: {
          type: 'integer',
          description: '最多等多少秒（0 = 提交后立刻返回 prediction id）。默认用配置的 waitMs',
        },
      },
      required: ['model'],
    },
    output: TOOL_OUTPUT,
    // 内部轮询按当前配置的 waitMs 收口；这里只是兜底上限，不随设置变化。
    timeoutMs: 3600000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const signal = exec?.signal
      const settings = current()
      const key = await resolveApiKey(ctx, settings)
      const body = { ...(args.params ?? {}) }
      if (args.prompt !== undefined && args.prompt !== '') body.prompt = args.prompt
      const warnings = []
      const { schema, known } = await schemaFor(settings, args.model, key, signal)
      if (schema) validateAgainstSchema(args.model, schema, body, warnings)
      else if (!known) warnings.push(`目录里没找到 ${args.model}，跳过参数预校验（拼错的话会提交失败）。`)
      const uploaded = await uploadLocalMedia(body, { key, baseUrl: settings.baseUrl, signal })
      if (uploaded.length) warnings.push(`已上传本地素材：${uploaded.join('，')}`)
      const submitted = await requestJson(`${settings.baseUrl}/${args.model}`, {
        method: 'POST',
        key,
        body,
        signal,
      })
      const data = submitted?.data ?? {}
      if (!data.id) {
        throw new WaveSpeedError(`提交后没有返回 prediction id：${JSON.stringify(submitted).slice(0, 400)}`, { kind: 'protocol' })
      }
      const requested = args.waitSeconds === undefined
        ? settings.waitMs
        : Math.min(Math.max(Number(args.waitSeconds) || 0, 0) * 1000, settings.waitMs)
      let result = { ...data }
      if (requested > 0 && data.status !== 'completed') {
        result = await pollPrediction(data.id, {
          key,
          baseUrl: settings.baseUrl,
          signal,
          intervalMs: settings.pollIntervalMs,
          maxIntervalMs: settings.maxPollIntervalMs,
          deadline: Date.now() + requested,
        })
      } else if (data.status !== 'completed') {
        result = { ...data, pending: true }
      }
      return collect(settings, { ...result, id: data.id, model: data.model ?? args.model }, args.model, signal, { warnings })
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'wavespeed_result',
    description: '按 prediction id 取 WaveSpeedAI 任务的结果：完成了就把图片转成附件、视频等下载到本地；'
      + '还在跑就回报当前状态，可以隔一会儿再调。可重复调用，不会重复扣费。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'prediction id（提交任务时返回的 data.id，形如 pred_xxx）' },
        waitSeconds: { type: 'integer', description: '这次最多等多少秒，默认 0（立刻查一次）' },
      },
      required: ['id'],
    },
    output: TOOL_OUTPUT,
    timeoutMs: 900000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const signal = exec?.signal
      const settings = current()
      const key = await resolveApiKey(ctx, settings)
      const waitMs = Math.min(Math.max(Number(args.waitSeconds) || 0, 0) * 1000, settings.waitMs)
      const data = waitMs > 0
        ? await pollPrediction(args.id, {
          key,
          baseUrl: settings.baseUrl,
          signal,
          intervalMs: settings.pollIntervalMs,
          maxIntervalMs: settings.maxPollIntervalMs,
          deadline: Date.now() + waitMs,
        })
        : (await requestJson(`${settings.baseUrl}/predictions/${encodeURIComponent(args.id)}/result`, { key, signal })).data ?? {}
      if (FAILURE_STATUSES.has(data.status)) {
        return {
          text: `prediction ${args.id} 已是终态 ${data.status}：${data.error || data.message || '没有更多信息'}`,
          images: [],
          files: [],
        }
      }
      const pending = data.status !== 'completed'
      return collect(settings, { ...data, id: args.id, pending }, data.model, signal)
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'wavespeed_balance',
    description: '查看 WaveSpeedAI 账户余额（美元）。跑视频这类较贵的任务前可以先确认余额。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 60000,
    async execute(_args, exec) {
      const settings = current()
      const key = await resolveApiKey(ctx, settings)
      const payload = await requestJson(`${settings.baseUrl}/balance`, { key, signal: exec?.signal })
      const balance = payload?.data?.balance
      return { text: `WaveSpeedAI 余额：$${balance === undefined ? '未知' : Number(balance).toFixed(2)}` }
    },
  }))

  // 设置面板的宿主侧：没有 webServer 时只保留工具，不阻断插件。
  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      const disposers = [
        child.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/settings`,
          handler: (req, res) => handleSettingsRoute(ctx, base, current, req, res),
        }),
        child.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/test`,
          handler: (req, res) => handleTestRoute(ctx, base, current, req, res),
        }),
      ]
      return () => {
        for (const dispose of disposers) {
          try {
            if (typeof dispose === 'function') dispose()
            else dispose?.dispose?.()
          } catch {
            // 上下文销毁时路由随之一并释放，重复释放不算错。
          }
        }
      }
    })
  })
}

export { DEFAULTS }
