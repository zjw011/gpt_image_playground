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
import { addCredits, getBalance, getReserved, initCredits, resetReservations } from './credits.mjs'
import { sendError } from './http.mjs'
import { handleGuestRoute } from './guestRoutes.mjs'
import { generationGate } from './generationGate.mjs'
import { GUEST_COOKIE, createSession } from './sessions.mjs'
import { findUserById, getConfig, initStore, normalizeChannel, normalizeUser, updateConfig } from './store.mjs'
import { initUsage, usageSummary } from './usage.mjs'
import { getUpstreamTimeoutMs } from './relay.mjs'

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
  return fetch(`http://127.0.0.1:${app.port}/api/relay/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(init.headers ?? {}) },
    body: JSON.stringify({ model: 'gpt-image-2', prompt: 'cat' }),
    ...init,
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

describe('渠道故障转移', () => {
  it('生图请求至少等待 5 分钟，普通接口仍采用渠道配置', () => {
    expect(getUpstreamTimeoutMs({ timeout: 15 }, true)).toBe(300_000)
    expect(getUpstreamTimeoutMs({ timeout: 900 }, true)).toBe(900_000)
    expect(getUpstreamTimeoutMs({ timeout: 15 }, false)).toBe(15_000)
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

  it('JSON 请求体里 n=4 就扣 4 份', async () => {
    const good = await startUpstream((req, res) => res.writeHead(200).end(IMAGE_RESPONSE))
    upstreams = [good]
    await setup([{ name: '渠道', baseUrl: `${good.url}/v1`, apiKey: 'k1' }], { costPerImage: 3 })

    await fetch(`http://127.0.0.1:${app.port}/api/relay/ch-1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ n: 4, prompt: 'cat' }),
    })
    expect(getBalance(USER_ID)).toBe(88)
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
    expect(response.headers.get('x-credits-charged')).toBe('6')
    expect(response.headers.get('x-credits-balance')).toBe('94')
    expect(getBalance(USER_ID)).toBe(94)
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
    expect(response.headers.get('x-credits-charged')).toBeNull()
    expect(getBalance(USER_ID)).toBe(100)
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
    const received = new Promise((resolve) => { markReceived = resolve })
    const slow = await startUpstream((req, res) => {
      markReceived()
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(IMAGE_RESPONSE)
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
    expect(summary.totals).toEqual({ total: 1, ok: 0, fail: 1 })
    expect(summary.events[0].aborted).toBe(true)
    expect(summary.channels[0].state).toBe('healthy')
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
    expect(called).toBe(false)
    expect(getBalance(USER_ID)).toBe(3)
  })

  it('轮询用的 GET 永远不计费——异步渠道一次出图能轮几十次', async () => {
    const good = await startUpstream((req, res) => res.writeHead(200).end('{"status":"running"}'))
    upstreams = [good]
    await setup([{ name: '异步渠道', baseUrl: `${good.url}/v1`, apiKey: 'k1' }])

    for (let i = 0; i < 5; i += 1) {
      const response = await fetch(`http://127.0.0.1:${app.port}/api/relay/ch-1/tasks/abc`, { headers: { Cookie: cookie } })
      expect(response.status).toBe(200)
    }
    expect(getBalance(USER_ID)).toBe(100)
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
    expect(getBalance(USER_ID)).toBe(100)
  })
})

describe('中继的基本防护', () => {
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
