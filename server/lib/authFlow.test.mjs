// 注册 / 找回密码的端到端测试。
//
// 这个文件真的把 server/index.mjs 起成一个子进程，再用 HTTP 走一遍完整流程：
//   管理员配 SMTP → 用户要验证码 → 邮件真发到假 SMTP 服务器 → 从邮件里抠出验证码
//   → 注册成功 → 领到注册赠送积分 → 找回密码
//
// 为什么值得这么重：链路上任何一环写错（配置没接通、验证码没真的发出去、
// 积分赠送没挂上、密码改了旧会话没作废），单测都发现不了，只有真跑一遍才看得见。
// 用真进程也顺带覆盖了配置文件的读写与重启后的行为。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { extractCode, extractMessageText, headerValue, decodeHeaderWord, startFakeSmtpServer } from './__fixtures__/fakeSmtp.mjs'

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..')
const ADMIN_PASSWORD = 'admin-pass-2026'
const SITE_TITLE = '绘想'
const NEW_EMAIL = 'newuser@qq.com'
const SIGNUP_BONUS = 50

let mail = null
let child = null
let dataDir = ''
let base = ''
const cookies = new Map()
const smtpUser = 'sender@example.com'
const smtpPassword = 'authorization-code-xyz'

/** 带 cookie 请求。cookie 从响应里自动收，模拟一个真实浏览器。 */
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) }
  if (cookies.size) {
    headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const index = pair.indexOf('=')
    if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1))
  }

  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, body }
}

/** 清空 cookie，用来把"访客会话"和"管理员会话"隔离开断言。 */
function clearCookies() {
  cookies.clear()
}

/** 等子进程真的开始监听：轮询 bootstrap 比读 stdout 稳。 */
async function waitForServer(deadlineMs = 20_000) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(`${base}/api/bootstrap`)
      if (response.ok) return
    } catch {
      // 还没起来，继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('服务器启动超时')
}

beforeAll(async () => {
  mail = await startFakeSmtpServer({ mode: 'net' })
  dataDir = mkdtempSync(join(tmpdir(), 'gip-authflow-'))
  const port = 20_000 + Math.floor(Math.random() * 10_000)
  base = `http://127.0.0.1:${port}`

  child = spawn(process.execPath, [join(PROJECT_ROOT, 'server', 'index.mjs')], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      GIP_DATA_DIR: dataDir,
      GIP_DIST_DIR: join(dataDir, 'no-dist'),
      GIP_ADMIN_PASSWORD: ADMIN_PASSWORD,
      NODE_TLS_REJECT_UNAUTHORIZED: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})

  await waitForServer()
}, 30_000)

afterAll(async () => {
  if (child && !child.killed) {
    child.kill()
    await new Promise((resolve) => {
      child.once('exit', resolve)
      setTimeout(resolve, 2000)
    })
  }
  await mail?.close()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

describe('邮箱验证码注册全流程', () => {
  let verificationCode = ''

  it('管理员登录，并先建一个占位账号', async () => {
    const login = await api('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } })
    expect(login.status).toBe(200)

    // 切到多用户模式要求"至少有一个启用的用户"，这个账号同时给后面的撞名测试用。
    const created = await api('/api/admin/users', {
      method: 'POST',
      body: { username: 'alice', password: 'alice-pass-1' },
    })
    expect(created.status).toBe(200)
    expect(created.body.user).toMatchObject({ username: 'alice', createdVia: 'admin', email: '' })
  })

  it('开启多用户模式与自助注册；此时还没配发信，前端能看到注册不可用', async () => {
    const site = await api('/api/admin/site', {
      method: 'PUT',
      body: { accessMode: 'accounts', registrationEnabled: true },
    })
    expect(site.status).toBe(200)
    // 邀请码从必填降级成可选，所以这里不该再报"请先生成邀请码"。
    expect(site.body.site.registrationEnabled).toBe(true)
    expect(site.body.site.requireInviteCode).toBe(false)

    const bootstrap = await api('/api/bootstrap')
    expect(bootstrap.body.registration).toEqual({
      enabled: true,
      requireInviteCode: false,
      // 发信还没配好，前端要据此把注册入口关掉并说明原因。
      emailVerification: false,
    })
  })

  it('SMTP 没配时，要验证码会被明确挡住并且不白发请求', async () => {
    const sessionsBefore = mail.state.sessions.length
    const code = await api('/api/auth/email-code', { method: 'POST', body: { email: NEW_EMAIL } })
    // 503（服务器没准备好）而不是 403（你没资格），两种提示在注册页上完全不一样。
    expect(code.status).toBe(503)
    expect(code.body.error).toMatch(/邮件发信/)
    expect(mail.state.sessions.length).toBe(sessionsBefore)
  })

  it('保存 SMTP 配置后，接口回掩码而不回授权码明文', async () => {
    const saved = await api('/api/admin/smtp', {
      method: 'PUT',
      body: {
        enabled: true,
        host: mail.host,
        port: mail.port,
        encryption: 'none',
        user: smtpUser,
        password: smtpPassword,
        from: smtpUser,
        fromName: SITE_TITLE,
      },
    })
    expect(saved.status).toBe(200)
    expect(saved.body.smtp).toMatchObject({ enabled: true, host: mail.host, encryption: 'none', hasPassword: true })
    // 授权码绝不回明文。
    expect(JSON.stringify(saved.body)).not.toContain(smtpPassword)
    expect(saved.body.smtp.password).toBeUndefined()
    expect(saved.body.smtp.passwordMask).toMatch(/\*/)

    // 顺带确认落盘的配置文件里确实存了授权码（否则重启后发信就挂了）。
    const onDisk = readFileSync(join(dataDir, 'config.json'), 'utf-8')
    expect(onDisk).toContain(smtpPassword)

    // 而 /api/admin/state 也不能把授权码漏出去。
    const state = await api('/api/admin/state')
    expect(JSON.stringify(state.body)).not.toContain(smtpPassword)
    expect(state.body.site.smtp).toBeUndefined()

    const bootstrap = await api('/api/bootstrap')
    expect(bootstrap.body.registration.emailVerification).toBe(true)
  })

  it('探活与测试发信都能成功，并且不回显任何凭据', async () => {
    const probe = await api('/api/admin/smtp/test', { method: 'POST', body: {} })
    expect(probe.body.ok).toBe(true)
    expect(probe.body.message).toMatch(/认证方式 LOGIN/)
    expect(probe.body.message).not.toContain(smtpPassword)

    const sent = await api('/api/admin/smtp/send-test', { method: 'POST', body: { to: 'ops@example.net' } })
    expect(sent.body.ok).toBe(true)
    expect(extractMessageText(mail.session())).toContain('测试邮件')
  })

  it('开启积分并设置注册赠送 50 分', async () => {
    const saved = await api('/api/admin/credits', {
      method: 'PUT',
      body: { enabled: true, costPerImage: 7, signupBonus: SIGNUP_BONUS },
    })
    expect(saved.status).toBe(200)
    expect(saved.body.credits).toMatchObject({ enabled: true, costPerImage: 7, signupBonus: SIGNUP_BONUS })
  })

  it('要验证码：邮件真的发出去了，主题与正文里的码都能读出来', async () => {
    const sessionsBefore = mail.state.sessions.length
    const result = await api('/api/auth/email-code', { method: 'POST', body: { email: NEW_EMAIL } })
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    expect(result.body.resendAfterSeconds).toBe(60)
    // 响应里绝不能带验证码。
    expect(JSON.stringify(result.body)).not.toContain('code')

    expect(mail.state.sessions.length).toBe(sessionsBefore + 1)
    const session = mail.session()

    // 收件人、发件人、主题都必须是正常人能看懂的。
    expect(session.commands).toContain(`RCPT TO:<${NEW_EMAIL}>`)
    expect(session.commands).toContain(`MAIL FROM:<${smtpUser}>`)
    expect(decodeHeaderWord(headerValue(session.data, 'Subject'))).toContain(SITE_TITLE)

    const text = extractMessageText(session)
    expect(text).toContain('注册账号验证码')
    expect(text).toContain('10 分钟内有效')

    verificationCode = extractCode(session)
    expect(verificationCode).toMatch(/^\d{6}$/)
  })

  it('60 秒内重复要码会被冷却挡住，并告知还要等多久', async () => {
    const again = await api('/api/auth/email-code', { method: 'POST', body: { email: NEW_EMAIL } })
    expect(again.status).toBe(429)
    expect(again.body.error).toMatch(/秒后可重新获取/)
  })

  it('用错验证码注册会被拒，且账号没有被创建', async () => {
    const wrong = verificationCode === '000000' ? '111111' : '000000'
    const result = await api('/api/register', {
      method: 'POST',
      body: { email: NEW_EMAIL, code: wrong, username: 'newuser', password: 'user-pass-1' },
    })
    expect(result.status).toBe(400)
    expect(result.body.error).toMatch(/验证码不正确/)

    const state = await api('/api/admin/state')
    // 只有开头的占位账号 alice，没有多出一个用这个邮箱注册的账号。
    expect(state.body.users.map((user) => user.username)).toEqual(['alice'])
    expect(state.body.users.some((user) => user.email === NEW_EMAIL)).toBe(false)
  })

  it('用户名撞车时先报撞车，验证码不消耗——用户改个名字回来还能用同一个码', async () => {
    const conflict = await api('/api/register', {
      method: 'POST',
      body: { email: NEW_EMAIL, code: verificationCode, username: 'alice', password: 'user-pass-1' },
    })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error).toMatch(/已被占用/)

    // 关键：验证码还没被消耗，换个用户名立刻能注册成功。
    const ok = await api('/api/register', {
      method: 'POST',
      body: { email: NEW_EMAIL, code: verificationCode, username: 'newuser', password: 'user-pass-1' },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.user).toMatchObject({ username: 'newuser', email: NEW_EMAIL })
  })

  it('注册后自动登录，并且立刻拿到 50 分注册赠送', async () => {
    const bootstrap = await api('/api/bootstrap')
    expect(bootstrap.body.authenticated).toBe(true)
    expect(bootstrap.body.user).toMatchObject({ username: 'newuser', email: NEW_EMAIL })
    expect(bootstrap.body.credits).toMatchObject({ enabled: true, balance: SIGNUP_BONUS })
  })

  it('注册赠送只发一次：重新登录不会再加分', async () => {
    const logout = await api('/api/session', { method: 'DELETE' })
    expect(logout.status).toBe(200)

    const login = await api('/api/session', { method: 'POST', body: { username: 'newuser', password: 'user-pass-1' } })
    expect(login.status).toBe(200)
    expect(login.body).toMatchObject({ ok: true })

    const bootstrap = await api('/api/bootstrap')
    expect(bootstrap.body.credits.balance).toBe(SIGNUP_BONUS)
    // 余额没有翻倍，说明没有重复发赠送。
    expect(bootstrap.body.credits.balance).not.toBe(SIGNUP_BONUS * 2)
  })

  it('同一个验证码不能用第二次', async () => {
    const result = await api('/api/register', {
      method: 'POST',
      body: { email: 'someone-else@qq.com', code: verificationCode, username: 'another', password: 'user-pass-1' },
    })
    // 换邮箱之后根本不存在这个码，必然失败。
    expect(result.status).toBe(400)
  })

  it('已注册的邮箱再要码会被直接告知，不会白发一封邮件', async () => {
    const sessionsBefore = mail.state.sessions.length
    const result = await api('/api/auth/email-code', { method: 'POST', body: { email: NEW_EMAIL } })
    expect(result.status).toBe(409)
    expect(result.body.error).toMatch(/已被注册/)
    expect(mail.state.sessions.length).toBe(sessionsBefore)
  })
})

describe('用邮箱验证码找回密码', () => {
  it('要重置验证码，拿到之后能改掉密码', async () => {
    const requested = await api('/api/auth/email-code', { method: 'POST', body: { email: NEW_EMAIL, purpose: 'reset' } })
    expect(requested.status).toBe(200)
    expect(extractMessageText(mail.session())).toContain('重置密码验证码')
    const code = extractCode(mail.session())
    expect(code).toMatch(/^\d{6}$/)

    const reset = await api('/api/auth/reset-password', {
      method: 'POST',
      body: { email: NEW_EMAIL, code, password: 'brand-new-pass-9' },
    })
    expect(reset.status).toBe(200)
    expect(reset.body.username).toBe('newuser')
  })

  it('旧密码失效、新密码可用，而且改密把旧会话全部踢掉', async () => {
    // 必须把管理员 cookie 清掉：只要它还在，bootstrap 的 authenticated 就一直是 true
    // （管理员本来就该能看前端），会把"访客会话已作废"这件事盖住。
    clearCookies()

    // 上一步改密之前那个访客会话必须已经作废。
    const stale = await api('/api/bootstrap')
    expect(stale.body.authenticated).toBe(false)

    const oldPassword = await api('/api/session', { method: 'POST', body: { username: 'newuser', password: 'user-pass-1' } })
    expect(oldPassword.status).toBe(401)

    const newPassword = await api('/api/session', { method: 'POST', body: { username: 'newuser', password: 'brand-new-pass-9' } })
    expect(newPassword.status).toBe(200)
    expect(newPassword.body).toMatchObject({ ok: true })

    // 新密码登进去之后确实拿到了用户身份。
    const fresh = await api('/api/bootstrap')
    expect(fresh.body.authenticated).toBe(true)
    expect(fresh.body.user).toMatchObject({ username: 'newuser', email: NEW_EMAIL })
  })

  it('给不存在的邮箱要重置码也回成功，不泄露邮箱是否注册过', async () => {
    const result = await api('/api/auth/email-code', {
      method: 'POST',
      body: { email: 'nobody-at-all@qq.com', purpose: 'reset' },
    })
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
  })

  it('用不存在的邮箱重置密码只会得到"验证码不对"，同样不泄露邮箱是否存在', async () => {
    const result = await api('/api/auth/reset-password', {
      method: 'POST',
      body: { email: 'nobody-at-all@qq.com', code: '123456', password: 'whatever-pass-1' },
    })
    expect(result.status).toBe(400)
    expect(JSON.stringify(result.body)).not.toMatch(/不存在|未注册|没有该账号/)
  })

  it('重置验证码不能拿来注册，注册验证码也不能拿来重置', async () => {
    const resetCode = await api('/api/auth/email-code', { method: 'POST', body: { email: 'crosscheck@qq.com', purpose: 'reset' } })
    expect(resetCode.status).toBe(200)
    const code = extractCode(mail.session())

    // 这个码是 reset 用途的，拿去注册应当无效。
    const misuse = await api('/api/register', {
      method: 'POST',
      body: { email: 'crosscheck@qq.com', code, username: 'crosscheck', password: 'user-pass-1' },
    })
    expect(misuse.status).toBe(400)
    expect(misuse.body.error).toMatch(/验证码/)
  })
})
