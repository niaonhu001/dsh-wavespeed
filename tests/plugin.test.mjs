import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, resolveConfig } from '../index.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const CATALOG = [
  {
    model_id: 'wavespeed-ai/z-image/turbo',
    name: 'Z-Image Turbo',
    type: 'text-to-image',
    base_price: 0.01,
    description: 'Fast photorealistic image model',
    api_schema: {
      api_schemas: [{
        type: 'model_run',
        request_schema: {
          properties: {
            prompt: { type: 'string', description: 'positive prompt' },
            size: { type: 'string', enum: ['1024*1024', '512*512'], default: '1024*1024' },
          },
          required: ['prompt'],
        },
      }],
    },
  },
  {
    model_id: 'wavespeed-ai/minimax-h3/image-to-video',
    name: 'MiniMax H3 I2V',
    type: 'image-to-video',
    base_price: 0.2,
    description: 'Animate a still image',
    api_schema: {
      api_schemas: [{
        type: 'model_run',
        request_schema: {
          properties: {
            prompt: { type: 'string' },
            image: { type: 'string' },
            duration: { type: 'integer', minimum: 5, maximum: 10, default: 5 },
          },
          required: ['prompt', 'image'],
        },
      }],
    },
  },
  {
    model_id: 'wavespeed-ai/wan/t2v',
    name: 'Wan',
    type: 'text-to-video',
    base_price: 0.3,
    description: 'Text to video',
  },
]

function startServer() {
  const state = {
    base: '',
    submissions: [],
    predictions: new Map(),
    uploads: [],
    counter: 0,
    polls: 0,
  }
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    const send = (body, status = 200, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && path === '/api/v3/models') return send({ code: 200, data: CATALOG })
    if (req.method === 'GET' && path === '/api/v3/balance') return send({ code: 200, data: { balance: 12.5 } })
    if (req.method === 'POST' && path === '/api/v3/media/uploads') {
      return send({
        code: 200,
        data: {
          download_url: `${state.base}/media/uploaded.png`,
          upload: { method: 'PUT', url: `${state.base}/put/1`, headers: { 'Content-Type': 'image/png' } },
        },
      })
    }
    if (req.method === 'PUT' && path === '/put/1') {
      state.uploads.push(raw)
      res.writeHead(200)
      return res.end('')
    }
    const resultMatch = path.match(/^\/api\/v3\/predictions\/([^/]+)\/result$/)
    if (req.method === 'GET' && resultMatch) {
      const prediction = state.predictions.get(resultMatch[1])
      if (!prediction) return send({ code: 404, message: 'prediction not found' }, 404)
      state.polls++
      prediction.polls = (prediction.polls ?? 0) + 1
      if (prediction.polls <= (prediction.completeAfter ?? 0)) {
        return send({ code: 200, data: { id: prediction.id, model: prediction.model, status: 'processing', outputs: [] } })
      }
      if (prediction.fail) {
        return send({ code: 200, data: { id: prediction.id, model: prediction.model, status: 'failed', error: 'model exploded' } })
      }
      return send({
        code: 200,
        data: { id: prediction.id, model: prediction.model, status: 'completed', outputs: prediction.outputs },
      })
    }
    if (req.method === 'POST' && path.startsWith('/api/v3/')) {
      const model = path.slice('/api/v3/'.length)
      state.submissions.push({ model, body: JSON.parse(raw.toString('utf8') || '{}') })
      state.counter += 1
      const id = `pred_${state.counter}`
      const prediction = { id, model, outputs: state.nextOutputs ?? [`${state.base}/files/out.png`] }
      if (state.nextFail) prediction.fail = true
      state.predictions.set(id, prediction)
      state.nextOutputs = undefined
      state.nextFail = undefined
      return send({ code: 200, data: { id, model, status: 'created', urls: { get: `${state.base}/api/v3/predictions/${id}/result` } } })
    }
    if (req.method === 'GET' && path.startsWith('/media/')) {
      res.writeHead(200, { 'content-type': 'image/png' })
      return res.end(PNG)
    }
    if (req.method === 'GET' && path.startsWith('/files/')) {
      if (path.endsWith('.mp4')) {
        res.writeHead(200, { 'content-type': 'video/mp4' })
        return res.end(Buffer.from('mp4data'))
      }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) })
      return res.end(PNG)
    }
    send({ code: 404, message: `no route ${req.method} ${path}` }, 404)
  })
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      state.base = `http://127.0.0.1:${server.address().port}`
      resolvePromise({ server, state })
    })
  })
}

function createHost({ withAttachments = true, extraServices = {} } = {}) {
  const tools = new Map()
  const routes = []
  const saved = []
  const services = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    ...extraServices,
  }
  if (withAttachments) {
    services.attachments = {
      imageLimits: {
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        maxImagesPerMessage: 4,
        maxMessageImageBytes: 32 * 1024 * 1024,
      },
      async saveImages(inputs) {
        return inputs.map((input, index) => {
          saved.push(input)
          return {
            attachmentId: `att_${saved.length}_${index}`,
            mediaType: input.mediaType,
            bytes: input.data.length,
            width: 1,
            height: 1,
            ...(input.name ? { name: input.name } : {}),
          }
        })
      },
    }
  }
  const ctx = {
    effect(fn) {
      return fn()
    },
    get(name) {
      return services[name]
    },
    inject(deps, callback) {
      if (!deps.every(dep => services[dep] !== undefined)) return
      // Cordis 的 child context 直接暴露注入的服务（child.webServer / child.credentials）。
      const child = { ...ctx, ...Object.fromEntries(deps.map(dep => [dep, services[dep]])) }
      callback(child)
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  return { ctx, tools, saved, services, routes }
}

let server
let mock
let workdir
let previousHome

before(async () => {
  ({ server, state: mock } = await startServer())
  workdir = await mkdtemp(join(tmpdir(), 'dsh-wavespeed-'))
  // 设置面板会把偏好写进 DSH_HOME；测试用临时目录，别动真实配置。
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = workdir
})

after(async () => {
  await new Promise(resolvePromise => server.close(resolvePromise))
  await rm(workdir, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

function boot(overrides = {}, hostOptions = {}) {
  const host = createHost(hostOptions)
  apply(host.ctx, {
    apiKey: 'test-key',
    baseUrl: mock.base + '/api/v3',
    pollIntervalMs: 10,
    maxPollIntervalMs: 20,
    waitMs: 5000,
    downloadDir: join(workdir, 'out'),
    ...overrides,
  })
  return host
}

test('config rejects bad values', () => {
  assert.throws(() => resolveConfig({ baseUrl: 'ftp://x' }), /baseUrl/)
  assert.throws(() => resolveConfig({ apiKeyEnv: 'not a var' }), /apiKeyEnv/)
  assert.throws(() => resolveConfig({ waitMs: 0 }), /waitMs/)
  const settings = resolveConfig({})
  assert.equal(settings.apiKeyEnv, 'WAVESPEED_API_KEY')
  assert.match(settings.downloadDir, /wavespeed-cache$/)
})

test('models lists catalog and renders a schema for one model', async () => {
  const { tools } = boot()
  const def = tools.get('wavespeed_models')
  const list = await def.execute({ type: 'text-to-image' }, {})
  assert.match(list.text, /z-image\/turbo/)
  assert.deepEqual(list.models, ['wavespeed-ai/z-image/turbo'])

  const one = await def.execute({ model: 'wavespeed-ai/z-image/turbo' }, {})
  assert.match(one.text, /prompt \(必填/)
  assert.match(one.text, /枚举|enum/)
})

test('generate returns image attachments for an image model', async () => {
  const { tools, saved } = boot()
  const def = tools.get('wavespeed_generate')
  const value = await def.execute({
    model: 'wavespeed-ai/z-image/turbo',
    prompt: 'a cat',
    params: { size: '1024*1024' },
  }, {})
  assert.equal(mock.submissions.at(-1).model, 'wavespeed-ai/z-image/turbo')
  assert.equal(mock.submissions.at(-1).body.prompt, 'a cat')
  assert.equal(value.images.length, 1)
  assert.equal(saved[0].mediaType, 'image/png')
  assert.ok(saved[0].data.equals(PNG))
  assert.match(value.text, /status: completed/)
  const blocks = def.output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.attachmentId, value.images[0].attachmentId)
})

test('generate saves a video to disk instead of attaching it', async () => {
  mock.nextOutputs = [`${mock.base}/files/clip.mp4`]
  const { tools } = boot()
  const def = tools.get('wavespeed_generate')
  const value = await def.execute({ model: 'wavespeed-ai/wan/t2v', prompt: 'a wave' }, {})
  assert.equal(value.images.length, 0)
  assert.equal(value.files.length, 1)
  assert.match(value.files[0].path, /\.mp4$/)
  const bytes = await readFile(value.files[0].path, 'utf8')
  assert.equal(bytes, 'mp4data')
  assert.match(value.text, /\.mp4/)
})

test('generate rejects a missing required param before submitting', async () => {
  const { tools } = boot()
  const def = tools.get('wavespeed_generate')
  const before = mock.submissions.length
  await assert.rejects(() => def.execute({ model: 'wavespeed-ai/minimax-h3/image-to-video', prompt: 'run' }, {}), /image/)
  assert.equal(mock.submissions.length, before)
})

test('generate uploads a local image passed as params.image', async () => {
  const local = join(workdir, 'local.png')
  await writeFile(local, PNG)
  const { tools } = boot()
  const def = tools.get('wavespeed_generate')
  await def.execute({
    model: 'wavespeed-ai/minimax-h3/image-to-video',
    prompt: 'slowly walk',
    params: { image: local, duration: 5 },
  }, {})
  const submitted = mock.submissions.at(-1)
  assert.equal(submitted.body.image, `${mock.base}/media/uploaded.png`)
  assert.equal(submitted.body.duration, 5)
  assert.equal(mock.uploads.at(-1).toString('base64'), PNG.toString('base64'))
})

test('generate reports pending and result finishes it', async () => {
  mock.nextOutputs = [`${mock.base}/files/out.png`]
  const { tools } = boot()
  const generate = tools.get('wavespeed_generate')
  const pending = await generate.execute({ model: 'wavespeed-ai/z-image/turbo', prompt: 'a cat', waitSeconds: 0 }, {})
  assert.match(pending.text, /还在跑/)
  assert.match(pending.text, /prediction: pred_\d+/)

  const id = pending.text.match(/prediction: (pred_\d+)/)[1]
  mock.predictions.get(id).completeAfter = 1
  const result = tools.get('wavespeed_result')
  const value = await result.execute({ id, waitSeconds: 5 }, {})
  assert.equal(value.images.length, 1)
  assert.match(value.text, /status: completed/)
})

test('failed predictions surface the model error', async () => {
  mock.nextFail = true
  const { tools } = boot()
  const before = mock.submissions.length
  await assert.rejects(
    () => tools.get('wavespeed_generate').execute({ model: 'wavespeed-ai/wan/t2v', prompt: 'x', waitSeconds: 2 }, {}),
    /failed.*model exploded/,
  )
  assert.equal(mock.submissions.length, before + 1)
})

test('balance reads the account amount', async () => {
  const { tools } = boot()
  const value = await tools.get('wavespeed_balance').execute({}, {})
  assert.match(value.text, /\$12\.50/)
})

test('missing api key explains how to configure it', async () => {
  const { tools } = boot({ apiKey: '' })
  const previous = process.env.WAVESPEED_API_KEY
  delete process.env.WAVESPEED_API_KEY
  try {
    await assert.rejects(() => tools.get('wavespeed_balance').execute({}, {}), /WAVESPEED_API_KEY/)
  } finally {
    if (previous !== undefined) process.env.WAVESPEED_API_KEY = previous
  }
})

test('images fall back to files when no attachment service is mounted', async () => {
  mock.nextOutputs = [`${mock.base}/files/out.png`]
  const { tools } = boot({}, { withAttachments: false })
  const value = await tools.get('wavespeed_generate').execute({ model: 'wavespeed-ai/z-image/turbo', prompt: 'x' }, {})
  assert.equal(value.images.length, 0)
  assert.equal(value.files.length, 1)
  assert.match(value.files[0].path, /\.png$/)
})

// ------------------------------------------------------------- settings routes

function fakeRequest(method, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  return stream
}

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(chunk) {
      this.body = String(chunk ?? '')
    },
  }
}

function inMemoryCredentials() {
  const store = new Map()
  return {
    store,
    async describe(name) {
      return { configured: store.has(name), writable: true, source: store.has(name) ? 'file' : undefined }
    },
    async set(name, value) {
      store.set(name, value)
    },
    async unset(name) {
      store.delete(name)
    },
    async resolve(name) {
      return store.has(name) ? { value: store.get(name), source: 'file' } : undefined
    },
  }
}

async function callRoute(routes, path, method, body) {
  const route = routes.find(entry => entry.path === path)
  assert.ok(route, `route ${path} is registered`)
  const res = fakeResponse()
  await route.handler(fakeRequest(method, body), res)
  return { status: res.status, payload: JSON.parse(res.body) }
}

function freshHome(name) {
  const home = join(workdir, name)
  process.env.DSH_HOME = home
  return home
}

test('settings route reports an unconfigured key and the effective defaults', async () => {
  freshHome('home-report')
  const credentials = inMemoryCredentials()
  const { routes } = boot({ apiKey: '' }, { extraServices: { credentials } })
  const { status, payload } = await callRoute(routes, '/dsh-wavespeed/settings', 'GET')
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.value.keyName, 'WAVESPEED_API_KEY')
  assert.equal(payload.value.keyConfigured, false)
  assert.equal(payload.value.keyWritable, true)
  assert.match(payload.value.baseUrl, /api\/v3$/)
})

test('saving a key writes the credential store and reports it configured', async () => {
  freshHome('home-save')
  const credentials = inMemoryCredentials()
  const { routes } = boot({ apiKey: '' }, { extraServices: { credentials } })
  const { payload } = await callRoute(routes, '/dsh-wavespeed/settings', 'POST', { apiKey: '  wsp_test_key  ' })
  assert.equal(payload.ok, true)
  assert.equal(credentials.store.get('WAVESPEED_API_KEY'), 'wsp_test_key')
  assert.equal(payload.value.keyConfigured, true)
  assert.equal(payload.value.keySource, 'file')
})

test('clearing the key removes the stored credential', async () => {
  freshHome('home-clear')
  const credentials = inMemoryCredentials()
  credentials.store.set('WAVESPEED_API_KEY', 'wsp_old')
  const { routes } = boot({ apiKey: '' }, { extraServices: { credentials } })
  const { payload } = await callRoute(routes, '/dsh-wavespeed/settings', 'POST', { clearApiKey: true })
  assert.equal(payload.ok, true)
  assert.equal(credentials.store.has('WAVESPEED_API_KEY'), false)
  assert.equal(payload.value.keyConfigured, false)
})

test('panel preferences override the config without a restart', async () => {
  freshHome('home-prefs')
  const credentials = inMemoryCredentials()
  const { tools, routes } = boot({ apiKey: '' }, { extraServices: { credentials } })
  const override = `${mock.base}/nope`
  const saved = await callRoute(routes, '/dsh-wavespeed/settings', 'POST', { baseUrl: override, waitMs: 120000 })
  assert.equal(saved.payload.ok, true)
  assert.equal(saved.payload.value.baseUrl, override)
  assert.equal(saved.payload.value.waitMs, 120000)

  // 工具读的是合并后的配置：overridden 地址下没有 /balance，错误里就会出现那条路径。
  credentials.store.set('WAVESPEED_API_KEY', 'test-key')
  await assert.rejects(() => tools.get('wavespeed_balance').execute({}, {}), /nope/)
})

test('invalid values are refused with a readable error', async () => {
  freshHome('home-invalid')
  const credentials = inMemoryCredentials()
  const { routes } = boot({ apiKey: '' }, { extraServices: { credentials } })
  const badUrl = await callRoute(routes, '/dsh-wavespeed/settings', 'POST', { baseUrl: 'ftp://example.test' })
  assert.equal(badUrl.payload.ok, false)
  assert.match(badUrl.payload.error, /http/)
  const badWait = await callRoute(routes, '/dsh-wavespeed/settings', 'POST', { waitMs: 5 })
  assert.equal(badWait.payload.ok, false)
  assert.match(badWait.payload.error, /5/)
})

test('the test route reports the account balance', async () => {
  freshHome('home-test')
  const credentials = inMemoryCredentials()
  credentials.store.set('WAVESPEED_API_KEY', 'test-key')
  const { routes } = boot({ apiKey: '' }, { extraServices: { credentials } })
  const { payload } = await callRoute(routes, '/dsh-wavespeed/test', 'POST')
  assert.equal(payload.ok, true)
  assert.equal(payload.value.balance, 12.5)
})

test('the test route explains a missing key instead of throwing', async () => {
  freshHome('home-test-missing')
  const credentials = inMemoryCredentials()
  const { routes } = boot({ apiKey: '' }, { extraServices: { credentials } })
  const previous = process.env.WAVESPEED_API_KEY
  delete process.env.WAVESPEED_API_KEY
  try {
    const { payload } = await callRoute(routes, '/dsh-wavespeed/test', 'POST')
    assert.equal(payload.ok, false)
    assert.match(payload.error, /WAVESPEED_API_KEY/)
  } finally {
    if (previous !== undefined) process.env.WAVESPEED_API_KEY = previous
  }
})
