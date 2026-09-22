// 菜单跳转审计：用本机 Chrome 的 DevTools 协议真实点一遍所有导航入口，报告失败项。
// 起因是 vite 的 base 是 './'，react-router 的 basename 一旦拿到相对路径就会整表失配——
// 表现是「页面能看，但点哪儿都没反应」。这类问题靠肉眼 review 很容易漏，交给脚本点。
//
// 用法：先 npm run dev，另开终端执行
//   node scripts/audit-menu.mjs
// 需要本机装有 Chrome（路径可用 CHROME_PATH 覆盖）。退出码非 0 表示有失败项。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = process.env.AUDIT_BASE_URL || 'http://localhost:5173'
const PORT = Number(process.env.AUDIT_CDP_PORT || 9411)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const profileDir = mkdtempSync(join(tmpdir(), 'audit-menu-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, 'about:blank',
], { stdio: 'ignore' })

let socket
let messageId = 1
const pending = new Map()
const consoleErrors = []

function send(method, params) {
  const id = messageId++
  socket.send(JSON.stringify({ id, method, params: params ?? {} }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function waitForDevtools() {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (response.ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error('Chrome DevTools 未就绪，请确认已安装 Chrome')
}

let failed = 0
function report(label, ok, detail) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  | ${detail}` : ''}`)
}

try {
  await waitForDevtools()
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((arg) => arg.value || arg.description).join(' ').slice(0, 160))
    }
    const entry = message.id && pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result)
  }
  await send('Runtime.enable')

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  const open = async (path, wait = 2200) => {
    await evaluate(`location.href = ${JSON.stringify(BASE + path)}`)
    await sleep(wait)
  }
  const click = async (selector, wait = 1000) => {
    const state = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; el.click(); return 'clicked' })()`)
    await sleep(wait)
    return state
  }
  const clickByText = async (label, wait = 1000) => {
    const state = await evaluate(`(() => { const el = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === ${JSON.stringify(label)}); if (!el) return 'missing'; el.click(); return 'clicked' })()`)
    await sleep(wait)
    return state
  }
  const currentUrl = () => evaluate('location.pathname + location.search')
  const inAppShell = () => evaluate('!!document.querySelector("aside")')

  // 公开页导航：每项都应跳到对应路由
  for (const [label, selector, expected] of [
    ['公开导航 · AI 绘画', 'nav a[href="/studio"]', '/studio'],
    ['公开导航 · 作品广场', 'nav a[href="/gallery"]', '/gallery'],
    ['公开导航 · 价格与积分', 'nav a[href="/pricing"]', '/pricing'],
    ['公开导航 · 帮助中心', 'nav a[href="/help"]', '/help'],
    ['公开导航 · 登录', 'a[href="/login"]', '/login'],
    ['公开导航 · 注册', 'a[href="/register"]', '/register'],
  ]) {
    await open('/')
    const state = await click(selector)
    const url = await currentUrl()
    report(label, state === 'clicked' && url === expected, `${state} -> ${url}（期望 ${expected}）`)
  }

  // 应用侧栏：既要跳对，也要留在应用外壳里
  for (const [label, selector, expected] of [
    ['侧栏 · AI 绘画', 'aside a[href="/studio"]', '/studio'],
    ['侧栏 · 作品广场', 'aside a[href="/gallery"]', '/gallery'],
    ['侧栏 · 我的作品', 'aside a[href="/me?tab=works"]', '/me?tab=works'],
    ['侧栏 · 积分中心', 'aside a[href="/me?tab=ledger"]', '/me?tab=ledger'],
    ['侧栏 · 个人中心', 'aside a[href="/me"]', '/me'],
    ['侧栏 · 帮助中心', 'aside a[href="/help"]', '/help'],
  ]) {
    await open('/studio', 2600)
    const state = await click(selector)
    const url = await currentUrl()
    const shell = await inAppShell()
    report(label, state === 'clicked' && url === expected && shell, `${state} -> ${url}（期望 ${expected}）应用外壳=${shell}`)
  }

  // 侧栏 Logo 不该把用户踢回营销首页
  await open('/studio', 2600)
  await click('aside a[href="/studio"]')
  report('侧栏 Logo 留在应用内', (await currentUrl()) === '/studio', await currentUrl())

  // 创作台模式切换
  await open('/studio', 2600)
  for (const mode of ['图生图', '局部重绘', 'AI 扩图', '文生图']) {
    const state = await clickByText(mode)
    const active = await evaluate(`(() => { const el = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === ${JSON.stringify(mode)}); return el ? el.className.includes('7c6cf6') : false })()`)
    report(`创作台模式「${mode}」`, state === 'clicked' && active, state)
  }

  // 作品广场排序页签
  await open('/gallery', 2600)
  for (const tab of ['推荐', '最新', '最热']) {
    report(`广场页签「${tab}」`, (await clickByText(tab)) === 'clicked')
  }

  // 个人中心页签
  for (const tab of ['我的作品', '我的收藏', '积分记录', '订单记录', '账号设置']) {
    await open('/me', 2600)
    report(`个人中心页签「${tab}」`, (await clickByText(tab)) === 'clicked')
  }

  // 已下线的旧路由应回落到首页，而不是白屏
  await open('/classic', 1600)
  report('/classic 回落首页', (await currentUrl()) === '/', await currentUrl())

  report('无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '))
} catch (error) {
  failed++
  console.log(`FAIL  脚本执行  | ${error.message}`)
} finally {
  try { socket?.close() } catch {}
  chrome.kill()
  await sleep(300)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
  console.log(`\n失败 ${failed} 项`)
  process.exit(failed ? 1 : 0)
}
