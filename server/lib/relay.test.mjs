// 中继的端到端测试。
//
// 这是整个服务端最值得测的一段：它同时管着**用户的钱**（扣费）和**用户的图**
// （故障转移后的重试），任何一处出错都不是"数字难看"而是真实事故。
// 所以这里不用替身去模拟上游，而是真的起几个本地 HTTP 服务器当渠道，
// 让请求走完整的 socket → 转发 → 回写链路。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initCards } from './cards.mjs'
import { addCredits, getBalance, getReserved, initCredits, resetReservations, userCreditsView } from './credits.mjs'
import { sendError } from './http.mjs'
import { handleGuestRoute } from './guestRoutes.mjs'
import { generationGate } from './generationGate.mjs'
import { GUEST_COOKIE, createSession } from './sessions.mjs'
import { findUserById, getConfig, initStore, normalizeChannel, normalizeUser, updateConfig } from './store.mjs'
import { initUsage, usageSummary } from './usage.mjs'
import { getUpstreamTimeoutMs } from './relay.mjs'
import { generationOrdersForTests, initGenerationOrders, pollGenerationOrders } from './generationOrders.mjs'

/** 起一个假上游。handler 决定它对每个请求怎么回应。 */
function startUpstream(handler) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => handler(req, res, Buffer.concat(chunks)))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

/** 把 handleGuestRoute 挂到一个真服务器上，行为与 server/index.mjs 的中继分支一致。 */
function startApp(userId) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const token = /gip_guest=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
      const user = token ? findUserById(userId) : null
      try {
        await handleGuestRoute(req, res, {
          path: url.pathname,
          search: url.search,
          role: 'guest',
          user: user?.enabled ? user : null,
          login: () => {},
          register: () => {},
          logout: () => {},
        })
      } catch (err) {
        if (res.headersSent) return res.destroy()
        sendError(res, err?.status ?? 500, err?.message ?? '内部错误', err?.extra)
      }
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

let upstreams = []
let app = null
let cookie = ''
const USER_ID = 'u-test'
const IMAGE_RESPONSE = JSON.stringify({ data: [{ b64_json: 'AAAA' }] })

/** 每个用例重建一套干净的数据目录与渠道配置。 */
/** 复制一份用户记录并换成指定 id/用户名（测试里造"另一个人"用）。 */
function cloneUser(user, id, username) {
  return { ...user, id, username, displayName: username, wechatOpenId: '', email: '' }
}

async function setup(channels, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gip-relay-'))
  initStore(dir)
  initUsage(dir)
  initCredits(dir)
  initCards(dir)
  resetReservations()
  initGenerationOrders(dir, { startWorker: false })

  updateConfig((config) => {
    config.site.accessMode = 'wechat'
    config.site.failoverEnabled = true
    config.site.failoverMaxAttempts = options.maxAttempts ?? 0
    config.site.credits = {
      ...config.site.credits,
      enabled: true,
      costPerImage: options.costPerImage ?? 1,
      channelRates: options.channelRates ?? {},
      luckyEnabled: options.luckyEnabled ?? false,
      luckyRate: options.luckyRate ?? 0,
    }
    config.users = [normalizeUser({ id: USER_ID, username: 'wx_test', enabled: true, wechatOpenId: 'oTest' }, USER_ID)]
    config.channels = channels.map((item, idx) => normalizeChannel({ id: `ch-${idx + 1}`, model: 'gpt-image-2', ...item }, `ch-${idx + 1}`))
    return config
  })

  addCredits(USER_ID, options.balance ?? 100)

  const session = createSession('guest', USER_ID)
  cookie = `${GUEST_COOKIE}=${session.token}`
  app = await startApp(USER_ID)
  return app
}

function relay(path, init = {}) {
  const { headers, ...rest } = init
  return fetch(`http://127.0.0.1:${app.port}/api/relay/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
    body: JSON.stringify({ model: 'gpt-image-2', prompt: 'cat' }),
    ...rest,
  })
}

/** 拼一段形态正确的 multipart，张数字段放在最前面（前端的实际行为）。 */
function multipartBody(n, boundary = '----BoundaryTest') {
  const parts = []
  if (n != null) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n${n}\r\n`)
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\ncat\r\n`)
  parts.push(`--${boundary}--\r\n`)
  return parts.join('')
}

beforeEach(() => {
  upstreams = []
  app = null
  generationGate.reset()
})

afterEach(async () => {
  for (const item of upstreams) await close(item.server)
  if (app) await close(app.server)
})

describe('服务端生成权限与最终结果', () => {
  it.each([403, 408])('上游 HTTP %s 仍允许客户端切换渠道，不误标为本站权限拒绝', async (status) => {
    const upstream = await startUpstream((req, res) => res.writeHead(status).end('upstream credential unavailable'))
    upstreams = [upstream]
    await setup([{ baseUrl: upstream.url, apiKey: 'k' }])
    const response = await relay('ch-1/images/generations', { headers: { 'X-GIP-Failover': 'client' } })
    expect(response.status).toBe(status)
    expect(response.headers.get('x-gip-failover')).not.toBe('stop')
    expect(getBalance(USER_ID)).toBe(100)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it.each([
    ['images/generations', { model: 'other-model' }],
    ['chat/completions', { model: 'gpt-image-2' }],
    ['files', {}],
    ['images/generations', { n: 17 }],
    ['images/generations', { n: 1, num_images: 4 }],
  ])('拒绝未授权接口/模型/张数 %s %j，不注入密钥发往上游', async (path, body) => {
    let calls = 0
    const upstream = await startUpstream((req, res) => { calls += 1; res.end(IMAGE_RESPONSE) })
    upstreams = [upstream]
    await setup([{ baseUrl: upstream.url, apiKey: 'secret' }])
    const response = await relay(`ch-1/${path}`, { body: JSON.stringify(body) })
    expect([400, 403]).toContain(response.status)
    expect(calls).toBe(0)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it('长提示词后的 n 正确传送与预留，嵌套数量不影响计费', async () => {
    let requested
    const upstream = await startUpstream((req, res, body) => {
      requested = JSON.parse(body.toString())
      res.end(JSON.stringify({ data: Array.from({ length: 4 }, (_, idx) => ({ b64_json: `image-${idx}` })) }))
    })
    upstreams = [upstream]
    await setup([{ baseUrl: upstream.url, apiKey: 'k' }])
    const response = await relay('ch-1/images/generations', { body: JSON.stringify({ prompt: 'x'.repeat(70_000), n: 4, metadata: { num_images: 16 } }) })
    expect(response.status).toBe(200)
    expect(requested).toMatchObject({ n: 4, model: 'gpt-image-2' })
    expect(getBalance(USER_ID)).toBe(96)
  })

  it('SSE 只有预览然后失败不扣费，也不重复生成', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'response.image_generation_call.partial_image', partial_image_b64: 'preview' })}\n\n`)
      res.end(`data: ${JSON.stringify({ type: 'error', error: { message: 'upstream failed' } })}\n\n`)
    })
    upstreams = [upstream]
    await setup([{ baseUrl: upstream.url, apiKey: 'k', apiMode: 'responses' }])
    const response = await relay('ch-1/responses', { body: JSON.stringify({ stream: true }) })
    expect(response.status).toBe(200)
    await response.text()
    expect(getBalance(USER_ID)).toBe(100)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it('Agent 文本和函数工具响应保持可用，没有图片不扣出图积分', async () => {
    const payload = { id: 'resp-agent', output: [{ type: 'function_call', name: 'generate_image', arguments: '{}' }] }
    const upstream = await startUpstream((req, res) => res.end(JSON.stringify(payload)))
    upstreams = [upstream]
    await setup([{ baseUrl: upstream.url, apiKey: 'k', apiMode: 'responses' }])
    const response = await relay('ch-1/responses')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(payload)
    expect(getBalance(USER_ID)).toBe(100)
  })

  it('自定义接口严格使用管理员映射，按自定义结果的成功图片收费', async () => {
    const upstream = await startUpstream((req, res) => res.end(JSON.stringify({ pictures: ['https://example.test/a.png'] })))
    upstreams = [upstream]
    await setup([{ provider: 'custom-draw', baseUrl: upstream.url, apiKey: 'k' }])
    updateConfig((config) => {
      config.customProviders = [{ id: 'custom-draw', submit: { path: 'draw', method: 'POST', body: { engine: '$profile.model', count: '$params.n' }, result: { imageUrlPaths: ['pictures.*'] } } }]
      return config
    })
    const response = await relay('ch-1/draw', { body: JSON.stringify({ engine: 'gpt-image-2', count: 3 }) })
    expect(response.status).toBe(200)
    expect(getBalance(USER_ID)).toBe(99)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it('异步提交后关页，后台查询原地址并结算；修改渠道不会改变已有订单', async () => {
    const calls = []
    const upstream = await startUpstream((req, res) => {
      calls.push(req.url)
      res.end(JSON.stringify(req.method === 'POST' ? { task_id: 'background' } : { status: 'completed', result: { data: [{ b64_json: 'AAAA' }] } }))
    })
    upstreams = [upstream]
    await setup([{ provider: 'sb2api-async', baseUrl: upstream.url, apiKey: 'k' }])
    const response = await relay('ch-1/images/generations/async')
    await response.json()
    expect(getReserved(USER_ID)).toBe(1)
    updateConfig((config) => { config.channels[0].baseUrl = 'http://127.0.0.1:1'; return config })
    await pollGenerationOrders()
    expect(calls).toEqual(['/v1/images/generations/async', '/v1/images/tasks/background'])
    expect(getBalance(USER_ID)).toBe(99)
    expect(getReserved(USER_ID)).toBe(0)
  })
})

describe('渠道故障转移', () => {
  it.each(['json', 'multipart'])('原生 GIF 的 %s 请求只回退到支持动图的渠道，按成品扣费', async (format) => {
    const called = []
    const primary = await startUpstream((req, res) => {
      called.push('primary')
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'upstream temporarily unavailable' } }))
    })
    const staticOnly = await startUpstream((req, res) => {
      called.push('static')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(IMAGE_RESPONSE)
    })
    const backup = await startUpstream((req, res, body) => {
      called.push('backup')
      expect(body.toString()).toContain('gif')
      if (format === 'json') expect(JSON.parse(body.toString()).size).toBe('auto')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(IMAGE_RESPONSE)
    })
    upstreams = [primary, staticOnly, backup]
    await setup([
      { name: '动图主线', baseUrl: primary.url, apiKey: 'k1', supportsNativeGif: true },
      { name: '静态线路', baseUrl: staticOnly.url, apiKey: 'k2', supportsNativeGif: false },
      { name: '动图备用', baseUrl: backup.url, apiKey: 'k3', supportsNativeGif: true },
    ])

    const boundary = '----GifBoundary'
    const fields = { n: 1, output_format: 'gif', frame_count: 16, size: 'auto', prompt: 'a butterfly flying' }
    const response = await relay(`ch-1/images/${format === 'json' ? 'generations' : 'edits'}`, {
      headers: { 'Content-Type': format === 'json' ? 'application/json' : `multipart/form-data; boundary=${boundary}` },
      body: format === 'json'
        ? JSON.stringify(fields)
        : Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('') + `--${boundary}--\r\n`,
    })
    expect(response.status).toBe(200)
    await response.json()
    expect(called).toEqual(['primary', 'backup'])
    expect(getBalance(USER_ID)).toBe(99)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it('未开启动图的渠道在调用上游前拒绝 GIF 请求且不扣费', async () => {
    let called = false
    const upstream = await startUpstream((req, res) => {
      called = true
      res.end(IMAGE_RESPONSE)
    })
    upstreams = [upstream]
    await setup([{ name: '静态线路', baseUrl: upstream.url, apiKey: 'k1' }])
    const response = await relay('ch-1/images/generations', { body: JSON.stringify({ output_format: 'gif', n: 1, frame_count: 16 }) })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('native-gif-unsupported')
    expect(called).toBe(false)
    expect(getBalance(USER_ID)).toBe(100)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it('提示词中的 GIF 格式示例不会被当作原生动图请求', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(IMAGE_RESPONSE)
    })
    upstreams = [upstream]
    await setup([{ name: '静态线路', baseUrl: upstream.url, apiKey: 'k1' }])
    const response = await relay('ch-1/images/generations', { body: JSON.stringify({ prompt: '在屏幕上显示代码 "output_format":"gif"', output_format: 'png' }) })
    expect(response.status).toBe(200)
    await response.json()
  })

  it('生图请求至少等待 5 分钟，普通接口仍采用渠道配置', () => {
    expect(getUpstreamTimeoutMs({ timeout: 15 }, true)).toBe(300_000)
    expect(getUpstreamTimeoutMs({ timeout: 900 }, true)).toBe(900_000)
    expect(getUpstreamTimeoutMs({ timeout: 15 }, false)).toBe(15_000)
  })

  it('同步生图长时间无响应头时发送空白心跳并保留最终 JSON', async () => {
    const slow = await startUpstream((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(IMAGE_RESPONSE)
      }, 80)
    })
    upstreams = [slow]
    await setup([{ name: '慢渠道', baseUrl: `${slow.url}/v1`, apiKey: 'k1' }])

    const response = await relay('ch-1/images/generations', {
      headers: { 'X-GIP-Keepalive': '1' },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-gip-heartbeat')).toBe('1')
    expect(await response.json()).toEqual({ data: [{ b64_json: 'AAAA' }] })
    expect(getBalance(USER_ID)).toBe(99)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it('心跳已经开始后仍用完整 JSON 返回最终渠道错误且不扣积分', async () => {
    const slowFailure = await startUpstream((req, res) => {
      setTimeout(() => res.writeHead(500).end('upstream down'), 80)
    })
    upstreams = [slowFailure]
    await setup([{ name: '慢故障渠道', baseUrl: `${slowFailure.url}/v1`, apiKey: 'k1' }])

    const response = await relay('ch-1/images/generations', {
      headers: { 'X-GIP-Keepalive': '1' },
    })
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('x-gip-heartbeat')).toBe('1')
    expect(payload.error.message).toContain('所有渠道均失败')
    expect(getBalance(USER_ID)).toBe(100)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it('旧客户端发送 size:auto 时服务端改成显式尺寸再请求兼容渠道', async () => {
    let seenBody = null
    let seenLength = null
    const good = await startUpstream((req, res, body) => {
      seenBody = JSON.parse(body.toString('utf-8'))
      seenLength = Number(req.headers['content-length'])
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(IMAGE_RESPONSE)
    })
    upstreams = [good]
    await setup([{ name: '兼容渠道', baseUrl: `${good.url}/v1`, apiKey: 'k1', provider: 'openai' }])

    const response = await relay('ch-1/images/generations', {
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'cat', size: 'auto' }),
    })

    expect(response.status).toBe(200)
    expect(seenBody.size).toBe('1024x1024')
    expect(seenLength).toBe(Buffer.byteLength(JSON.stringify(seenBody)))
  })

  it('Responses 生图工具的 size:auto 同样会在服务端兼容', async () => {
    let seenBody = null
    const good = await startUpstream((req, res, body) => {
      seenBody = JSON.parse(body.toString('utf-8'))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ output: [{ type: 'image_generation_call', result: 'AAAA' }] }))
    })
    upstreams = [good]
    await setup([{ name: 'Responses 渠道', baseUrl: `${good.url}/v1`, apiKey: 'k1', provider: 'openai' }])

    const response = await relay('ch-1/responses', {
      body: JSON.stringify({
        model: 'gpt-image-2',
        input: 'cat',
        tools: [{ type: 'image_generation', size: 'auto' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(seenBody.tools[0].size).toBe('1024x1024')
  })

  it('第一条渠道欠费时静默切到下一条，用户只看到成功', async () => {
    const bad = await startUpstream((req, res) => {
      res.writeHead(402, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'insufficient quota' } }))
    })
    const good = await startUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }))
    })
    upstreams = [bad, good]
    await setup([
      { name: '欠费渠道', baseUrl: `${bad.url}/v1`, apiKey: 'k1' },
      { name: '正常渠道', baseUrl: `${good.url}/v1`, apiKey: 'k2' },
    ])

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(200)
    // 关键：响应体就是正常渠道的原文，没有任何"正在切换渠道"的痕迹。
    expect(await response.json()).toEqual({ data: [{ b64_json: 'AAAA' }] })
    // 只扣了真正出图那一条渠道的价。
    expect(getBalance(USER_ID)).toBe(99)
  })

  it('上游连不上时也换下一条', async () => {
    // 指向一个没人监听的端口。
    const dead = { url: 'http://127.0.0.1:1' }
    const good = await startUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(IMAGE_RESPONSE)
    })
    upstreams = [good]
    await setup([
      { name: '死渠道', baseUrl: `${dead.url}/v1`, apiKey: 'k1', timeout: 10 },
      { name: '正常渠道', baseUrl: `${good.url}/v1`, apiKey: 'k2' },
    ])

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(200)
    expect(getBalance(USER_ID)).toBe(99)
  })

  it('全部渠道都失败时报 502，并逐条列出原因，且一分不扣', async () => {
    const first = await startUpstream((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad key' }))
    })
    const second = await startUpstream((req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('boom')
    })
    upstreams = [first, second]
    await setup([
      { name: '密钥错', baseUrl: `${first.url}/v1`, apiKey: 'k1' },
      { name: '上游 500', baseUrl: `${second.url}/v1`, apiKey: 'k2' },
    ])

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(502)
    const payload = await response.json()
    expect(payload.error).toContain('所有渠道均失败')
    expect(payload.error).toContain('密钥错')
    expect(payload.error).toContain('上游 500')
    // 失败不扣分。
    expect(getBalance(USER_ID)).toBe(100)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it('请求本身有问题（400）时不换渠道，直接把上游的原话透传给用户', async () => {
    let secondCalled = false
    const bad = await startUpstream((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'prompt rejected by content policy' } }))
    })
    const second = await startUpstream((req, res) => {
      secondCalled = true
      res.writeHead(200).end(IMAGE_RESPONSE)
    })
    upstreams = [bad, second]
    await setup([
      { name: '主渠道', baseUrl: `${bad.url}/v1`, apiKey: 'k1' },
      { name: '备用渠道', baseUrl: `${second.url}/v1`, apiKey: 'k2' },
    ])

    const response = await relay('ch-1/images/generations')
    // 400 是请求内容的问题，换渠道也一样会被拒，所以如实返回。
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('content policy')
    expect(secondCalled).toBe(false)
    expect(getBalance(USER_ID)).toBe(100)
  })

  it.each([
    [403, { error: { code: 'content_policy_violation', message: 'Rejected' } }, 403, '内容安全审核未通过'],
    [500, { error: { message: 'Rejected by safety system' } }, 500, '内容安全审核未通过'],
    [200, { error: { code: 'content_policy_violation', message: 'Rejected' } }, 400, '内容安全审核未通过'],
    [200, { status: 'failed', error: { code: 'content_policy_violation' }, output: [{ type: 'image_generation_call', status: 'failed', result: 'AAAA' }] }, 400, '内容安全审核未通过'],
    [200, { status: 'cancelled' }, 409, '上游生成任务已取消'],
    [502, { error: { message: 'request canceled' } }, 502, '上游生成任务已取消'],
  ])('HTTP %s 的审核拒绝或取消不会换渠道、扣分或污染健康度', async (upstreamStatus, payload, status, message) => {
    let secondCalled = false
    const first = await startUpstream((req, res) => res.writeHead(upstreamStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload)))
    const second = await startUpstream((req, res) => {
      secondCalled = true
      res.writeHead(200).end(IMAGE_RESPONSE)
    })
    upstreams = [first, second]
    await setup([
      { name: '主渠道', baseUrl: `${first.url}/v1`, apiKey: 'k1' },
      { name: '备用渠道', baseUrl: `${second.url}/v1`, apiKey: 'k2' },
    ])

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(status)
    const body = await response.text()
    expect(body).toContain(message)
    expect(body).not.toContain('所有渠道均失败')
    expect(secondCalled).toBe(false)
    expect(getBalance(USER_ID)).toBe(100)
    expect(getReserved(USER_ID)).toBe(0)
    expect(usageSummary().events).toHaveLength(1)
    expect(usageSummary().events[0]).toMatchObject({ ok: false, fault: false })
    expect(usageSummary().channels[0]).toMatchObject({ state: 'healthy', consecutiveFailures: 0 })
  })

  it('已开始保活后仍保留审核原因，不把 200 当作出图成功', async () => {
    const first = await startUpstream((req, res) => {
      setTimeout(() => res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'content_policy_violation', message: 'Rejected' } })), 80)
    })
    upstreams = [first]
    await setup([{ name: '主渠道', baseUrl: `${first.url}/v1`, apiKey: 'k1' }])

    const response = await relay('ch-1/images/generations', { headers: { 'X-GIP-Keepalive': '1' } })
    expect(response.headers.get('x-gip-heartbeat')).toBe('1')
    expect((await response.json()).error.message).toContain('内容安全审核未通过')
    expect(getBalance(USER_ID)).toBe(100)
    expect(getReserved(USER_ID)).toBe(0)
    expect(usageSummary().events[0]).toMatchObject({ ok: false, fault: false })
  })

  it('SSE 在图片开始前拒绝内容时不扣积分，也不切换渠道', async () => {
    let secondCalled = false
    const first = await startUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"type":"response.created","response":{"status":"in_progress"}}\n\n')
      setTimeout(() => res.end('data: {"type":"response.failed","response":{"error":{"code":"content_policy_violation","message":"Rejected"}}}\n\n'), 10)
    })
    const second = await startUpstream((req, res) => {
      secondCalled = true
      res.writeHead(200).end(IMAGE_RESPONSE)
    })
    upstreams = [first, second]
    await setup([
      { name: '主渠道', baseUrl: `${first.url}/v1`, apiKey: 'k1' },
      { name: '备用渠道', baseUrl: `${second.url}/v1`, apiKey: 'k2' },
    ])
    const response = await relay('ch-1/responses', { body: JSON.stringify({ model: 'gpt-image-2', stream: true, tools: [{ type: 'image_generation' }], input: 'cat' }) })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('内容安全审核未通过')
    expect(secondCalled).toBe(false)
    expect(getBalance(USER_ID)).toBe(100)
    expect(getReserved(USER_ID)).toBe(0)
    expect(usageSummary().events[0]).toMatchObject({ ok: false, fault: false })
  })

  it.each([
    ['responses', { output: [{ type: 'image_generation_call', status: 'completed', result: 'AAAA' }, { type: 'image_generation_call', status: 'failed', error: { code: 'content_policy_violation' } }] }],
    ['images/generations', { data: [{ b64_json: 'AAAA' }, { error: { code: 'content_policy_violation' } }] }],
    ['images/generations', { error: { code: 'content_policy_violation' }, data: [{ b64_json: 'AAAA' }] }],
    ['responses', { status: 'failed', error: { code: 'content_policy_violation' }, output: [{ type: 'image_generation_call', status: 'completed', result: 'AAAA' }] }],
  ])('%s 局部审核失败时保留已经成功的图片，不重复换渠道', async (endpoint, payload) => {
    let secondCalled = false
    const first = await startUpstream((req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload)))
    const second = await startUpstream((req, res) => {
      secondCalled = true
      res.writeHead(200).end(IMAGE_RESPONSE)
    })
    upstreams = [first, second]
    await setup([
      { name: '主渠道', baseUrl: `${first.url}/v1`, apiKey: 'k1' },
      { name: '备用渠道', baseUrl: `${second.url}/v1`, apiKey: 'k2' },
    ])
    const response = await relay(`ch-1/${endpoint}`, { body: JSON.stringify({ model: 'gpt-image-2', tools: [{ type: 'image_generation' }], prompt: 'cat' }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(payload)
    expect(secondCalled).toBe(false)
    expect(getReserved(USER_ID)).toBe(0)
    expect(usageSummary().events[0]).toMatchObject({ ok: true, fault: false })
  })

  it.each(['cancelled', 'failed'])('HTTP 200 的任务 ID 和 %s 错误同时出现时保留受理记录，不重复提交或扣费', async (status) => {
    let secondCalled = false
    const payload = { task_id: 'accepted-task', status, error: { message: status === 'cancelled' ? 'request cancelled' : 'upstream unavailable' } }
    const first = await startUpstream((req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload)))
    const second = await startUpstream((req, res) => {
      secondCalled = true
      res.writeHead(200).end(IMAGE_RESPONSE)
    })
    upstreams = [first, second]
    await setup([
      { name: '主渠道', baseUrl: `${first.url}/v1`, apiKey: 'k1' },
      { name: '备用渠道', baseUrl: `${second.url}/v1`, apiKey: 'k2' },
    ])

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(payload)
    expect(secondCalled).toBe(false)
    expect(getBalance(USER_ID)).toBe(100)
    expect(getReserved(USER_ID)).toBe(0)
    expect(usageSummary().events[0]).toMatchObject({ ok: false, fault: status !== 'cancelled' })
  })

  it.each([
    [{ request_id: 'fal-accepted' }, 200, 0],
    [{ images: [{ url: 'https://example.com/generated.png' }] }, 200, 1],
    [{ image: { url: 'data:image/png;base64,AAAA' } }, 200, 1],
    [{ request_id: 'fal-accepted', error: { message: 'upstream unavailable' } }, 200, 0],
    [{ error: { message: 'upstream unavailable' } }, 502, 0],
    [{ error: { code: 'content_policy_violation' } }, 400, 0],
  ])('Fal 标准提交响应 %j 按实际受理/错误结算', async (payload, expectedStatus, charged) => {
    const upstream = await startUpstream((req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload)))
    upstreams = [upstream]
    await setup([{ name: 'Fal', provider: 'fal', model: 'openai/gpt-image-2', baseUrl: upstream.url, apiKey: 'k1' }])

    const response = await relay('ch-1/fal-submit', { body: JSON.stringify({ prompt: 'cat' }), headers: {
      'X-GIP-Failover': 'client',
      'X-Fal-Target-Url': 'https://queue.fal.run/openai/gpt-image-2',
    } })
    expect(response.status).toBe(expectedStatus)
    if (expectedStatus === 200) expect(await response.json()).toEqual(payload)
    expect(getBalance(USER_ID)).toBe(100 - charged)
    expect(getReserved(USER_ID)).toBe(payload.request_id && !payload.error ? 1 : 0)
    expect(userCreditsView(USER_ID).ledger.filter((item) => item.type === 'spend')).toHaveLength(charged)
  })

  it.each([false, true])('同一 SSE 数据块按事件顺序处理图片与失败（错误在前：%s）', async (errorFirst) => {
    const image = 'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","status":"completed","result":"AAAA"}}\n\n'
    const error = 'data: {"type":"response.failed","response":{"error":{"code":"content_policy_violation"}}}\n\n'
    const body = errorFirst ? error + image : image + error
    const first = await startUpstream((req, res) => res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(body))
    upstreams = [first]
    await setup([{ name: '主渠道', baseUrl: `${first.url}/v1`, apiKey: 'k1' }])
    const response = await relay('ch-1/responses', { body: JSON.stringify({ model: 'gpt-image-2', stream: true, tools: [{ type: 'image_generation' }], input: 'cat' }) })
    expect(response.status).toBe(errorFirst ? 400 : 200)
    const actual = await response.text()
    if (errorFirst) expect(actual).toContain('内容安全审核未通过')
    else expect(actual).toBe(body)
    expect(getBalance(USER_ID)).toBe(errorFirst ? 100 : 99)
    expect(getReserved(USER_ID)).toBe(0)
    expect(usageSummary().events[0]).toMatchObject({ ok: !errorFirst, fault: false })
  })

  it('管理员关掉故障转移时只试第一条', async () => {
    let secondCalled = false
    const bad = await startUpstream((req, res) => res.writeHead(503).end('down'))
    const second = await startUpstream((req, res) => {
      secondCalled = true
      res.writeHead(200).end(IMAGE_RESPONSE)
    })
    upstreams = [bad, second]
    await setup([
      { name: '挂了', baseUrl: `${bad.url}/v1`, apiKey: 'k1' },
      { name: '正常', baseUrl: `${second.url}/v1`, apiKey: 'k2' },
    ])
    updateConfig((config) => {
      config.site.failoverEnabled = false
      return config
    })

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(502)
    expect(secondCalled).toBe(false)
  })

  it('failoverMaxAttempts 限制最多试几条', async () => {
    const calls = []
    const make = (tag, status) => startUpstream((req, res) => {
      calls.push(tag)
      res.writeHead(status).end('nope')
    })
    const a = await make('a', 500)
    const b = await make('b', 500)
    const c = await make('c', 200)
    upstreams = [a, b, c]
    await setup([
      { name: 'A', baseUrl: `${a.url}/v1`, apiKey: 'k1' },
      { name: 'B', baseUrl: `${b.url}/v1`, apiKey: 'k2' },
      { name: 'C', baseUrl: `${c.url}/v1`, apiKey: 'k3' },
    ], { maxAttempts: 2 })

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(502)
    expect(calls).toEqual(['a', 'b'])
  })

  it('上游 429 会切换备用容量，限流不被记作渠道损坏', async () => {
    const busy = await startUpstream((req, res) => res.writeHead(429).end('rate limit exceeded'))
    const good = await startUpstream((req, res) => res.writeHead(200).end(IMAGE_RESPONSE))
    upstreams = [busy, good]
    await setup([
      { name: '繁忙渠道', baseUrl: `${busy.url}/v1`, apiKey: 'k1' },
      { name: '备用渠道', baseUrl: `${good.url}/v1`, apiKey: 'k2' },
    ])

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(JSON.parse(IMAGE_RESPONSE))
    expect(usageSummary().events.find((item) => item.channelId === 'ch-1')).toMatchObject({ status: 429, ok: false, fault: false })
    expect(getBalance(USER_ID)).toBe(99)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it('客户端编排时每次请求只发指定渠道，不产生双层重试或占用备用高价额度', async () => {
    const calls = []
    const bad = await startUpstream((req, res) => {
      calls.push('bad')
      expect(req.headers['x-gip-failover']).toBeUndefined()
      expect(req.headers['x-gip-keepalive']).toBeUndefined()
      res.writeHead(503).end('down')
    })
    const good = await startUpstream((req, res) => {
      calls.push('good')
      res.writeHead(200, { 'X-GIP-Failover': 'stop' }).end(IMAGE_RESPONSE)
    })
    upstreams = [bad, good]
    await setup([
      { name: '主渠道', baseUrl: `${bad.url}/v1`, apiKey: 'k1' },
      { name: '备用渠道', baseUrl: `${good.url}/v1`, apiKey: 'k2' },
    ], { balance: 2, channelRates: { 'ch-2': 300 } })

    const failed = await relay('ch-1/images/generations', { headers: { 'X-GIP-Failover': 'client', 'X-GIP-Keepalive': '1' } })
    const failureBody = await failed.text()
    expect(failureBody).toContain('down')
    expect(failureBody).not.toContain('所有渠道均失败')
    expect(calls).toEqual(['bad'])
    expect(getBalance(USER_ID)).toBe(2)
    expect(getReserved(USER_ID)).toBe(0)

    addCredits(USER_ID, 5)
    const response = await relay('ch-2/images/generations', { headers: { 'X-GIP-Failover': 'client' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-gip-failover')).toBeNull()
    expect(calls).toEqual(['bad', 'good'])
    expect(getBalance(USER_ID)).toBe(4)
    expect(userCreditsView(USER_ID).ledger.filter((item) => item.type === 'spend')).toHaveLength(1)
  })

  it('旧客户端只向协议与模型兼容的备用渠道重放', async () => {
    const calls = []
    const bad = await startUpstream((req, res) => {
      calls.push('bad')
      res.writeHead(503).end('down')
    })
    const incompatible = await startUpstream((req, res) => {
      calls.push('incompatible')
      res.writeHead(200).end(IMAGE_RESPONSE)
    })
    const good = await startUpstream((req, res) => {
      calls.push('good')
      res.writeHead(200).end(IMAGE_RESPONSE)
    })
    upstreams = [bad, incompatible, good]
    await setup([
      { name: '主渠道', baseUrl: `${bad.url}/v1`, apiKey: 'k1' },
      { name: '异步', baseUrl: `${incompatible.url}/v1`, apiKey: 'k2', provider: 'sb2api-async' },
      { name: '其他模型', baseUrl: `${incompatible.url}/v1`, apiKey: 'k3', model: 'other-image-model' },
      { name: '其他协议', baseUrl: `${incompatible.url}/v1`, apiKey: 'k4', apiMode: 'responses' },
      { name: '兼容备用', baseUrl: `${good.url}/v1`, apiKey: 'k5' },
    ], { maxAttempts: 2 })

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(200)
    expect(calls).toEqual(['bad', 'good'])
    expect(getBalance(USER_ID)).toBe(99)
  })

  it.each([401, 429, 503])('客户端编排时保留上游 HTTP %s，不谎称所有渠道已失败', async (status) => {
    const upstream = await startUpstream((req, res) => res.writeHead(status).end('upstream unavailable'))
    upstreams = [upstream]
    await setup([{ name: '主渠道', baseUrl: `${upstream.url}/v1`, apiKey: 'k1' }])

    const response = await relay('ch-1/images/generations', { headers: { 'X-GIP-Failover': 'client' } })
    expect(response.status).toBe(status)
    expect(response.headers.get('x-gip-failover')).toBeNull()
    const body = await response.text()
    expect(body).toContain(`HTTP ${status}`)
    expect(body).not.toContain('所有渠道均失败')
    expect(getBalance(USER_ID)).toBe(100)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it.each([
    ['GET', 'tasks/original-task', 'openai'],
    ['POST', 'images/generations', 'sb2api-async'],
    ['POST', 'chat/completions', 'openai'],
  ])('%s %s 未授权接口在发送到上游前拒绝（%s）', async (method, endpoint, provider) => {
    let secondCalled = false
    const bad = await startUpstream((req, res) => res.writeHead(503).end('down'))
    const second = await startUpstream((req, res) => {
      secondCalled = true
      res.writeHead(200).end(IMAGE_RESPONSE)
    })
    upstreams = [bad, second]
    await setup([
      { name: '主渠道', baseUrl: `${bad.url}/v1`, apiKey: 'k1', provider },
      { name: '备用渠道', baseUrl: `${second.url}/v1`, apiKey: 'k2', provider },
    ])

    const response = await relay(`ch-1/${endpoint}`, { method, ...(method === 'GET' ? { body: undefined } : {}) })
    expect(response.status).toBe(403)
    expect(secondCalled).toBe(false)
    expect(getBalance(USER_ID)).toBe(100)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it.each([
    { previous_response_id: 'resp-original' },
    { conversation: 'conv-original' },
    { input: [{ type: 'function_call_output', call_id: 'call-original', output: '{}' }] },
    { input: [{ type: 'item_reference', id: 'item-original' }] },
  ])('旧客户端携带原渠道会话引用时不跨渠道重放：%j', async (state) => {
    let secondCalled = false
    const bad = await startUpstream((req, res) => res.writeHead(503).end('down'))
    const second = await startUpstream((req, res) => {
      secondCalled = true
      res.writeHead(200).end(IMAGE_RESPONSE)
    })
    upstreams = [bad, second]
    await setup([
      { name: '主渠道', baseUrl: `${bad.url}/v1`, apiKey: 'k1', apiMode: 'responses' },
      { name: '备用渠道', baseUrl: `${second.url}/v1`, apiKey: 'k2', apiMode: 'responses' },
    ])

    const response = await relay('ch-1/responses', { body: JSON.stringify({ model: 'gpt-image-2', tools: [{ type: 'image_generation' }], ...state }) })
    expect(response.status).toBe(502)
    expect(secondCalled).toBe(false)
    expect(getBalance(USER_ID)).toBe(100)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it('旧客户端新的 Responses 生图仍可在兼容渠道间切换', async () => {
    const bad = await startUpstream((req, res) => res.writeHead(503).end('down'))
    const good = await startUpstream((req, res) => res.writeHead(200).end(JSON.stringify({ output: [{ type: 'image_generation_call', result: 'AAAA' }] })))
    upstreams = [bad, good]
    await setup([
      { name: '主渠道', baseUrl: `${bad.url}/v1`, apiKey: 'k1', apiMode: 'responses' },
      { name: '备用渠道', baseUrl: `${good.url}/v1`, apiKey: 'k2', apiMode: 'responses' },
    ])

    const response = await relay('ch-1/responses', { body: JSON.stringify({ model: 'gpt-image-2', input: 'cat', tools: [{ type: 'image_generation' }] }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ output: [{ result: 'AAAA' }] })
    expect(getBalance(USER_ID)).toBe(99)
  })

  it('超过上传上限在发送上游前拒绝', async () => {
    let receivedBytes = 0
    let secondCalled = false
    const bad = await startUpstream((req, res, body) => {
      receivedBytes = body.length
      res.writeHead(503).end('down')
    })
    const second = await startUpstream((req, res) => {
      secondCalled = true
      res.writeHead(200).end(IMAGE_RESPONSE)
    })
    upstreams = [bad, second]
    await setup([
      { name: '主渠道', baseUrl: `${bad.url}/v1`, apiKey: 'k1' },
      { name: '备用渠道', baseUrl: `${second.url}/v1`, apiKey: 'k2' },
    ])

    const body = Buffer.alloc(65 * 1024 * 1024, 'x')
    const response = await relay('ch-1/images/edits', { body, headers: { 'Content-Type': 'application/octet-stream' } })
    expect(response.status).toBe(413)
    expect(receivedBytes).toBe(0)
    expect(secondCalled).toBe(false)
    expect(getBalance(USER_ID)).toBe(100)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it.each([
    ['text/html', '<html>Gateway temporarily unavailable</html>'],
    ['text/plain', '{"error":{"message":"upstream unavailable"}}'],
    ['application/json', '{"data":[{"b64_json":"unfinished'],
    ['application/json', '{"prompt":{"url":"https://example.com/reference.png","task_id":"echoed-prompt"}}'],
  ])('HTTP 200 的无效 %s 响应不被当作出图成功', async (contentType, body) => {
    const bad = await startUpstream((req, res) => res.writeHead(200, { 'Content-Type': contentType }).end(body))
    const good = await startUpstream((req, res) => res.writeHead(200).end(IMAGE_RESPONSE))
    upstreams = [bad, good]
    await setup([
      { name: '错误页面', baseUrl: `${bad.url}/v1`, apiKey: 'k1' },
      { name: '备用渠道', baseUrl: `${good.url}/v1`, apiKey: 'k2' },
    ])

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(JSON.parse(IMAGE_RESPONSE))
    expect(usageSummary().events.find((item) => item.channelId === 'ch-1')).toMatchObject({ ok: false })
    expect(getBalance(USER_ID)).toBe(99)
    expect(userCreditsView(USER_ID).ledger.filter((item) => item.type === 'spend')).toHaveLength(1)
  })

  it('图片正文尚未完整收到就断流时不误扣费，并能转到备用渠道', async () => {
    const bad = await startUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.write('{"data":[{"b64_json":"AAAA')
      setTimeout(() => res.destroy(), 10)
    })
    const good = await startUpstream((req, res) => res.writeHead(200).end(IMAGE_RESPONSE))
    upstreams = [bad, good]
    await setup([
      { name: '中断渠道', baseUrl: `${bad.url}/v1`, apiKey: 'k1' },
      { name: '备用渠道', baseUrl: `${good.url}/v1`, apiKey: 'k2' },
    ])

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(JSON.parse(IMAGE_RESPONSE))
    expect(getBalance(USER_ID)).toBe(99)
    expect(getReserved(USER_ID)).toBe(0)
    expect(userCreditsView(USER_ID).ledger.filter((item) => item.type === 'spend')).toHaveLength(1)
  })
})

describe('按张扣费', () => {
  it('multipart 里声明 3 张就扣 3 份', async () => {
    const good = await startUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [
        { b64_json: 'AAAA' },
        { b64_json: 'BBBB' },
        { b64_json: 'CCCC' },
      ] }))
    })
    upstreams = [good]
    await setup([{ name: '渠道', baseUrl: `${good.url}/v1`, apiKey: 'k1' }], { costPerImage: 2 })

    const response = await fetch(`http://127.0.0.1:${app.port}/api/relay/ch-1/images/edits`, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=----BoundaryTest', Cookie: cookie },
      body: multipartBody(3),
    })
    expect(response.status).toBe(200)
    expect(getBalance(USER_ID)).toBe(94)
  })

  it('请求 4 张但实际只成功 1 张，仅扣 1 份', async () => {
    const good = await startUpstream((req, res) => res.writeHead(200).end(IMAGE_RESPONSE))
    upstreams = [good]
    await setup([{ name: '渠道', baseUrl: `${good.url}/v1`, apiKey: 'k1' }], { costPerImage: 3 })

    await fetch(`http://127.0.0.1:${app.port}/api/relay/ch-1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ n: 4, prompt: 'cat' }),
    })
    expect(getBalance(USER_ID)).toBe(97)
  })

  it('扣费结果通过响应头回执，前端不用再查一次余额', async () => {
    const good = await startUpstream((req, res) => res.writeHead(200).end(IMAGE_RESPONSE))
    upstreams = [good]
    await setup([{ name: '渠道', baseUrl: `${good.url}/v1`, apiKey: 'k1' }], { costPerImage: 3 })

    const response = await fetch(`http://127.0.0.1:${app.port}/api/relay/ch-1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ n: 2, prompt: 'cat' }),
    })
    expect(response.headers.get('x-credits-charged')).toBe('3')
    expect(response.headers.get('x-credits-balance')).toBe('97')
    expect(getBalance(USER_ID)).toBe(97)
    expect(userCreditsView(USER_ID).ledger[0].note).toBe('出图 1 张')
  })

  it('幸运免单命中：不扣积分并带 x-credits-lucky 头', async () => {
    const good = await startUpstream((req, res) => res.writeHead(200).end(IMAGE_RESPONSE))
    upstreams = [good]
    // 概率 100%，必定命中
    await setup([{ name: '渠道', baseUrl: `${good.url}/v1`, apiKey: 'k1' }], { costPerImage: 3, luckyEnabled: true, luckyRate: 100 })

    const response = await fetch(`http://127.0.0.1:${app.port}/api/relay/ch-1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ n: 2, prompt: 'cat' }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-credits-lucky')).toBe('1')
    expect(response.headers.get('x-credits-charged')).toBe('0')
    expect(getBalance(USER_ID)).toBe(100)
    expect(userCreditsView(USER_ID).ledger[0]).toMatchObject({
      type: 'lucky',
      amount: 0,
      balanceAfter: 100,
      ref: 'ch-1',
    })
    expect(userCreditsView(USER_ID).ledger[0].note).toContain('出图 1 张')
    expect(userCreditsView(USER_ID).ledger[0].note).not.toContain('渠道')
  })

  it('幸运免单未命中：正常扣费，不带 lucky 头', async () => {
    const good = await startUpstream((req, res) => res.writeHead(200).end(IMAGE_RESPONSE))
    upstreams = [good]
    await setup([{ name: '渠道', baseUrl: `${good.url}/v1`, apiKey: 'k1' }], { costPerImage: 3, luckyEnabled: true, luckyRate: 0 })

    const response = await fetch(`http://127.0.0.1:${app.port}/api/relay/ch-1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ n: 1, prompt: 'cat' }),
    })
    expect(response.headers.get('x-credits-lucky')).toBeNull()
    expect(response.headers.get('x-credits-charged')).toBe('3')
    expect(getBalance(USER_ID)).toBe(97)
  })

  it('被邀请人第一次成功出图后，邀请人拿到邀请奖励（且只发一次）', async () => {
    const good = await startUpstream((req, res) => res.writeHead(200).end(IMAGE_RESPONSE))
    upstreams = [good]
    await setup([{ name: '渠道', baseUrl: `${good.url}/v1`, apiKey: 'k1' }], { costPerImage: 3 })

    // 造一个邀请人，并把当前用户标成"他邀请来的"
    const inviterId = 'u-inviter'
    updateConfig((config) => {
      config.site.referralEnabled = true
      config.site.referralReward = 30
      config.site.referralMaxInvites = 20
      config.users = [
        cloneUser(config.users[0], inviterId, 'inviter'),
        { ...config.users[0], invitedBy: inviterId, inviteRewarded: false },
      ]
      return config
    })
    expect(getBalance(inviterId)).toBe(0)

    await fetch(`http://127.0.0.1:${app.port}/api/relay/ch-1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ n: 1, prompt: 'cat' }),
    })
    expect(getBalance(inviterId)).toBe(30)
    expect(findUserById(USER_ID)?.inviteRewarded).toBe(true)

    // 再出一张：不能重复发奖
    await fetch(`http://127.0.0.1:${app.port}/api/relay/ch-1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ n: 1, prompt: 'cat again' }),
    })
    expect(getBalance(inviterId)).toBe(30)
  })

  it('被邀请人第一次成功出图后，邀请人拿到邀请奖励（且只发一次）', async () => {
    const good = await startUpstream((req, res) => res.writeHead(200).end(IMAGE_RESPONSE))
    upstreams = [good]
    await setup([{ name: '渠道', baseUrl: `${good.url}/v1`, apiKey: 'k1' }], { costPerImage: 3 })

    // 造一个邀请人，并把当前用户标成"他邀请来的"
    const inviterId = 'u-inviter'
    updateConfig((config) => {
      config.site.referralEnabled = true
      config.site.referralReward = 30
      config.site.referralMaxInvites = 20
      config.users = [
        cloneUser(config.users[0], inviterId, 'inviter'),
        { ...config.users[0], invitedBy: inviterId, inviteRewarded: false },
      ]
      return config
    })
    expect(getBalance(inviterId)).toBe(0)

    await fetch(`http://127.0.0.1:${app.port}/api/relay/ch-1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ n: 1, prompt: 'cat' }),
    })
    expect(getBalance(inviterId)).toBe(30)
    expect(findUserById(USER_ID)?.inviteRewarded).toBe(true)

    // 再出一张：不能重复发奖
    await fetch(`http://127.0.0.1:${app.port}/api/relay/ch-1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ n: 1, prompt: 'cat again' }),
    })
    expect(getBalance(inviterId)).toBe(30)
  })

  it('失败时不带扣费回执头（用户不该看到余额莫名其妙变了）', async () => {
    const good = await startUpstream((req, res) => res.writeHead(500).end('boom'))
    upstreams = [good]
    await setup([{ name: '渠道', baseUrl: `${good.url}/v1`, apiKey: 'k1' }], { costPerImage: 3 })

    const response = await relay('ch-1/images/generations')
    expect(response.headers.get('x-credits-charged')).toBeNull()
    expect(getBalance(USER_ID)).toBe(100)
  })

  it('浏览器提前断开后上游才完成，后台仍保留这次真实调用记录', async () => {
    let markReceived
    let upstreamCompleted = false
    const received = new Promise((resolve) => { markReceived = resolve })
    const slow = await startUpstream((req, res) => {
      markReceived()
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(IMAGE_RESPONSE)
        upstreamCompleted = true
      }, 80)
    })
    upstreams = [slow]
    await setup([{ name: '慢渠道', baseUrl: `${slow.url}/v1`, apiKey: 'k1' }])

    const controller = new AbortController()
    const pending = relay('ch-1/images/generations', { signal: controller.signal })
    await received
    controller.abort()
    await expect(pending).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 150))

    const summary = usageSummary(new Map([['ch-1', '慢渠道']]))
    expect(summary.totals).toEqual({ total: 1, ok: 1, fail: 0 })
    expect(summary.events[0].aborted).toBe(false)
    expect(getBalance(USER_ID)).toBe(99)
    expect(getReserved(USER_ID)).toBe(0)
    expect(summary.channels[0].state).toBe('healthy')
    expect(upstreamCompleted).toBe(true)
  })

  it('上游用 200 返回错误 JSON 时继续切换且不扣失败渠道的积分', async () => {
    const fakeSuccess = await startUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'upstream failed after accepting request' } }))
    })
    const good = await startUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }))
    })
    upstreams = [fakeSuccess, good]
    await setup([
      { name: '伪成功渠道', baseUrl: `${fakeSuccess.url}/v1`, apiKey: 'k1' },
      { name: '正常渠道', baseUrl: `${good.url}/v1`, apiKey: 'k2' },
    ], { costPerImage: 3 })

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [{ b64_json: 'AAAA' }] })
    expect(getBalance(USER_ID)).toBe(97)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it('所有渠道都返回无图片的 200 时不扣积分', async () => {
    const fakeSuccess = await startUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    upstreams = [fakeSuccess]
    await setup([{ name: '伪成功渠道', baseUrl: `${fakeSuccess.url}/v1`, apiKey: 'k1' }], { costPerImage: 3 })

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('没有可识别的图片')
    expect(getBalance(USER_ID)).toBe(100)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it('渠道倍率生效：落地在贵渠道就按贵的算', async () => {
    const cheap = await startUpstream((req, res) => res.writeHead(503).end('down'))
    const pricey = await startUpstream((req, res) => res.writeHead(200).end(IMAGE_RESPONSE))
    upstreams = [cheap, pricey]
    await setup([
      { name: '便宜但挂了', baseUrl: `${cheap.url}/v1`, apiKey: 'k1' },
      { name: '贵但能用', baseUrl: `${pricey.url}/v1`, apiKey: 'k2' },
    ], { costPerImage: 2, channelRates: { 'ch-1': 50, 'ch-2': 300 } })

    // 预扣按最贵的 ch-2（2 × 300% = 6）占位，实际也落在 ch-2，所以扣 6。
    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(200)
    expect(getBalance(USER_ID)).toBe(94)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it('预扣按最贵候选，落到便宜渠道时差额不会白扣', async () => {
    const good = await startUpstream((req, res) => res.writeHead(200).end(IMAGE_RESPONSE))
    upstreams = [good]
    await setup([{ name: '便宜', baseUrl: `${good.url}/v1`, apiKey: 'k1' }], { costPerImage: 2 })

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(200)
    // 只有一条候选，预扣 = 实扣 = 2。
    expect(getBalance(USER_ID)).toBe(98)
    expect(getReserved(USER_ID)).toBe(0)
  })

  it('余额不足时直接拒掉，不会打到上游', async () => {
    let called = false
    const good = await startUpstream((req, res) => {
      called = true
      res.writeHead(200).end(IMAGE_RESPONSE)
    })
    upstreams = [good]
    await setup([{ name: '渠道', baseUrl: `${good.url}/v1`, apiKey: 'k1' }], { costPerImage: 5, balance: 3 })

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(402)
    const payload = await response.json()
    expect(payload).toMatchObject({ code: 'insufficient-credits', required: 5, available: 3 })
    expect(response.headers.get('x-gip-failover')).toBe('stop')
    expect(called).toBe(false)
    expect(getBalance(USER_ID)).toBe(3)
  })

  it('异步提交只预留，轮询完成按实际结果结算且重复查询不重扣', async () => {
    let done = false
    const good = await startUpstream((req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(req.method === 'POST' ? { task_id: 'abc' } : done ? { status: 'completed', result: { data: [{ b64_json: 'AAAA' }] } } : { status: 'running' })))
    upstreams = [good]
    await setup([{ name: '异步渠道', provider: 'sb2api-async', baseUrl: good.url + '/v1', apiKey: 'k1' }])
    const submitted = await relay('ch-1/images/generations/async', { body: JSON.stringify({ n: 3 }) })
    expect(submitted.status).toBe(200)
    expect(getBalance(USER_ID)).toBe(100)
    expect(getReserved(USER_ID)).toBe(3)
    for (let i = 0; i < 3; i += 1) {
      const response = await relay('ch-1/images/tasks/abc', { method: 'GET', body: undefined })
      await response.json()
      expect(response.status).toBe(200)
    }
    expect(getBalance(USER_ID)).toBe(100)
    done = true
    updateConfig((config) => { config.channels[0].enabled = false; config.channels[0].provider = 'openai'; config.channels[0].model = 'changed-model'; config.channels[0].apiKey = ''; return config })
    for (let i = 0; i < 3; i += 1) {
      const response = await relay('ch-1/images/tasks/abc', { method: 'GET', body: undefined })
      await response.json()
      expect(response.status).toBe(200)
    }
    expect(getBalance(USER_ID)).toBe(99)
    expect(getReserved(USER_ID)).toBe(0)
    expect(generationOrdersForTests()[0].state).toBe('settled')
  })

  it('关掉积分制后完全不计费，回到免费模式', async () => {
    const good = await startUpstream((req, res) => res.writeHead(200).end(IMAGE_RESPONSE))
    upstreams = [good]
    await setup([{ name: '渠道', baseUrl: `${good.url}/v1`, apiKey: 'k1' }], { costPerImage: 5 })
    updateConfig((config) => {
      config.site.credits.enabled = false
      return config
    })

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(200)
    expect(getBalance(USER_ID)).toBe(100)
  })

  it('计费开启但没登录时不做扣费（open / passcode 模式下本就没有账号）', async () => {
    const good = await startUpstream((req, res) => res.writeHead(200).end(IMAGE_RESPONSE))
    upstreams = [good]
    await setup([{ name: '渠道', baseUrl: `${good.url}/v1`, apiKey: 'k1' }])

    const response = await fetch(`http://127.0.0.1:${app.port}/api/relay/ch-1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ n: 4, prompt: 'cat' }),
    })
    // wechat 模式下没 cookie 就是没登录，网关先拦下来。
    expect(response.status).toBe(401)
    expect(response.headers.get('x-gip-failover')).toBe('stop')
    expect(getBalance(USER_ID)).toBe(100)
  })
})

describe('中继的基本防护', () => {
  it('本站并发限制返回停止切换信号，不把用户额度限制扩散到其他渠道', async () => {
    await setup([{ name: '渠道', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k1' }])
    const first = generationGate.acquire(USER_ID)
    const second = generationGate.acquire(USER_ID)
    try {
      const response = await relay('ch-1/images/generations', { headers: { 'X-GIP-Failover': 'client' } })
      expect(response.status).toBe(429)
      expect(response.headers.get('x-gip-failover')).toBe('stop')
      expect(await response.json()).toMatchObject({ code: 'generation-busy' })
      expect(usageSummary().events).toHaveLength(0)
      expect(getBalance(USER_ID)).toBe(100)
    } finally {
      first.release()
      second.release()
    }
  })

  it('停用或未配置密钥的渠道直接被拒，不会尝试转发', async () => {
    await setup([{ name: '停用渠道', baseUrl: 'https://example.com/v1', apiKey: '' }])
    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(503)
  })

  it('请求不存在的渠道返回 404', async () => {
    await setup([{ name: '渠道', baseUrl: 'https://example.com/v1', apiKey: 'k' }])
    const response = await relay('ch-does-not-exist/images/generations')
    expect(response.status).toBe(404)
  })

  it('cookie 与真实密钥都不会泄漏给上游', async () => {
    let seenHeaders = null
    const upstream = await startUpstream((req, res) => {
      seenHeaders = req.headers
      res.writeHead(200).end(IMAGE_RESPONSE)
    })
    upstreams = [upstream]
    await setup([{ name: '渠道', baseUrl: `${upstream.url}/v1`, apiKey: 'super-secret-key' }])

    await relay('ch-1/images/generations')
    expect(seenHeaders.cookie).toBeUndefined()
    expect(seenHeaders.authorization).toBe('Bearer super-secret-key')
    expect(seenHeaders.host).toContain('127.0.0.1')
    // 上游要知道真实 Host，但不能看到我们的内网头。
    expect(seenHeaders['x-forwarded-for']).toBeUndefined()
  })

  it('渠道配置里没有积分字段也能正常工作（老配置向后兼容）', async () => {
    const good = await startUpstream((req, res) => res.writeHead(200).end(IMAGE_RESPONSE))
    upstreams = [good]
    await setup([{ name: '渠道', baseUrl: `${good.url}/v1`, apiKey: 'k1' }], { costPerImage: 1 })

    const response = await relay('ch-1/images/generations')
    expect(response.status).toBe(200)
    expect(getConfig().site.accessMode).toBe('wechat')
  })
})
