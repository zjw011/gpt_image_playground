// 渲染体检：逐页检查「肉眼看得见但断言不到」的问题——
// 图片加载失败、图标尺寸异常、横向溢出、控制台报错、页面是不是空壳。
//
// 关键的一条是"落点断言"：光看"页面上有内容、没有报错"是不够的——如果路由失配，
// 每一页都会被弹回首页，那些断言照样全绿（这个脚本第一版就是这样假绿的）。
// 所以每个路径都要显式声明"应该停在哪"。
//
// 用法：node scripts/audit-render.mjs（脚本自己起停 dev server）
import { launchChrome } from './lib/cdp.mjs'
import { startDevServer } from './lib/devServer.mjs'

const PORT = Number(process.env.AUDIT_DEV_PORT || 5181)
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT || 9413)

/**
 * 每一页：路径、期望停在哪（重定向要写清楚，不能用通配搪塞）、
 * 以及最少正文长度（用来判断"渲染出来了"而不是"只剩个壳"）。
 */
const PAGES = [
  { path: '/', expect: '/' },
  { path: '/studio', expect: '/studio' },
  { path: '/gallery', expect: '/gallery' },
  { path: '/me', expect: '/me' },
  { path: '/me?tab=works', expect: '/me?tab=works' },
  { path: '/me?tab=favorites', expect: '/me?tab=favorites' },
  { path: '/me?tab=ledger', expect: '/me?tab=ledger' },
  { path: '/me?tab=settings', expect: '/me?tab=settings' },
  { path: '/recharge', expect: '/recharge' },
  { path: '/result', expect: '/result' },
  { path: '/pricing', expect: '/pricing' },
  { path: '/help', expect: '/help' },
  { path: '/login', expect: '/login' },
  { path: '/register', expect: '/register' },
  { path: '/forgot', expect: '/forgot' },
  { path: '/classic', expect: '/' }, // 已下线的旧入口，应回落首页
]

let failed = 0
const report = (label, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  | ${detail}` : ''}`)
}

const consoleErrors = []
let dev = null
let browser
try {
  console.log(`启动 dev server（http://127.0.0.1:${PORT}）…`)
  dev = await startDevServer({ port: PORT })

  browser = await launchChrome({
    port: CDP_PORT,
    baseUrl: `http://127.0.0.1:${PORT}`,
    onConsoleError: (line) => consoleErrors.push(line),
  })
  const { evaluate, open, waitFor } = browser

  // 预热：vite 首次访问要现场编译整个应用。
  await open('/', 500)
  await waitFor('body')

  for (const { path, expect } of PAGES) {
    await open(path, 2000)
    if (!(await waitFor('body > *', 8000))) {
      report(`${path} 已渲染`, false, '等了 8 秒 body 还是空的')
      continue
    }

    // 0) 落点：路由失配时每页都会被弹回首页，这条是最能抓到问题的一条
    const url = await browser.url()
    report(`${path} 落在 ${expect}`, url === expect, url === expect ? '' : `实际落在 ${url}`)

    // 1) 图片真加载出来了吗。
    //    先滚到底触发 loading="lazy"：不滚的话首屏以下的图永远"没加载"，
    //    会把正常页面判成有坏图。滚完只把"确实请求过但失败了"（complete 且
    //    naturalWidth 为 0）算失败，还没被请求的懒加载图只提示不判错。
    await evaluate('window.scrollTo(0, document.body.scrollHeight)')
    await browser.sleep(900)
    await evaluate('window.scrollTo(0, 0)')
    const brokenImgs = await evaluate(`Array.from(document.images).filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.currentSrc || img.src)`)
    report(`${path} 图片均加载`, brokenImgs.length === 0, brokenImgs.slice(0, 3).join(' , '))
    const pendingImgs = await evaluate('Array.from(document.images).filter((img) => !img.complete).length')
    if (pendingImgs > 0) console.log(`INFO  ${path} 有 ${pendingImgs} 张图尚未请求（懒加载，未进视口）`)

    // 2) 图标尺寸：没有尺寸类的 svg 会退回默认的 300x150，直接毁布局
    const hugeSvg = await evaluate(`Array.from(document.querySelectorAll('svg')).filter((s) => { const r = s.getBoundingClientRect(); return r.width > 80 || r.height > 80 }).map((s) => { const r = s.getBoundingClientRect(); return (s.parentElement ? s.parentElement.className : '') + ' -> ' + Math.round(r.width) + 'x' + Math.round(r.height) })`)
    report(`${path} 图标尺寸正常`, hugeSvg.length === 0, hugeSvg.slice(0, 3).join(' , '))

    // 3) 横向溢出：比 1px 宽就说明布局破了
    const overflow = await evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    report(`${path} 无横向溢出`, overflow <= 1, `溢出 ${overflow}px`)

    // 4) 页面不该是空壳
    const textLen = await evaluate('document.body.innerText.trim().length')
    report(`${path} 有内容`, textLen > 30, `文本 ${textLen} 字`)
  }

  report('全流程无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || '))
} catch (error) {
  failed++
  console.log(`FAIL  脚本执行  | ${error.message}`)
} finally {
  try { await browser?.close() } catch {}
  try { await dev?.stop() } catch {}
  console.log(`\n失败 ${failed} 项`)
  process.exit(failed ? 1 : 0)
}
