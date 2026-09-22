// 菜单跳转审计：用本机 Chrome 的 DevTools 协议真实点一遍所有导航入口，报告失败项。
// 起因是 vite 的 base 是 './'，react-router 的 basename 一旦拿到相对路径就会整表失配——
// 表现是「页面能看，但点哪儿都没反应」。这类问题靠肉眼 review 很容易漏，交给脚本点。
//
// 用法：先 npm run dev，另开终端执行
//   node scripts/audit-menu.mjs
// 需要本机装有 Chrome（路径可用 CHROME_PATH 覆盖）。退出码非 0 表示有失败项。
import { launchChrome } from './lib/cdp.mjs'

const BASE = process.env.AUDIT_BASE_URL || 'http://localhost:5173'
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT || 9411)

let failed = 0
function report(label, ok, detail) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  | ${detail}` : ''}`)
}

const consoleErrors = []
let browser
try {
  browser = await launchChrome({
    port: CDP_PORT,
    baseUrl: BASE,
    onConsoleError: (line) => consoleErrors.push(line),
  })
  const { evaluate, open, click, clickByText, sleep } = browser
  const currentUrl = () => browser.url()
  const inAppShell = () => evaluate('!!document.querySelector("aside")')

  // 公开页导航：每项都应跳到对应路由
  for (const [label, selector, expected] of [
    ['公开导航 · AI 绘画', 'nav a[href="/studio"]', '/studio'],
    ['公开导航 · 作品广场', 'nav a[href="/gallery"]', '/gallery'],
    ['公开导航 · 价格与积分', 'nav a[href="/pricing"]', '/pricing'],
    ['公开导航 · 帮助中心', 'nav a[href="/help"]', '/help'],
  ]) {
    await open('/')
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
    await sleep(1000)
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
    report(`认证页说明（当前非纯前端模式，落在 ${loginPath}，跳过）`, true)
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
  console.log(`\n失败 ${failed} 项`)
  process.exit(failed ? 1 : 0)
}
