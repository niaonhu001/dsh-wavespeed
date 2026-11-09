/**
 * dsh-wavespeed web client：设置面板里的一个独立分页。
 *
 * 只管一件事——让用户能配自己的 WaveSpeed API Key：写进 DSH 凭据库、验证、清除，
 * 外加服务地址 / 等待上限 / 下载目录三项非机密偏好的覆盖。所有请求都走宿主注册的
 * /dsh-wavespeed/* 路由，密钥不会出现在浏览器存储里。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wavespeed',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    const NS = 'dsh-wavespeed'
    const SETTINGS_ROUTE = '/dsh-wavespeed/settings'
    const TEST_ROUTE = '/dsh-wavespeed/test'
    const STYLE_ID = 'dsh-wavespeed-settings-style'

    const ZH = {
      nav: 'WaveSpeed',
      title: 'WaveSpeed 生图 / 生视频',
      intro: '插件用这里的密钥调用 WaveSpeedAI。密钥存进 DSH 凭据库，不会写进 cordis 配置文件。',
      keyLabel: 'API Key',
      keyHint: '在 wavespeed.ai/accesskey 生成。留空表示不改动已保存的值。',
      configured: '已配置',
      missing: '未配置',
      source: '来源',
      save: '保存',
      test: '测试连接',
      clear: '清除密钥',
      saved: '已保存',
      testing: '正在连接…',
      balance: '余额',
      advanced: '高级设置',
      baseUrlLabel: '服务地址',
      baseUrlHint: '留空恢复默认（官方地址）。',
      waitLabel: '单次等待上限（秒）',
      waitHint: '5 到 3600，默认 300。超时会返回 prediction id，可稍后再取。',
      dirLabel: '产物下载目录',
      dirHint: '留空使用默认目录。',
      reset: '恢复默认',
      failed: '失败',
      readOnly: '凭据库只读，无法从这里保存。',
      loading: '读取中…',
    }

    const EN = {
      nav: 'WaveSpeed',
      title: 'WaveSpeed image & video',
      intro: 'The plugin calls WaveSpeedAI with the key below. It is stored in the DSH credential store, never in cordis configuration.',
      keyLabel: 'API key',
      keyHint: 'Create one at wavespeed.ai/accesskey. Leave empty to keep the saved value.',
      configured: 'Configured',
      missing: 'Not configured',
      source: 'Source',
      save: 'Save',
      test: 'Test connection',
      clear: 'Clear key',
      saved: 'Saved',
      testing: 'Connecting…',
      balance: 'Balance',
      advanced: 'Advanced',
      baseUrlLabel: 'API base URL',
      baseUrlHint: 'Empty restores the default (official) address.',
      waitLabel: 'Wait limit per call (seconds)',
      waitHint: '5 to 3600, default 300. On timeout the prediction id is returned for later retrieval.',
      dirLabel: 'Download directory',
      dirHint: 'Empty uses the default directory.',
      reset: 'Restore default',
      failed: 'Failed',
      readOnly: 'The credential store is read-only; saving from here is unavailable.',
      loading: 'Loading…',
    }

    const STYLE = `
[data-dsh-wavespeed]{display:flex;flex-direction:column;gap:14px;padding:4px 0 16px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary,#111827)}
[data-dsh-wavespeed] .ws__intro{font-size:12px;color:var(--dsw-alias-label-tertiary,#9ca3af)}
[data-dsh-wavespeed] .ws__card{border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-1,transparent)}
[data-dsh-wavespeed] .ws__head{display:flex;align-items:center;justify-content:space-between;gap:8px}
[data-dsh-wavespeed] .ws__title{font-weight:600;letter-spacing:.01em}
[data-dsh-wavespeed] .ws__field{display:flex;flex-direction:column;gap:4px}
[data-dsh-wavespeed] .ws__label{font-size:12px;font-weight:600}
[data-dsh-wavespeed] .ws__hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9ca3af)}
[data-dsh-wavespeed] .ws__input{width:100%;box-sizing:border-box;padding:6px 10px;border-radius:8px;font-size:12.5px;border:1px solid var(--dsw-alias-border,#e5e7eb);background:var(--dsw-alias-bg-layer-2,transparent);color:inherit}
[data-dsh-wavespeed] .ws__input:focus{outline:1px solid #6366f1;outline-offset:0}
[data-dsh-wavespeed] .ws__row{display:flex;align-items:center;gap:8px}
[data-dsh-wavespeed] .ws__btn{border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:8px;background:transparent;color:inherit;padding:5px 12px;font-size:12px;cursor:pointer}
[data-dsh-wavespeed] .ws__btn:hover:not(:disabled){background:var(--dsw-alias-fill-hover,rgba(0,0,0,.04))}
[data-dsh-wavespeed] .ws__btn:disabled{opacity:.5;cursor:default}
[data-dsh-wavespeed] .ws__btn--primary{background:#111827;color:#f9fafb;border-color:#111827}
[data-dsh-wavespeed] .ws__badge{font-size:11.5px;padding:1px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border,#e5e7eb)}
[data-dsh-wavespeed] .ws__badge--ok{color:#15803d;background:rgba(34,197,94,.12);border-color:transparent}
[data-dsh-wavespeed] .ws__badge--off{color:#b45309;background:rgba(245,158,11,.14);border-color:transparent}
[data-dsh-wavespeed] .ws__notice{font-size:12px;padding:6px 10px;border-radius:8px;white-space:pre-wrap}
[data-dsh-wavespeed] .ws__notice--ok{background:rgba(34,197,94,.12);color:#15803d}
[data-dsh-wavespeed] .ws__notice--bad{background:rgba(239,68,68,.12);color:#b91c1c}
[data-dsh-wavespeed] .ws__mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9ca3af);word-break:break-all}
[data-dsh-wavespeed] .ws__adv summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}
[data-dsh-wavespeed] .ws__adv{padding-top:4px}
`

    let activeLocale = 'zh'
    const listeners = new Set()

    function setActiveLocale(next) {
      const normalized = String(next || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
      if (normalized === activeLocale) return
      activeLocale = normalized
      for (const listener of [...listeners]) listener()
    }

    function useStrings() {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => force(n => n + 1)
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return activeLocale === 'zh' ? ZH : EN
    }

    async function call(route, method, body) {
      const response = await fetch(route, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const payload = await response.json()
      if (payload === null || typeof payload !== 'object') throw new Error('bad response')
      return payload
    }

    function field(label, hint, control) {
      return h('div', { className: 'ws__field' },
        h('span', { className: 'ws__label' }, label),
        control,
        h('span', { className: 'ws__hint' }, hint))
    }

    function Section() {
      const s = useStrings()
      const [state, setState] = useState(null)
      const [keyDraft, setKeyDraft] = useState('')
      const [baseDraft, setBaseDraft] = useState('')
      const [waitDraft, setWaitDraft] = useState('')
      const [dirDraft, setDirDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)

      const applyState = (value) => {
        setState(value)
        setBaseDraft(value.baseUrl === value.defaultBaseUrl ? '' : value.baseUrl)
        setWaitDraft(String(Math.round(value.waitMs / 1000)))
        setDirDraft(value.downloadDir === value.defaultDownloadDir ? '' : value.downloadDir)
      }

      const load = async () => {
        try {
          const payload = await call(SETTINGS_ROUTE, 'GET')
          if (payload.ok && payload.value) applyState(payload.value)
          else setNotice({ kind: 'bad', text: payload.error || s.failed })
        } catch (error) {
          setNotice({ kind: 'bad', text: String(error) })
        }
      }

      useEffect(() => { void load() }, [])

      const save = async () => {
        setBusy(true)
        setNotice(null)
        try {
          const body = {
            baseUrl: baseDraft.trim(),
            waitMs: Math.round(Number(waitDraft) * 1000) || Math.round((state ? state.waitMs : 300000) / 1000) * 1000,
            downloadDir: dirDraft.trim(),
          }
          if (keyDraft.trim() !== '') body.apiKey = keyDraft.trim()
          const payload = await call(SETTINGS_ROUTE, 'POST', body)
          if (payload.ok && payload.value) {
            applyState(payload.value)
            setKeyDraft('')
            setNotice({ kind: 'ok', text: s.saved })
          } else {
            setNotice({ kind: 'bad', text: payload.error || s.failed })
          }
        } catch (error) {
          setNotice({ kind: 'bad', text: String(error) })
        } finally {
          setBusy(false)
        }
      }

      const clearKey = async () => {
        setBusy(true)
        setNotice(null)
        try {
          const payload = await call(SETTINGS_ROUTE, 'POST', { clearApiKey: true })
          if (payload.ok && payload.value) {
            applyState(payload.value)
            setNotice({ kind: 'ok', text: s.saved })
          } else {
            setNotice({ kind: 'bad', text: payload.error || s.failed })
          }
        } catch (error) {
          setNotice({ kind: 'bad', text: String(error) })
        } finally {
          setBusy(false)
        }
      }

      const runTest = async () => {
        setBusy(true)
        setNotice({ kind: 'info', text: s.testing })
        try {
          const payload = await call(TEST_ROUTE, 'POST', {})
          if (payload.ok && payload.value) {
            const amount = payload.value.balance
            setNotice({
              kind: 'ok',
              text: `${s.balance} $${amount === null || amount === undefined ? '—' : Number(amount).toFixed(2)} · ${payload.value.latencyMs}ms`,
            })
          } else {
            setNotice({ kind: 'bad', text: payload.error || s.failed })
          }
        } catch (error) {
          setNotice({ kind: 'bad', text: String(error) })
        } finally {
          setBusy(false)
        }
      }

      const paperclip = () => {
        if (state === null) {
          return h('div', { className: 'ws__hint' }, s.loading)
        }
        return h('div', { className: 'ws__row' },
          h('span', { className: state.keyConfigured ? 'ws__badge ws__badge--ok' : 'ws__badge ws__badge--off' },
            state.keyConfigured ? s.configured : s.missing),
          h('span', { className: 'ws__mono' }, state.keyName),
          state.keyConfigured && state.keySource
            ? h('span', { className: 'ws__mono' }, `${s.source}: ${state.keySource}`)
            : null,
        )
      }

      return h('div', { 'data-dsh-wavespeed': '' },
        h('div', { className: 'ws__intro' }, s.intro),

        h('div', { className: 'ws__card' },
          h('div', { className: 'ws__head' },
            h('span', { className: 'ws__title' }, s.title),
            paperclip(),
          ),
          field(s.keyLabel, s.keyHint, h('input', {
            className: 'ws__input',
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            placeholder: 'wsp_...',
            value: keyDraft,
            onChange: (event) => setKeyDraft(event.target.value),
          })),
          state !== null && state.keyWritable === false
            ? h('div', { className: 'ws__hint' }, s.readOnly)
            : null,
          h('div', { className: 'ws__row' },
            h('button', { className: 'ws__btn ws__btn--primary', disabled: busy, onClick: () => void save() }, s.save),
            h('button', { className: 'ws__btn', disabled: busy, onClick: () => void runTest() }, s.test),
            h('button', { className: 'ws__btn', disabled: busy, onClick: () => void clearKey() }, s.clear),
          ),
          notice !== null
            ? h('div', { className: `ws__notice ws__notice--${notice.kind === 'ok' ? 'ok' : notice.kind === 'bad' ? 'bad' : ''}` }, notice.text)
            : null,
        ),

        h('details', { className: 'ws__card ws__adv' },
          h('summary', null, s.advanced),
          field(s.baseUrlLabel, s.baseUrlHint, h('input', {
            className: 'ws__input',
            type: 'text',
            spellCheck: false,
            placeholder: state === null ? '' : state.defaultBaseUrl,
            value: baseDraft,
            onChange: (event) => setBaseDraft(event.target.value),
          })),
          field(s.waitLabel, s.waitHint, h('input', {
            className: 'ws__input',
            type: 'number',
            min: 5,
            max: 3600,
            value: waitDraft,
            onChange: (event) => setWaitDraft(event.target.value),
          })),
          field(s.dirLabel, s.dirHint, h('input', {
            className: 'ws__input',
            type: 'text',
            spellCheck: false,
            placeholder: state === null ? '' : state.defaultDownloadDir,
            value: dirDraft,
            onChange: (event) => setDirDraft(event.target.value),
          })),
          h('div', { className: 'ws__row' },
            h('button', { className: 'ws__btn', disabled: busy, onClick: () => void save() }, s.save),
            h('button', {
              className: 'ws__btn',
              disabled: busy,
              onClick: () => { setBaseDraft(''); setDirDraft('') },
            }, s.reset),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = STYLE
        document.head.append(style)

        const sync = () => setActiveLocale(ctx.locale.getLocale().active)
        sync()
        ctx.effect(() => ctx.locale.subscribe(sync), 'dsh-wavespeed: locale sync')
        // 逐语言注册，走 register(ns, locale, dict) 这条明确的签名。
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'dsh-wavespeed: zh dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'dsh-wavespeed: en dictionary')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('settings.section', () => {
          const dispose = ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-wavespeed',
            order: 78,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({}),
          }, Section)
          return () => {
            dispose()
            style.remove()
          }
        })
      },
    }
  },
})

// 面板文件变更会触发客户端 HMR 重新发布（无需刷新页面时也能生效）。
