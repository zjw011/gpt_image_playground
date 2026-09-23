// 菜单跳转审计：用本机 Chrome 的 DevTools 协议真实点一遍所有导航入口，报告失败项。
// 起因是 vite 的 base 是 './'，react-router 的 basename 一旦拿到相对路径就会整表失配——
// 表现是「页面能看，但点哪儿都没反应」。这类问题靠肉眼 review 很容易漏，交给脚本点。
//
// 脚本自己起一个 vite（纯前端模式：没有 dev-proxy.config.json，/api 拿不到 JSON，
// 于是走"没有后端"的分支），跑完自己关掉。这样不会像以前那样——dev server 早就死了，
// 脚本却还在对着 5173 一通点击，把"全部超时"报成一堆业务断言失败。
//
// 用法：node scripts/audit-menu.mjs
// 需要本机装有 Chrome（可用 CHROME_PATH 覆盖）。退出码非 0 表示有失败项。
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { launchChrome } from './lib/cdp.mjs'
import { startDevServer } from './lib/devServer.mjs'

const PORT = Number(process.env.AUDIT_DEV_PORT || 5179)
const BASE = process.env.AUDIT_BASE_URL || `http://127.0.0.1:${PORT}`
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT || 9411)
const ROOT = resolve(import.meta.dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
function report(label, ok, detail) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  | ${detail}` : ''}`)
}

const consoleErrors = []
let dev = null
let browser
try {
  console.log(`启动 dev server（${BASE}）…`)
  dev = await startDevServer({ port: PORT, root: ROOT })

  browser = await launchChrome({
    port: CDP_PORT,
    baseUrl: BASE,
    onConsoleError: (line) => consoleErrors.push(line),
  })
  const { evaluate, open, click, clickByText, waitFor, sleep: wait } = browser
  const currentUrl = () => browser.url()
  const inAppShell = () => evaluate('!!document.querySelector("aside")')

  // 预热：vite 首次访问要现场编译整个应用，先等首页真的渲染出来，
  // 否则后面第一条断言会把"还在编译"误报成"元素不存在"。
  await open('/', 500)
  if (!(await waitFor('header nav a'))) {
    report('首页渲染（预热）', false, '等了 8 秒仍没有导航元素')
  }

  // 公开页导航：每项都应跳到对应路由
  for (const [label, selector, expected] of [
    ['公开导航 · AI 绘画', 'nav a[href="/studio"]', '/studio'],
    ['公开导航 · 作品广场', 'nav a[href="/gallery"]', '/gallery'],
    ['公开导航 · 价格与积分', 'nav a[href="/pricing"]', '/pricing'],
    ['公开导航 · 帮助中心', 'nav a[href="/help"]', '/help'],
  ]) {
    await open('/')
    await waitFor(selector, 6000)
    const state = await click(selector)
    const url = await currentUrl()
    report(label, state === 'clicked' && url === expected, `${state} -> ${url}（期望 ${expected}）`)
  }

  // 导航右侧入口要跟登录态一致：有账号体系才劝登录，纯前端（无后端）模式下
  // 把人引去登录页会撞上「本站未启用账号系统」，所以那里该是「进入创作」。
  await open('/')
  const hasAuthEntry = await evaluate('!!document.querySelector(\'header a[href="/register"]\')')
  const hasStudioEntry = await evaluate('Array.from(document.querySelectorAll("header a")).some((a) => a.innerText.includes("进入创作"))')
  report('公开导航 · 入口跟随登录态', hasAuthEntry !== hasStudioEntry, `注册入口=${hasAuthEntry} 进入创作=${hasStudioEntry}`)
  if (hasStudioEntry) {
    const state = await evaluate('(() => { const el = Array.from(document.querySelectorAll("header a")).find((a) => a.innerText.includes("进入创作")); if (!el) return "missing"; el.click(); return "clicked" })()')
    await wait(1000)
    const url = await currentUrl()
    report('公开导航 · 进入创作跳转', state === 'clicked' && url === '/studio', `${state} -> ${url}`)
  } else {
    for (const [label, selector, expected] of [
      ['公开导航 · 登录', 'header a[href="/login"]', '/login'],
      ['公开导航 · 注册', 'header a[href="/register"]', '/register'],
    ]) {
      await open('/')
      const state = await click(selector)
      const url = await currentUrl()
      report(label, state === 'clicked' && url === expected, `${state} -> ${url}（期望 ${expected}）`)
    }
  }

  // 应用侧栏：既要跳对，也要留在应用外壳里
  for (const [label, selector, expected] of [
    ['侧栏 · AI 绘画', 'aside a[href="/studio"]', '/studio'],
    ['侧栏 · 作品广场', 'aside a[href="/gallery"]', '/gallery'],
    ['侧栏 · 我的作品', 'aside a[href="/me?tab=works"]', '/me?tab=works'],
    ['侧栏 · 积分中心', 'aside a[href="/me?tab=ledger"]', '/me?tab=ledger'],
    ['侧栏 · 个人中心', 'aside a[href="/me?tab=settings"]', '/me?tab=settings'],
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

  // 个人中心不能再出现"第二列菜单"：分区入口只归左侧主导航。
  // 这是用户报过的原话——「里面怎么又内嵌一个菜单栏」。
  // 例外：「我的作品」里的 全部/收藏 页签是正文内容，不算第二列导航。
  // favorites 是旧地址别名（收藏已并入我的作品），必须仍能打开。
  for (const tab of ['works', 'favorites', 'ledger', 'settings']) {
    await open(`/me?tab=${tab}`, 2400)
    const insideMain = await evaluate(`document.querySelectorAll('main a[href^="/me?tab="]').length`)
    const inAside = await evaluate(`document.querySelectorAll('aside a[href^="/me?tab="]').length`)
    const isWorks = tab === 'works' || tab === 'favorites'
    const ok = inAside === 3 && (isWorks ? insideMain === 2 : insideMain === 0)
    report(`个人中心「${tab}」无第二列菜单`, ok, `内容区入口=${insideMain} 侧栏入口=${inAside}`)
  }

  // 我的作品内嵌「全部 / 收藏」页签（收藏带星标，不再单独设侧栏入口）
  await open('/me?tab=works', 2400)
  const favTab = await evaluate('(() => { const el = Array.from(document.querySelectorAll("main a")).find((a) => a.innerText.includes("收藏")); return el ? el.getAttribute("href") : null })()')
  report('我的作品含收藏页签', favTab === '/me?tab=works&fav=1', String(favTab))
  await open('/me?tab=works&fav=1', 2400)
  report('收藏页签可打开', (await browser.url()) === '/me?tab=works&fav=1', await browser.url())

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

  // 已下线的旧路由应回落到首页，而不是白屏
  await open('/classic', 1600)
  report('/classic 回落首页', (await currentUrl()) === '/', await currentUrl())

  // 帮助中心的文案不能介绍已经下线的功能
  await open('/help', 1800)
  const helpText = await evaluate('document.body.innerText')
  report('帮助中心无过期文案', helpText.length > 200 && !helpText.includes('智能体创作') && !helpText.includes('经典界面'), helpText.includes('智能体创作') ? '仍提到「智能体创作」' : helpText.includes('经典界面') ? '仍提到「经典界面」' : '')

  // 认证页在没有后端时必须给出说明，而不是空白页或者被静默弹回创作页
  await open('/login', 2000)
  const loginPath = await currentUrl()
  const loginText = await evaluate('document.body.innerText')
  if (loginPath === '/login' && loginText.includes('未启用账号系统')) {
    for (const path of ['/register', '/forgot']) {
      await open(path, 1800)
      const text = await evaluate('document.body.innerText')
      report(`无后端时 ${path} 给出说明`, (await currentUrl()) === path && text.includes('未启用账号系统'), await currentUrl())
    }
  } else {
    report(`认证页说明（当前落在 ${loginPath}，跳过）`, false, `期望 /login 上出现「未启用账号系统」，实际 ${loginPath}`)
  }

  // 落地页底部 CTA 也要跟登录态一致
  await open('/')
  const landingText = await evaluate('document.body.innerText')
  report('落地页底部 CTA 文案一致', landingText.includes('免费开始创作') || landingText.includes('继续创作'), '')

  report('无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '))
} catch (error) {
  failed++
  console.log(`FAIL  脚本执行  | ${error.message}`)
} finally {
  try { await browser?.close() } catch {}
  try { await dev?.stop() } catch {}
  console.log(`\n失败 ${failed} 项`)
  process.exit(failed ? 1 : 0)
}
