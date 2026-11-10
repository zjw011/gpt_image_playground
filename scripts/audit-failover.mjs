// 故障转移专项：隔离数据目录、真实中继和本地假上游，浏览器走完整生图与计费链路。
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createServer as createViteServer } from 'vite'
import { launchChrome } from './lib/cdp.mjs'
import { initStore, updateConfig, normalizeChannel, normalizeUser, getConfig } from '../server/lib/store.mjs'
import { initUsage, flushUsage } from '../server/lib/usage.mjs'
import { initCredits, addCredits, getBalance, getReserved } from '../server/lib/credits.mjs'
import { initCards } from '../server/lib/cards.mjs'
import { handleGuestRoute } from '../server/lib/guestRoutes.mjs'
import { sendError } from '../server/lib/http.mjs'

const root = resolve(import.meta.dirname, '..')
const dataDir = mkdtempSync(join(tmpdir(), 'gip-failover-audit-'))
const userId = 'u-failover-audit'
const prompt = '故障转移专项：保留同一张参考图和这段原始描述'
const errors = []
const upstreamCalls = []
const relayCalls = []
let checked = 0
let failed = 0
let scenario = '503'
let outputB64 = ''
let vite
let app
let upstream
let browser

function report(label, ok, detail = '') {
  checked++
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` | ${detail}` : ''}`)
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function waitFor(expression) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (await browser.evaluate(expression)) return
    await browser.sleep(100)
  }
  throw new Error(`浏览器条件超时：${expression}`)
}

try {
  initStore(dataDir)
  initUsage(dataDir)
  initCredits(dataDir)
  initCards(dataDir)
  upstream = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      const contentType = req.headers['content-type'] || ''
      const call = { path: req.url, method: req.method, contentType, model: '', prompt: '', image: '' }
      if (contentType.includes('multipart/form-data')) {
        const form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData()
        call.model = form.get('model')
        call.prompt = form.get('prompt')
        const image = form.get('image') || form.get('image[]')
        if (image && typeof image !== 'string') call.image = Buffer.from(await image.arrayBuffer()).toString('base64')
      } else {
        const payload = JSON.parse(body.toString())
        call.model = payload.model
        const content = Array.isArray(payload.input) ? payload.input.flatMap((item) => item.content || []) : []
        call.prompt = content.find((item) => item.type === 'input_text')?.text || payload.prompt || payload.input
        call.image = content.find((item) => item.type === 'input_image')?.image_url?.split(',')[1] || ''
      }
      upstreamCalls.push(call)
      await new Promise((resolve) => setTimeout(resolve, 250))
      res.setHeader('Content-Type', 'application/json')
      if (req.url.startsWith('/first/')) {
        res.statusCode = scenario === 'policy' ? 403 : scenario === '200-error' ? 200 : scenario === '429' ? 429 : 503
        res.end(JSON.stringify({ error: { code: scenario === 'policy' ? 'content_policy_violation' : 'upstream_unavailable', message: scenario === 'policy' ? 'Rejected by content safety policy' : 'Temporary upstream failure' } }))
        return
      }
      res.end(JSON.stringify({ status: 'completed', output: [{ type: 'image_generation_call', result: outputB64, revised_prompt: prompt }] }))
    } catch (err) {
      errors.push(`假上游失败：${err.message}`)
      res.statusCode = 500
      res.end(JSON.stringify({ error: { message: err.message } }))
    }
  })
  const upstreamUrl = await listen(upstream)
  updateConfig((config) => {
    config.site.accessMode = 'open'
    config.site.failoverEnabled = true
    config.site.failoverMaxAttempts = 0
    config.site.allowGuestParamOverride = true
    config.site.credits = { ...config.site.credits, enabled: true, costPerImage: 1, luckyEnabled: false, channelRates: {} }
    config.users = [
      normalizeUser({ id: userId, username: 'audit-user', displayName: '审计用户' }, userId),
      normalizeUser({ id: 'u-audit-admin', username: 'audit-admin', role: 'admin' }, 'u-audit-admin'),
    ]
    config.channels = [
      normalizeChannel({ id: 'first', name: '内部主渠道', provider: 'openai', apiMode: 'images', model: 'primary-image-model', baseUrl: `${upstreamUrl}/first/v1`, apiKey: 'local-first-key', streamImages: false }, 'first'),
      normalizeChannel({ id: 'second', name: '内部备用渠道', provider: 'openai', apiMode: 'responses', model: 'backup-response-model', baseUrl: `${upstreamUrl}/second/v1`, apiKey: 'local-second-key', streamImages: false }, 'second'),
    ]
    return config
  })
  addCredits(userId, 100)
  app = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (!url.pathname.startsWith('/api/')) return vite.middlewares(req, res)
    if (url.pathname.startsWith('/api/relay/')) relayCalls.push({ path: url.pathname, failover: req.headers['x-gip-failover'] })
    try {
      await handleGuestRoute(req, res, {
        path: url.pathname, search: url.search, role: 'guest',
        user: getConfig().users.find((item) => item.id === userId),
        login: () => {}, register: () => {}, logout: () => {},
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      sendError(res, err.status || 500, err.message, err.extra)
    }
  })
  // 中间件模式的客户端仍建立 WebSocket；绑定本轮 HTTP 服务，避免并行审计争抢默认 24678。
  vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { server: app } }, appType: 'spa', logLevel: 'error' })
  const baseUrl = await listen(app)
  browser = await launchChrome({ port: 9436, baseUrl, onConsoleError: (line) => errors.push(line) })
  await browser.setViewport(1440, 1000)

  const cases = [
    { name: '503', success: true },
    { name: '429', success: true },
    { name: '200-error', success: true },
    { name: 'policy', success: false },
    { name: 'credits', success: false },
    { name: 'limit', success: false },
    { name: 'disabled', success: false },
  ]
  for (const test of cases) {
    scenario = test.name
    upstreamCalls.length = 0
    relayCalls.length = 0
    updateConfig((config) => {
      config.site.failoverEnabled = test.name !== 'disabled'
      config.site.failoverMaxAttempts = test.name === 'limit' ? 1 : 0
      config.site.credits.costPerImage = test.name === 'credits' ? 1000 : 1
      return config
    })
    await browser.open('/studio?mode=image', 500)
    if (!await browser.waitFor('textarea', 20000)) throw new Error('创作页未就绪')
    await waitFor(`(async () => { const { useStore } = await import('/src/store.ts'); return useStore.getState().settings.profiles.some((item) => item.id === 'backend-first') })()`)
    report(`${test.name} 创作页精确路由`, await browser.url() === '/studio?mode=image')
    const setup = await browser.evaluate(`(async () => {
      const store = await import('/src/store.ts')
      const { DEFAULT_PARAMS } = await import('/src/types.ts')
      const { getImage } = await import('/src/lib/db.ts')
      const originalFetch = window.fetch
      window.failoverAudit = { blocked: [], states: [], toasts: [], initialCount: store.useStore.getState().tasks.length }
      window.fetch = function (input, init) {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href)
        if (url.hostname === 'v1.hitokoto.cn') return Promise.resolve(new Response(JSON.stringify({ hitokoto: '本地渠道切换验证', from: '审计' }), { headers: { 'Content-Type': 'application/json' } }))
        if (url.protocol.startsWith('http') && url.origin !== location.origin) {
          window.failoverAudit.blocked.push(url.href)
          return Promise.reject(new Error('专项禁止外部网络'))
        }
        return originalFetch.call(this, input, init)
      }
      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = 64
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#7462f3'
      ctx.fillRect(0, 0, 64, 64)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
      const reference = await store.createInputImageFromFile(new File([blob], 'failover-reference.png', { type: 'image/png' }))
      window.failoverAudit.reference = reference
      const showToast = store.useStore.getState().showToast
      store.useStore.setState({
        prompt: ${JSON.stringify(prompt)}, inputImages: [reference], params: { ...DEFAULT_PARAMS, size: '1024x1024', n: 1 },
        showToast: (message, type) => { window.failoverAudit.toasts.push({ message, type }); showToast(message, type) },
      })
      store.useStore.getState().setSettings({ allowPromptRewrite: true, activeProfileId: 'backend-first' })
      store.useStore.subscribe((state) => {
        if (state.tasks.length > window.failoverAudit.initialCount) window.failoverAudit.states.push(state.tasks[0].status)
      })
      return { image: reference.dataUrl.split(',')[1], failover: store.useStore.getState().settings.channelFailover, max: store.useStore.getState().settings.channelFailoverMaxAttempts, original: (await getImage(reference.id)).dataUrl === reference.dataUrl }
    })()`)
    outputB64 = setup.image
    report(`${test.name} 后台开关与次数已进入实际运行设置`, setup.failover === (test.name !== 'disabled') && setup.max === (test.name === 'limit' ? 1 : 0))
    const balanceBefore = getBalance(userId)
    report(`${test.name} 点击真实生成按钮`, await browser.evaluate(`(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => /^生成(?:\\s|$)/.test(item.innerText.trim())); if (!button) return false; button.click(); return true })()`))
    await waitFor(`(async () => { const { useStore } = await import('/src/store.ts'); const state = useStore.getState(); return state.tasks.length === window.failoverAudit.initialCount + 1 && state.tasks[0].status !== 'running' })()`)
    await waitFor(`location.pathname === '/result'`)
    report(`${test.name} 结果页精确路由`, await browser.url() === '/result')
    const result = await browser.evaluate(`(async () => {
      const { useStore } = await import('/src/store.ts')
      const { getImage } = await import('/src/lib/db.ts')
      const task = useStore.getState().tasks[0]
      return { task, states: window.failoverAudit.states, toasts: window.failoverAudit.toasts, blocked: window.failoverAudit.blocked, original: (await getImage(window.failoverAudit.reference.id)).dataUrl === window.failoverAudit.reference.dataUrl, count: useStore.getState().tasks.length - window.failoverAudit.initialCount }
    })()`)
    report(`${test.name} 只产生一个最终任务并保留原始输入`, result.count === 1 && result.task.prompt === prompt && result.task.inputImageIds.length === 1 && result.original && setup.original)
    report(`${test.name} 所有中继请求只执行客户端选定候选`, relayCalls.length === (test.success ? 2 : 1) && relayCalls.every((call) => call.failover === 'client'), JSON.stringify(relayCalls))
    report(`${test.name} 终态正确`, result.task.status === (test.success ? 'done' : 'error'))
    report(`${test.name} 没有访问外部服务`, result.blocked.length === 0)
    report(`${test.name} 积分只结算成功结果且占位归零`, balanceBefore - getBalance(userId) === (test.success ? 1 : 0) && getReserved(userId) === 0)
    if (test.success) {
      report(`${test.name} Images 失败后真正切换 Responses 端点和模型`, upstreamCalls.length === 2 && upstreamCalls[0].path === '/first/v1/images/edits' && upstreamCalls[0].model === 'primary-image-model' && upstreamCalls[1].path === '/second/v1/responses' && upstreamCalls[1].model === 'backup-response-model', JSON.stringify(upstreamCalls.map(({ path, model }) => ({ path, model }))))
      report(`${test.name} 两种协议的参考图字节与提示词一致`, upstreamCalls.every((call) => call.prompt === prompt && call.image === setup.image))
      report(`${test.name} 切换过程中任务不进入错误态`, !result.states.includes('error') && result.task.outputImages.length === 1 && result.task.apiProfileId === 'backend-second')
      report(`${test.name} 显示切换提示且不暴露内部渠道名`, result.toasts.some((item) => item.message.includes('自动切换备用服务')) && result.toasts.every((item) => !item.message.includes('内部')))
      if (!await browser.waitFor('img[data-image-id]', 10000)) throw new Error('完成结果没有显示图片')
      report(`${test.name} 结果图片真实可解码`, await browser.evaluate(`(async () => { const img = document.querySelector('img[data-image-id]'); await img.decode(); return img.naturalWidth === 64 && img.naturalHeight === 64 })()`))
    } else {
      report(`${test.name} 不请求备用上游`, upstreamCalls.length === (test.name === 'credits' ? 0 : 1))
      report(`${test.name} 不提示仍在切换`, !result.toasts.some((item) => item.message.includes('自动切换')))
      if (test.name === 'policy') report('明确审核拒绝给内容提示', (await browser.text()).includes('内容未通过安全审核') && !result.task.error.includes('全部失败'))
    }
    for (const width of [1440, 390, 320]) {
      await browser.setViewport(width, 900)
      report(`${test.name} ${width}px 结果页不溢出`, await browser.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'))
    }
    await browser.setViewport(1440, 1000)
  }
  report('开发连接正常且无前端控制台或假上游异常', vite.ws.clients.size > 0 && errors.length === 0, errors.join('\n') || (vite.ws.clients.size ? '' : 'Vite WebSocket 未连接'))
  console.log(`渠道切换专项：${checked} 项检查，${failed} 项失败。真实浏览器/中继/本地 HTTP 上游与隔离积分账本，无收费接口或线上数据。`)
} catch (err) {
  failed++
  console.error(err)
} finally {
  await browser?.close()
  if (app) await new Promise((resolve) => app.close(resolve))
  await vite?.close()
  if (upstream) await new Promise((resolve) => upstream.close(resolve))
  flushUsage()
  if (resolve(dataDir).startsWith(`${resolve(tmpdir())}${sep}`)) rmSync(dataDir, { recursive: true, force: true })
}
process.exitCode = failed ? 1 : 0
