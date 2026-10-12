// 剪贴板事件回归：自带服务、隔离浏览器，仅使用本地素材，不调用绘图接口。
import { launchChrome } from './lib/cdp.mjs'
import { startDevServer } from './lib/devServer.mjs'

let dev
let browser
let failed = 0
const errors = []
const report = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failed++
}
try {
  dev = await startDevServer({ port: 5188 })
  browser = await launchChrome({ port: 9428, baseUrl: dev.url, onConsoleError: (line) => errors.push(line) })
  const pages = [
    ['/studio', 'textarea', null],
    ['/tools?tool=ecommerce', 'section button[aria-label="上传商品图片"]', '商品原图'],
    ['/tools?tool=product-suite', 'section button[aria-label="上传商品图片"]', '商品原图'],
    ['/tools?tool=live&liveMode=ai', '.professional-editor button', 'Live 参考图'],
    ['/tools?tool=live', '#quick-motion-upload', null],
    ['/tools?tool=try-on', '[aria-label="人物图粘贴区域"]', '人物参考图'],
  ]
  for (const [path, selector, alt] of pages) {
    await browser.open(path)
    if (!await browser.waitFor(selector, 15000)) throw new Error(`未找到 ${path} ${selector}`)
    report(`${path} 路由`, await browser.url() === path)
    const accepted = await browser.evaluate(`(async () => {
      const blob = await (await fetch('/art/work-cat.jpg')).blob()
      const transfer = new DataTransfer()
      transfer.items.add(new File([blob], 'paste.jpg', { type: blob.type }))
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
      document.querySelector(${JSON.stringify(selector)}).dispatchEvent(event)
      return event.defaultPrevented
    })()`)
    report(`${path} 图片事件被接收`, accepted)
    await browser.sleep(500)
    report(`${path} 图片成功解码`, await browser.evaluate(alt
      ? `(() => { const img = document.querySelector('img[alt=${JSON.stringify(alt)}]'); return !!img?.complete && img.naturalWidth > 0 })()`
      : `!!document.querySelector(${JSON.stringify(path === '/studio' ? 'button[title="移除"]' : 'canvas')})`))
    if (path.includes('try-on')) {
      report('人物粘贴不会覆盖商品', !await browser.evaluate('!!document.querySelector("img[alt=商品参考图]")'))
      await browser.evaluate(`(async () => {
        const blob = await (await fetch('/art/cover-commerce-v2.jpg')).blob()
        const transfer = new DataTransfer()
        transfer.items.add(new File([blob], 'product.jpg', { type: blob.type }))
        document.querySelector('[aria-label="商品图粘贴区域"]').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
      })()`)
      await browser.sleep(500)
      report('商品粘贴后保留双图', await browser.evaluate('!!document.querySelector("img[alt=人物参考图]") && !!document.querySelector("img[alt=商品参考图]")'))
    }
    report(`${path} 文字粘贴不拦截`, await browser.evaluate(`(() => {
      const target = document.querySelector('textarea') || document.querySelector(${JSON.stringify(selector)})
      if (!target) return false
      const transfer = new DataTransfer()
      transfer.setData('text/plain', '普通描述 https://example.com/image.jpg')
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
      target.dispatchEvent(event)
      return !event.defaultPrevented
    })()`))
    for (const width of [1440, 390, 320]) {
      await browser.setViewport(width, 900)
      report(`${path} ${width}px 无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
      report(`${path} ${width}px 粘贴按钮可用`, await browser.evaluate(`Array.from(document.querySelectorAll('button')).some((button) => button.textContent.includes('粘贴') && button.getBoundingClientRect().height >= 44)`))
    }
  }
  report('无控制台错误', errors.length === 0)
  if (errors.length) console.log(errors)
  console.log(`剪贴板专项结束：${failed} 项失败。事件由浏览器 DataTransfer 构造，不等同于所有系统剪贴板/手机真机验收。`)
} catch (err) {
  failed++
  console.error(err)
} finally {
  await browser?.close()
  await dev?.stop()
}
process.exitCode = failed ? 1 : 0
