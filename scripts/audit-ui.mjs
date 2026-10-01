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
  await browser.waitFor('h1')
  const tools = ['/studio', '/studio?mode=image', '/studio?mode=inpaint', '/studio?mode=outpaint', '/tools?tool=ecommerce', '/tools?tool=product-suite', '/tools?tool=live']
  for (const target of tools) {
    await browser.open('/')
    const clicked = await browser.click(`section[aria-label="创作工具"] a[href="${target}"]`)
    report(`首页工具直达 ${target}`, clicked === 'clicked' && (await browser.url()) === target)
    if (target.startsWith('/studio?mode=')) {
      const mode = target.split('=')[1]
      const labels = { image: '图生图', inpaint: '局部重绘', outpaint: 'AI 扩图' }
      report(`工作台正确选中 ${labels[mode]}`, await browser.evaluate(`Array.from(document.querySelectorAll('button[aria-pressed="true"]')).some((el) => el.innerText.includes(${JSON.stringify(labels[mode])}))`))
    }
  }
  await browser.open('/studio')
  for (const [ratio, size] of [['3:4', '768x1024'], ['9:16', '720x1280'], ['16:9', '1280x720']]) {
    await browser.clickByText(ratio)
    const actual = await browser.evaluate('(async () => (await import("/src/store.ts")).useStore.getState().params.size)()')
    report(`${ratio} 提交尺寸及选中状态正确`, actual === size && await browser.evaluate(`Array.from(document.querySelectorAll('button[aria-pressed="true"]')).some((el) => el.innerText === ${JSON.stringify(ratio)})`))
  }
  const widths = process.env.AUDIT_UI_WIDTHS ? process.env.AUDIT_UI_WIDTHS.split(',').map(Number) : [1920, 1440, 768, 430, 390, 375, 320]
  for (const width of widths) {
    await browser.setViewport(width, 960)
    for (const path of ['/', '/studio', '/studio?mode=inpaint', '/studio?mode=outpaint', '/tools', '/tools?tool=ecommerce', '/tools?tool=product-suite', '/tools?tool=live', '/gallery', '/me?tab=works', '/me?tab=settings', '/me?tab=ledger', '/recharge']) {
      await browser.open(path)
      report(`${width}px ${path} 落点`, (await browser.url()) === path)
      report(`${width}px ${path} 无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'))
      if (path === '/') {
        const text = await browser.text()
        report(`${width}px 首页只展示已有功能`, !['模型广场', '会员中心', '每日签到', '1000万', '50万'].some((word) => text.includes(word)))
        if (width === 390) report('手机公开导航可见', await browser.evaluate('document.querySelector(\'nav[aria-label="移动端导航"]\').getBoundingClientRect().height > 0'))
      }
      if (width < 768) {
        report(`${width}px ${path} 底部导航可见`, await browser.evaluate('document.querySelector(\'nav[aria-label="手机底部导航"]\').getBoundingClientRect().height >= 60'))
        if (path === '/studio') {
          await browser.click('button[aria-label="打开手机菜单"]')
          report(`${width}px 手机菜单展开`, await browser.evaluate('document.querySelector(\'dialog[aria-label="手机菜单"]\').open'))
          await browser.click('nav[aria-label="手机完整导航"] a[href="/gallery"]')
          report(`${width}px 手机菜单跳转并关闭`, (await browser.url()) === '/gallery' && await browser.evaluate('!document.querySelector(\'dialog[aria-label="手机菜单"]\').open'))
          await browser.click('nav[aria-label="手机底部导航"] a[href="/me?tab=settings"]')
          report(`${width}px 底部我的落点`, (await browser.url()) === '/me?tab=settings')
          await browser.open(path)
        }
      }
      const name = path === '/' ? 'home' : path.slice(1).replace(/[?=&]/g, '-')
      writeFileSync(resolve(output, `${name}-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'))
      if (path === '/gallery') {
        await browser.click('main article button')
        report(`${width}px 帖子打开并锁定背景`, await browser.evaluate('!!document.querySelector(\'[role="dialog"][aria-label="作品帖子"]\') && document.body.style.overflow === "hidden"'))
        report(`${width}px 帖子无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'))
        await browser.evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))')
        report(`${width}px Esc 关闭帖子恢复滚动`, await browser.evaluate('!document.querySelector(\'[aria-label="作品帖子"]\') && document.body.style.overflow !== "hidden"'))
      }
    }
  }
  // 隔离的 Chrome 临时资料中构造结果，不能用空结果页代替真实结果布局检查。
  await browser.open('/studio')
  await browser.evaluate(`(async () => {
    const { useStore } = await import('/src/store.ts')
    const { putImage, putTask } = await import('/src/lib/db.ts')
    const canvas = document.createElement('canvas')
    canvas.width = 1600
    canvas.height = 900
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#c9b7f5'
    ctx.fillRect(0, 0, 1600, 900)
    await putImage({ id: 'audit-mobile-image', dataUrl: canvas.toDataURL(), source: 'generated' })
    const task = { id: 'audit-mobile-result', prompt: '手机结果布局验证'.repeat(40), params: useStore.getState().params, inputImageIds: [], outputImages: ['audit-mobile-image'], status: 'done', error: null, createdAt: Date.now(), finishedAt: Date.now(), elapsed: 1000 }
    await putTask(task)
    useStore.setState({ tasks: [task] })
  })()`)
  await browser.open('/result?task=audit-mobile-result')
  for (const width of [430, 390, 375, 320]) {
    await browser.setViewport(width, 780)
    await browser.sleep(200)
    report(`${width}px 真实图片结果页落点`, (await browser.url()) === '/result?task=audit-mobile-result')
    report(`${width}px 图片及操作栏无溢出`, await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'))
    report(`${width}px 结果操作在图片下方`, await browser.evaluate(`(() => { const btn = Array.from(document.querySelectorAll('main button')).find((el) => el.innerText === '收藏'); const img = document.querySelector('main img'); return !!btn && !!img && btn.getBoundingClientRect().top >= img.getBoundingClientRect().bottom })()`))
    writeFileSync(resolve(output, `result-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'))
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
