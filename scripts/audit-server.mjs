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
