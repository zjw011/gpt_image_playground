// 蝴蝶任务浮层专项：自带服务、隔离浏览器，只注入本地任务，不调用绘图或积分接口。
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { launchChrome } from './lib/cdp.mjs'
import { startDevServer } from './lib/devServer.mjs'

const SCREENSHOT_DIR = resolve(import.meta.dirname, '../.tmp-check/task-progress')
let dev
let browser
let mediaSocket
let checked = 0
let failed = 0
const errors = []
const report = (label, ok, detail) => {
  checked++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` | ${detail}` : ''}`)
  if (!ok) failed++
}

async function waitFor(expression) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await browser.evaluate(expression)) return
    await browser.sleep(100)
  }
  throw new Error(`等待条件超时：${expression}`)
}

async function navigate(path) {
  await browser.evaluate(`(async () => { const { router } = await import('/src/router.tsx'); await router.navigate(${JSON.stringify(path)}) })()`)
  report(`页面精确落点 ${path}`, await browser.url() === path)
}

async function screenshot(name) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const path = join(SCREENSHOT_DIR, name)
  writeFileSync(path, Buffer.from(await browser.screenshot(), 'base64'))
  console.log(`截图 ${path}`)
}

try {
  dev = await startDevServer({ port: 5194 })
  browser = await launchChrome({ port: 9434, baseUrl: dev.url, onConsoleError: (line) => errors.push(line) })
  await browser.setViewport(1440, 1000)
  await browser.open('/studio')
  if (!await browser.waitFor('textarea', 15000)) throw new Error('创作页未就绪')
  report('初始创作页精确路由', await browser.url() === '/studio')
  report('无任务时不显示浮层', await browser.evaluate('!document.querySelector(\'[aria-label="生成任务进度"]\')'))

  await browser.evaluate(`(async () => {
    const originalFetch = window.fetch
    window.progressAuditCalls = []
    window.fetch = function (input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
      if (url.hostname === 'v1.hitokoto.cn' && method === 'GET') return Promise.resolve(new Response(JSON.stringify({ hitokoto: '想象力是画笔，耐心是颜料。', from: '本地审计' }), { headers: { 'Content-Type': 'application/json' } }))
      if (url.pathname.startsWith('/api/') || (url.protocol.startsWith('http') && url.origin !== location.origin)) {
        window.progressAuditCalls.push(url.href)
        return Promise.reject(new Error('蝴蝶专项禁止实际业务请求'))
      }
      return originalFetch.call(this, input, init)
    }
    const { useStore } = await import('/src/store.ts')
    const { DEFAULT_PARAMS } = await import('/src/types.ts')
    const { storeImage } = await import('/src/lib/db.ts')
    const { blobToDataUrl } = await import('/src/lib/dataUrl.ts')
    const images = []
    for (const name of ['work-sakura', 'work-seaside', 'work-hanfu', 'work-cat']) {
      const blob = await (await fetch('/art/' + name + '.jpg')).blob()
      images.push(await storeImage(await blobToDataUrl(blob), 'generated'))
    }
    const base = { prompt: '蝴蝶任务专项', params: { ...DEFAULT_PARAMS }, inputImageIds: [], outputImages: [], status: 'running', error: null, createdAt: Date.now(), finishedAt: null, elapsed: null }
    const history = images.map((image, idx) => ({ ...base, id: 'butterfly-history-' + idx, prompt: '已经完成的作品', createdAt: Date.now() - 300000 - idx * 1000, status: 'done', outputImages: [image], finishedAt: Date.now() - 240000, elapsed: 60000 }))
    history.push({ ...base, id: 'butterfly-old-error', status: 'error', error: '历史失败', createdAt: Date.now() - 300000, finishedAt: Date.now() - 240000, elapsed: 60000 })
    window.progressAuditHistory = history
    window.progressAuditImages = images
    window.progressAuditActive = [
      { ...base, id: 'butterfly-first', prompt: '春日京都，樱花与旧街道', createdAt: Date.now() - 64000 },
      { ...base, id: 'butterfly-second', prompt: '晨光穿过海边的窗，温柔的蓝色', createdAt: Date.now() - 9000 },
      { ...base, id: 'butterfly-live', prompt: '微风中的花瓣，轻柔运镜', liveFrameCount: 6, liveFramesCompleted: 2, createdAt: Date.now() - 32000 },
    ]
    useStore.getState().setTasks(history)
  })()`)
  report('历史已完成和失败任务不会刷出通知', await browser.evaluate('!document.querySelector(\'[aria-label="生成任务进度"]\')'))
  await browser.evaluate(`(async () => { const { useStore } = await import('/src/store.ts'); useStore.getState().setTasks([...window.progressAuditActive, ...window.progressAuditHistory]) })()`)
  await waitFor('document.querySelectorAll(\'[aria-label="生成任务进度"] a[data-task-id]\').length === 3')
  report('一条运行任务对应一只蝴蝶，不混入历史作品', await browser.evaluate(`Array.from(document.querySelectorAll('[aria-label="生成任务进度"] a[data-task-id]')).every((el) => window.progressAuditActive.some((task) => task.id === el.dataset.taskId))`))
  report('复用品牌透明底蝴蝶素材且图片可解码', await browser.evaluate(`(async () => { const imgs = Array.from(document.querySelectorAll('[aria-label="生成任务进度"] a[data-task-id] img')); await Promise.all(imgs.map((img) => img.decode())); return imgs.length === 3 && imgs.every((img) => img.src.includes('/brand/logo-mark.png') && img.naturalWidth > 0) })()`))
  report('计时位于蝴蝶上方，按钮尺寸可触控', await browser.evaluate(`Array.from(document.querySelectorAll('[aria-label="生成任务进度"] a[data-task-id]')).every((el) => { const timer = el.querySelector('[role="timer"]').getBoundingClientRect(); const image = el.querySelector('img').getBoundingClientRect(); const rect = el.getBoundingClientRect(); return timer.bottom <= image.top + 1 && rect.width >= 44 && rect.height >= 44 })`))
  report('连续帧显示实际完成数量', await browser.evaluate('document.querySelector(\'a[data-task-id="butterfly-live"]\').textContent.includes("2/6 帧")'))
  report('等待计时与任务创建时间一致，不显示虚构百分比', await browser.evaluate(`(() => { const el = document.querySelector('a[data-task-id="butterfly-first"]'); const parts = el.querySelector('[role="timer"]').textContent.split(':').map(Number); const seconds = parts[0] * 60 + parts[1]; return Math.abs(seconds - (Date.now() - window.progressAuditActive[0].createdAt) / 1000) < 2 && !document.querySelector('[aria-label="生成任务进度"]').textContent.includes('%') })()`))
  await browser.evaluate('void (window.progressAuditDock = document.querySelector(\'[aria-label="生成任务进度"]\'))')
  await navigate('/tools')
  await navigate('/me?tab=works')
  report('应用页切换保持同一个浮层实例', await browser.evaluate('window.progressAuditDock === document.querySelector(\'[aria-label="生成任务进度"]\')'))
  await browser.sleep(1200)
  report('切页后计时继续按原开始时间增长', await browser.evaluate(`(() => { const parts = document.querySelector('a[data-task-id="butterfly-first"] [role="timer"]').textContent.split(':').map(Number); return Math.abs(parts[0] * 60 + parts[1] - (Date.now() - window.progressAuditActive[0].createdAt) / 1000) < 2 })()`))

  for (const width of [1920, 1440]) {
    await browser.setViewport(width, 1000)
    report(`桌面 ${width}px 浮层与页面无横向溢出`, await browser.evaluate(`(() => { const rect = document.querySelector('[aria-label="生成任务进度"]').getBoundingClientRect(); return document.documentElement.scrollWidth <= innerWidth + 1 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom < innerHeight })()`))
    report(`桌面 ${width}px 正文给右侧浮层留出空间`, await browser.evaluate(`(() => { const main = document.querySelector('main'); const right = Math.max(...Array.from(main.children).map((el) => el.getBoundingClientRect().right)); const dock = document.querySelector('[aria-label="生成任务进度"]').getBoundingClientRect(); return right <= dock.left + 1 })()`))
    await screenshot(`desktop-${width}.png`)
  }

  report('点击运行蝴蝶进入对应结果', await browser.click('a[data-task-id="butterfly-second"]') === 'clicked')
  report('运行任务结果精确路由', await browser.url() === '/result?task=butterfly-second')
  report('当前任务蝴蝶有选中状态', await browser.evaluate('document.querySelector(\'a[data-task-id="butterfly-second"]\').getAttribute("aria-current") === "page"'))
  await browser.click('button[aria-label="收起任务进度"]')
  report('收起仍显示计时和任务数', await browser.evaluate(`(() => { const dock = document.querySelector('[aria-label="生成任务进度"]'); return dock.dataset.expanded === 'false' && !!dock.querySelector('[role="timer"]') && dock.querySelector('.task-progress-count').textContent === '3' })()`))
  report('收起未取消任何任务', await browser.evaluate(`(async () => { const { useStore } = await import('/src/store.ts'); return useStore.getState().tasks.filter((task) => task.status === 'running').length === 3 })()`))
  await navigate('/me?tab=works')
  for (const width of [390, 320]) {
    await browser.setViewport(width, 844)
    await waitFor('document.querySelector(\'[aria-label="生成任务进度"]\').dataset.expanded === "false"')
    report(`手机 ${width}px 折叠浮层不挡底部导航`, await browser.evaluate(`(() => { const dock = document.querySelector('[aria-label="生成任务进度"]').getBoundingClientRect(); const nav = document.querySelector('[aria-label="手机底部导航"]').getBoundingClientRect(); return dock.bottom <= nav.top && dock.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth + 1 })()`))
    await screenshot(`mobile-${width}-compact.png`)
    await browser.click('button[aria-label="展开任务进度"]')
    report(`手机 ${width}px 展开后保留全部任务入口`, await browser.evaluate('document.querySelectorAll(\'[aria-label="生成任务进度"] a[data-task-id]\').length === 3'))
    report(`手机 ${width}px 展开浮层不挡底部导航或溢出`, await browser.evaluate(`(() => { const dock = document.querySelector('[aria-label="生成任务进度"]').getBoundingClientRect(); const nav = document.querySelector('[aria-label="手机底部导航"]').getBoundingClientRect(); return dock.bottom <= nav.top && dock.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth + 1 })()`))
    await screenshot(`mobile-${width}-expanded.png`)
    await browser.click('button[aria-label="收起任务进度"]')
  }
  for (const [width, height] of [[320, 430], [320, 300], [667, 375]]) {
    await browser.setViewport(width, height)
    await browser.click('button[aria-label="展开任务进度"]')
    report(`手机短屏 ${width}×${height} 列表可滚动且避开底部导航`, await browser.evaluate(`(() => { const dock = document.querySelector('[aria-label="生成任务进度"]').getBoundingClientRect(); const nav = document.querySelector('[aria-label="手机底部导航"]').getBoundingClientRect(); const list = document.querySelector('[data-task-list]'); return dock.bottom <= nav.top && list.scrollHeight > list.clientHeight && document.documentElement.scrollWidth <= innerWidth + 1 })()`))
    await screenshot(`mobile-${width}x${height}.png`)
    await browser.click('button[aria-label="收起任务进度"]')
  }

  await browser.setViewport(1440, 900)
  await waitFor('document.querySelector(\'[aria-label="生成任务进度"]\').dataset.expanded === "true"')
  await browser.evaluate(`(async () => { const { useStore } = await import('/src/store.ts'); const more = Array.from({ length: 10 }, (_, idx) => ({ ...window.progressAuditActive[0], id: 'butterfly-extra-' + idx, createdAt: Date.now() + idx })); useStore.getState().setTasks([...window.progressAuditActive, ...more, ...window.progressAuditHistory]) })()`)
  await waitFor('document.querySelectorAll(\'[aria-label="生成任务进度"] a[data-task-id]\').length === 13')
  report('大量任务内部滚动，所有任务均可到达', await browser.evaluate(`(() => { const list = document.querySelector('[data-task-list]'); list.scrollTop = list.scrollHeight; const last = list.lastElementChild.getBoundingClientRect(); const rect = list.getBoundingClientRect(); return list.scrollHeight > list.clientHeight && list.scrollTop > 0 && last.bottom <= rect.bottom + 1 && last.top >= rect.top })()`))
  await screenshot('desktop-many-tasks.png')

  // 直接使用 CDP 的媒体模拟验证实际动画，避免仅检查 CSS 文本。
  const targets = await (await fetch('http://127.0.0.1:9434/json/list')).json()
  const target = targets.find((item) => item.url.startsWith(dev.url))
  mediaSocket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { mediaSocket.onopen = resolve; mediaSocket.onerror = reject })
  const response = new Promise((resolve, reject) => {
    mediaSocket.onmessage = (event) => {
      const value = JSON.parse(event.data)
      if (value.id !== 1) return
      value.error ? reject(new Error(JSON.stringify(value.error))) : resolve()
    }
  })
  mediaSocket.send(JSON.stringify({ id: 1, method: 'Emulation.setEmulatedMedia', params: { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] } }))
  await response
  report('减少动态效果时蝴蝶与星光停止动画', await browser.evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches && Array.from(document.querySelectorAll('.task-progress-wings, .task-progress-spark')).every((el) => getComputedStyle(el).animationName === 'none')`))

  await browser.evaluate(`(async () => { const { useStore } = await import('/src/store.ts'); useStore.getState().setTasks([...window.progressAuditActive, ...window.progressAuditHistory]) })()`)
  await waitFor('document.querySelectorAll(\'[aria-label="生成任务进度"] a[data-task-id]\').length === 3')
  report('删除运行任务后相应蝴蝶同步消失', await browser.evaluate('!document.querySelector(\'a[data-task-id^="butterfly-extra-"]\')'))
  await browser.evaluate(`(async () => { const { useStore } = await import('/src/store.ts'); useStore.getState().setTasks([
    { ...window.progressAuditActive[0], status: 'done', outputImages: [window.progressAuditImages[0]], finishedAt: Date.now(), elapsed: 70000 },
    { ...window.progressAuditActive[1], status: 'error', error: '内容安全审核未通过', finishedAt: Date.now(), elapsed: 18000 },
    { ...window.progressAuditActive[2], status: 'done', outputImages: [window.progressAuditImages[1]], outputErrors: [{ requestIndex: 1, error: '上游取消' }], finishedAt: Date.now(), elapsed: 40000 },
    ...window.progressAuditHistory,
  ]) })()`)
  await waitFor('document.querySelector(\'a[data-task-id="butterfly-first"]\')?.dataset.state === "done"')
  report('结束状态分别显示完成、失败和部分完成', await browser.evaluate(`document.querySelector('a[data-task-id="butterfly-first"]').textContent.includes('已完成') && document.querySelector('a[data-task-id="butterfly-second"]').dataset.state === 'error' && document.querySelector('a[data-task-id="butterfly-live"]').textContent.includes('部分完成')`))
  report('结束计时采用最终耗时并停止增长', await browser.evaluate('document.querySelector(\'a[data-task-id="butterfly-first"] [role="timer"]\').textContent === "1:10"'))
  await screenshot('desktop-completed.png')
  await browser.click('a[data-task-id="butterfly-first"]')
  report('点击已完成任务查看精确结果并收起该通知', await browser.url() === '/result?task=butterfly-first' && await browser.evaluate('!document.querySelector(\'a[data-task-id="butterfly-first"]\')'))
  await browser.evaluate(`(() => { window.progressAuditDateNow = Date.now; Date.now = () => window.progressAuditDateNow() + 21000; document.dispatchEvent(new Event('visibilitychange')) })()`)
  await waitFor('!document.querySelector(\'[aria-label="生成任务进度"]\')')
  report('结束通知到期隐藏，原任务和图片保留', await browser.evaluate(`(async () => { const { useStore } = await import('/src/store.ts'); return useStore.getState().tasks.some((task) => task.id === 'butterfly-live' && task.outputImages.length === 1) && useStore.getState().tasks.some((task) => task.id === 'butterfly-second' && task.status === 'error') })()`))
  await browser.evaluate('Date.now = window.progressAuditDateNow')
  report('无任务浮层时恢复正文空间', await browser.evaluate('document.querySelector(".task-progress-layout").dataset.dockActive === "false"'))
  const calls = await browser.evaluate('window.progressAuditCalls')
  report('全流程没有绘图、积分或其他业务接口请求', calls.length === 0, JSON.stringify(calls))
  report('无控制台错误', errors.length === 0)
  if (errors.length) console.log(errors)
  console.log(`蝴蝶任务专项结束：${checked} 项检查，${failed} 项失败。截图保存在 ${SCREENSHOT_DIR}；仅本地模拟任务，手机视口不等同于真机验收。`)
} catch (err) {
  failed++
  console.error(err)
} finally {
  try { mediaSocket?.close() } catch {}
  await browser?.close()
  await dev?.stop()
}
process.exitCode = failed ? 1 : 0
