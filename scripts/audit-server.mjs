// 托管模式审计：自己起一个真实后端，切换几种站点配置，验证「后台说了算」在界面上的表现。
// 覆盖的是纯前端模式下测不到的分支：邮件发信开关、积分制开关、口令模式、渠道只读。
//
// 用法（先 npm run build，后端直接吃 dist 产物）：
//   node scripts/audit-server.mjs
// 需要本机装有 Chrome（可用 CHROME_PATH 覆盖）。退出码非 0 表示有失败项。
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchChrome } from './lib/cdp.mjs'

const PORT = Number(process.env.AUDIT_SERVER_PORT || 8099)
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT || 9412)
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = resolve(import.meta.dirname, '..')
// 用独立数据目录：绝不能碰用户的 server-data，那里是真账号和真渠道。
const DATA_DIR = mkdtempSync(join(tmpdir(), 'gip-audit-data-'))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failed = 0
function report(label, ok, detail) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  | ${detail}` : ''}`)
}

let server
async function startServer() {
  server = spawn(process.execPath, [join(ROOT, 'server/index.mjs')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', GIP_DATA_DIR: DATA_DIR, GIP_ADMIN_PASSWORD: 'audit-admin-pass' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`${BASE}/api/bootstrap`)
      if (response.ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error('后端未就绪')
}

async function stopServer() {
  if (!server) return
  server.kill()
  server = undefined
  await sleep(600)
}

const readConfig = () => JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf8'))
const writeConfig = (config) => writeFileSync(join(DATA_DIR, 'config.json'), JSON.stringify(config, null, 2))

/** 每个场景：改一份站点配置，然后断言几个页面上的文案 */
const SCENARIOS = [
  {
    name: '开放模式 · 未开积分制 · 无渠道',
    patch: (config) => {
      config.site.accessMode = 'open'
      config.site.credits.enabled = false
      config.channels = []
    },
    checks: [
      { path: '/', has: ['进入创作'], hasNot: ['立即注册'] },
      { path: '/studio', has: ['AI 绘画', '立即生成'], hasNot: ['设置'] },
      // 没开积分制就不该有人对着一个买不到的价签点支付
      { path: '/recharge', has: ['本站未开启积分制'], hasNot: ['立即支付'] },
    ],
  },
  {
    name: '账号模式 · 邮件发信未配置',
    patch: (config) => {
      config.site.accessMode = 'accounts'
      config.site.registrationEnabled = true
      config.site.smtp = { ...config.site.smtp, enabled: false, host: '', user: '', password: '', from: '' }
    },
    checks: [
      { path: '/', has: ['登录', '注册'] },
      { path: '/register', has: ['邮件发信还没配置好'] },
      { path: '/forgot', has: ['邮件发信还没配置好'] },
    ],
  },
  {
    name: '账号模式 · 邮件发信已配置',
    patch: (config) => {
      config.site.accessMode = 'accounts'
      config.site.registrationEnabled = true
      config.site.smtp = { ...config.site.smtp, enabled: true, host: 'smtp.example.com', port: 465, encryption: 'ssl', user: 'audit@example.com', password: 'audit-pass', from: 'audit@example.com' }
    },
    checks: [
      { path: '/register', has: ['获取验证码'], hasNot: ['邮件发信还没配置好'] },
      { path: '/forgot', has: ['获取验证码'], hasNot: ['邮件发信还没配置好'] },
    ],
  },
  {
    name: '口令模式',
    patch: (config) => {
      config.site.accessMode = 'passcode'
    },
    checks: [
      // 口令模式登录页只有口令一个字段，没有用户名
      { path: '/login', has: ['欢迎回来'] },
      { path: '/login', probe: 'document.querySelector("input[type=password]").placeholder', has: ['访问口令'] },
      // 口令模式不开注册，直接回登录页
      { path: '/register', has: ['欢迎回来'] },
      // 口令模式根本没有邮箱密码账号，别让人填一整张表才被拒
      { path: '/forgot', has: ['本站不是用邮箱密码登录的'] },
    ],
  },
]

let browser
try {
  console.log('准备审计环境…')
  await startServer()
  await stopServer()

  browser = await launchChrome({ port: CDP_PORT, baseUrl: BASE })

  for (const scenario of SCENARIOS) {
    const config = readConfig()
    scenario.patch(config)
    writeConfig(config)
    await startServer()

    console.log(`\n【${scenario.name}】`)
    for (const check of scenario.checks) {
      await browser.open(check.path, 2200)
      // 先等关键文案出现再读：冷启动/慢网时固定 sleep 会把"还没渲染完"误报成失败
      if (check.has?.length) {
        for (let i = 0; i < 40; i++) {
          const current = await browser.text()
          if (check.has.every((keyword) => current.includes(keyword))) break
          await sleep(200)
        }
      }
      // 默认拿整页文本；给了 probe 就读指定元素的属性（placeholder 之类不在 innerText 里）
      const text = check.probe ? String(await browser.evaluate(check.probe)) : await browser.text()
      const missing = (check.has ?? []).filter((keyword) => !text.includes(keyword))
      const present = (check.hasNot ?? []).filter((keyword) => text.includes(keyword))
      const detail = [
        missing.length ? `缺少「${missing.join('、')}」` : '',
        present.length ? `不该出现「${present.join('、')}」` : '',
      ].filter(Boolean).join('；')
      report(`${check.path}${check.probe ? ' · placeholder' : ''}`, missing.length === 0 && present.length === 0, detail || `已含「${(check.has ?? []).join('、')}」`)
    }

    await stopServer()
  }

  // ===== 后台入口：同一个登录入口，靠 role 分流 =====
  // 这一组必须单独跑：要先真的登录（拿到带 userId 的会话），再断言页面。
  {
    const config = readConfig()
    config.site.accessMode = 'accounts'
    config.site.registrationEnabled = false
    config.channels = []
    writeConfig(config)
    await startServer()

    console.log('\n【后台入口与角色分流】')

    // 未登录：/admin 不该渲染任何后台内容，应该被守卫送回登录页
    await browser.open('/admin', 2400)
    report('未登录访问 /admin 被送回登录页', (await browser.url()).startsWith('/login'), await browser.url())

    // 用站长账号登录（服务器启动时由 GIP_ADMIN_PASSWORD 播种，用户名默认 admin）
    const loginResult = await browser.evaluate(`(async () => {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'audit-admin-pass' }),
      })
      return { status: response.status, body: await response.json() }
    })()`)
    report('站长账号能登录且拿到 admin 角色', loginResult.status === 200 && loginResult.body?.user?.role === 'admin', `status=${loginResult.status} role=${loginResult.body?.user?.role}`)

    await browser.open('/admin', 2600)
    const dashboard = await browser.text()
    report('登录后 /admin 渲染仪表盘', dashboard.includes('仪表盘') && dashboard.includes('渠道链路'), dashboard.slice(0, 60).replace(/\n/g, ' '))

    // 侧栏每一项都要真的能打开，不能点进去空白。
    // 关键词一律取页面正文里独有的词——不要用「渠道链路」「积分」这种侧栏里也有的，
    // 否则视图根本没渲染、只渲染了壳，断言照样会绿。
    for (const [tab, keyword] of [
      ['channels', '新建渠道'],
      ['usage', '累计请求'],
      ['users', '新建用户'],
      ['credits', '生成卡密'],
      ['smtp', 'SMTP 发信配置'],
      ['site', '保存设置'],
    ]) {
      await browser.open(`/admin?tab=${tab}`, 2600)
      const text = await browser.text()
      report(`/admin?tab=${tab} 有内容`, text.includes(keyword), text.includes(keyword) ? `已含「${keyword}」` : text.slice(0, 60).replace(/\n/g, ' '))
    }

    // 微信登录这一版只放占位入口，必须明确写着开发中
    await browser.open('/admin?tab=wechat', 2400)
    const wechat = await browser.text()
    report('微信登录页显示开发中占位', wechat.includes('开发中') && wechat.includes('当前可用的登录方式'), wechat.slice(0, 60).replace(/\n/g, ' '))

    // 认不出来的 tab 回仪表盘，而不是空白页
    await browser.open('/admin?tab=nonsense', 2200)
    const fallback = await browser.text()
    report('未知 tab 回落到仪表盘', fallback.includes('仪表盘') && fallback.includes('今日出图'), fallback.slice(0, 40).replace(/\n/g, ' '))

    // 普通用户不能进后台
    const normalUser = await browser.evaluate(`(async () => {
      const created = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'audit-user', password: 'audit-user-pass' }),
      })
      if (!created.ok) return { created: created.status }
      await fetch('/api/session', { method: 'DELETE' })
      const login = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'audit-user', password: 'audit-user-pass' }),
      })
      return { created: created.status, login: login.status, body: await login.json() }
    })()`)
    report('普通用户账号可创建并可登录', normalUser.created === 200 && normalUser.login === 200 && normalUser.body?.user?.role === 'user', JSON.stringify(normalUser).slice(0, 120))

    await browser.open('/admin', 2600)
    const asUser = await browser.url()
    report('普通用户访问 /admin 被送回创作页', asUser.startsWith('/studio'), asUser)

    // 单层结果页：硬刷新（直接输地址）不能白屏——多层路径会白屏，这是防回归。
    for (const path of ['/result', '/studio', '/gallery', '/me', '/recharge']) {
      await browser.open(path, 2400)
      const text = await browser.text()
      report(`${path} 硬刷新有内容`, text.trim().length > 20, `${text.trim().length} 字`)
    }

    await stopServer()
  }
} catch (error) {
  failed++
  console.log(`FAIL  脚本执行  | ${error.message}`)
} finally {
  try { await browser?.close() } catch {}
  await stopServer()
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch {}
  console.log(`\n失败 ${failed} 项`)
  process.exit(failed ? 1 : 0)
}
