// 自带服务的界面回归：导航落点、移动端溢出与真实截图。
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { launchChrome } from './lib/cdp.mjs'
import { startDevServer } from './lib/devServer.mjs'

const PORT = Number(process.env.AUDIT_DEV_PORT || 5183)
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT || 9415)
const output = resolve('.tmp-check/ui')
let dev
let browser
let failed = 0
const errors = []
const report = (label, ok) => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

try {
  mkdirSync(output, { recursive: true })
  dev = await startDevServer({ port: PORT })
  browser = await launchChrome({ port: CDP_PORT, baseUrl: dev.url, onConsoleError: (msg) => errors.push(msg) })
  await browser.open('/')
  await browser.waitFor('main h1')
  const tools = ['/studio', '/studio?mode=image', '/studio?mode=inpaint', '/studio?mode=outpaint', '/tools?tool=ecommerce', '/tools?tool=product-suite', '/tools?tool=live']
  for (const target of tools) {
    await browser.open('/')
    const clicked = await browser.click(`main a[href="${target}"]`)
    report(`首页工具直达 ${target}`, clicked === 'clicked' && (await browser.url()) === target)
    if (target.startsWith('/studio?mode=')) {
      const mode = target.split('=')[1]
      const labels = { image: '图生图', inpaint: '局部重绘', outpaint: 'AI 扩图' }
      report(`工作台正确选中 ${labels[mode]}`, await browser.evaluate(`Array.from(document.querySelectorAll('button[aria-pressed="true"]')).some((el) => el.innerText.includes(${JSON.stringify(labels[mode])}))`))
    }
  }
  for (const width of [1440, 390]) {
    await browser.setViewport(width, 960)
    for (const path of ['/', '/studio', '/tools', '/tools?tool=ecommerce', '/tools?tool=live', '/gallery']) {
      await browser.open(path)
      report(`${width}px ${path} 落点`, (await browser.url()) === path)
      report(`${width}px ${path} 无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'))
      if (path === '/') {
        const text = await browser.text()
        report(`${width}px 首页只展示已有功能`, !['模型广场', '会员中心', '每日签到', '1000万', '50万'].some((word) => text.includes(word)))
        if (width === 390) report('手机公开导航可见', await browser.evaluate('document.querySelector(\'nav[aria-label="移动端导航"]\').getBoundingClientRect().height > 0'))
      }
      const name = path === '/' ? 'home' : path.replace('/', '').replace('?tool=', '-')
      writeFileSync(resolve(output, `${name}-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'))
    }
  }
  report('无控制台报错', errors.length === 0)
  console.log(`截图保存在 ${output}`)
} catch (err) {
  failed++
  console.error(err)
} finally {
  await browser?.close()
  await dev?.stop()
  console.log(`失败 ${failed} 项`)
  process.exitCode = failed ? 1 : 0
}
