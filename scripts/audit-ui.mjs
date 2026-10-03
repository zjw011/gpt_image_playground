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

const waitUntil = async (expression, timeout = 10000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await browser.evaluate(expression)) return true
    await browser.sleep(100)
  }
  return false
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
    for (const path of ['/', '/studio', '/studio?mode=inpaint', '/studio?mode=outpaint', '/tools', '/tools?tool=ecommerce', '/tools?tool=product-suite', '/tools?tool=live', '/tools?tool=live&liveMode=ai', '/tools?tool=try-on', '/gallery', '/me?tab=works', '/me?tab=settings', '/me?tab=ledger', '/recharge']) {
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
  // 独立临时 Chrome 的本地 DB：失败（含部分输出）只能进失败筛选，不混入收藏。
  await browser.open('/me?tab=works')
  await browser.waitFor('nav[aria-label="作品筛选"]')
  await browser.evaluate(`(async () => {
    const { useStore } = await import('/src/store.ts')
    const { DEFAULT_PARAMS } = await import('/src/types.ts')
    const { putImage, putTask, deleteTask } = await import('/src/lib/db.ts')
    const canvas = document.createElement('canvas')
    canvas.width = 600
    canvas.height = 800
    canvas.getContext('2d').fillStyle = '#c9b7f5'
    canvas.getContext('2d').fillRect(0, 0, 600, 800)
    await putImage({ id: 'audit-works-image', dataUrl: canvas.toDataURL(), source: 'generated' })
    const common = { params: DEFAULT_PARAMS, inputImageIds: [], outputImages: ['audit-works-image'], error: null, createdAt: Date.now(), finishedAt: Date.now(), elapsed: 1000 }
    const tasks = [
      { ...common, id: 'audit-works-done-fav', prompt: '正常完成且已收藏', status: 'done', isFavorite: true },
      { ...common, id: 'audit-works-done', prompt: '正常完成未收藏', status: 'done' },
      { ...common, id: 'audit-works-running', prompt: '生成中占位仍在全部与收藏'.repeat(8), status: 'running', finishedAt: null, outputImages: [], isFavorite: true },
      { ...common, id: 'audit-works-error-empty', prompt: '失败无输出但曾收藏', status: 'error', error: '本地审计错误，不调用生成接口', outputImages: [], isFavorite: true },
      { ...common, id: 'audit-works-error-partial', prompt: '部分输出失败但曾收藏', status: 'error', error: '本地审计错误，已保留部分结果', isFavorite: true },
      { ...common, id: 'audit-works-done-empty', prompt: '旧完成记录无输出，不应显示', status: 'done', outputImages: [], isFavorite: true },
    ]
    await deleteTask('audit-mobile-result')
    // running 仅放内存，避免刷新将模拟中断任务自动转为失败，污染筛选断言。
    for (const task of tasks.filter((task) => task.status !== 'running')) await putTask(task)
    useStore.setState({ tasks })
  })()`)
  const expectedIds = {
    all: ['audit-works-done-fav', 'audit-works-done', 'audit-works-running'],
    fav: ['audit-works-done-fav', 'audit-works-running'],
    failed: ['audit-works-error-empty', 'audit-works-error-partial'],
  }
  const filterPaths = { all: '/me?tab=works', fav: '/me?tab=works&fav=1', failed: '/me?tab=works&filter=failed' }
  report('混合任务三个页签顺序与数量一致', await waitUntil(`(() => { const links = Array.from(document.querySelectorAll('nav[aria-label="作品筛选"] a')); return JSON.stringify(links.map((link) => link.innerText.trim())) === JSON.stringify(['全部 3', '收藏 2', '失败 2']) })()`))
  for (const width of [1440, 390, 320]) {
    await browser.setViewport(width, 900)
    for (const filter of ['all', 'fav', 'failed']) {
      const path = filterPaths[filter]
      const clicked = await browser.click(`nav[aria-label="作品筛选"] a[href="${path}"]`, 150)
      report(`${width}px ${filter} 切换精确路由与选中状态`, clicked === 'clicked' && await browser.url() === path && await browser.evaluate(`document.querySelector('nav[aria-label="作品筛选"] a[aria-current="page"]')?.getAttribute('href') === ${JSON.stringify(path)}`))
      report(`${width}px ${filter} 严格只显示对应任务`, await browser.evaluate(`(() => { const ids = Array.from(document.querySelectorAll('main a[href^="/result?task="]')).map((link) => new URLSearchParams(link.getAttribute('href').split('?')[1]).get('task')).sort(); return JSON.stringify(ids) === ${JSON.stringify(JSON.stringify([...expectedIds[filter]].sort()))} })()`))
      if (filter !== 'failed') report(`${width}px ${filter} 仍保留生成中占位`, await browser.evaluate('document.querySelector(\'main a[href="/result?task=audit-works-running"]\')?.innerText.includes("生成中") && document.querySelector(\'main a[href="/result?task=audit-works-running"]\')?.innerText.includes("已等待")'))
      report(`${width}px ${filter} 无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'))
      await browser.evaluate('document.querySelector(\'nav[aria-label="作品筛选"]\').scrollIntoView({ block: "center" })')
      report(`${width}px ${filter} 三个筛选触控区域可用`, await browser.evaluate('Array.from(document.querySelectorAll(\'nav[aria-label="作品筛选"] a\')).every((link) => { const rect = link.getBoundingClientRect(); return rect.height >= 44 && rect.width >= 44 && rect.left >= 0 && rect.right <= innerWidth })'))
      writeFileSync(resolve(output, `works-${filter}-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'))
    }
  }
  for (const [id, partial] of [['audit-works-error-empty', false], ['audit-works-error-partial', true]]) {
    const result = `/result?task=${id}`
    await browser.click(`main a[href="${result}"]`, 200)
    report(`${id} 失败卡片可进入正确结果页`, await browser.url() === result)
    report(`${id} 保留失败详情${partial ? '与部分输出' : ''}`, await waitUntil(partial
      ? 'document.querySelector("main").innerText.includes("已保留") && Array.from(document.querySelectorAll("main img")).some((image) => image.complete && image.naturalWidth > 0)'
      : 'document.querySelector("main").innerText.includes("这次没有生成成功")'))
    if (partial) {
      report('部分失败的错误详情默认折叠', await browser.evaluate('document.querySelector("main details")?.open === false'))
      await browser.click('main details summary', 150)
      report('部分失败仍可展开原错误信息', await browser.evaluate('document.querySelector("main details")?.open === true && document.querySelector("main").innerText.includes("本地审计错误，已保留部分结果")'))
      await browser.click('main details summary', 150)
      for (const width of [1440, 390, 320]) {
        await browser.setViewport(width, 900)
        report(`${width}px 部分失败结果保持失败状态与正确路径`, await browser.url() === result && await browser.evaluate('(async () => (await import("/src/store.ts")).useStore.getState().tasks.find((task) => task.id === "audit-works-error-partial")?.status === "error")()'))
        report(`${width}px 部分失败图片与详情无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'))
        writeFileSync(resolve(output, `works-failed-partial-result-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'))
      }
    }
    await browser.open(filterPaths.failed)
    report('硬刷新保留失败筛选和两条失败记录', await browser.url() === filterPaths.failed && await waitUntil('document.querySelector(\'nav[aria-label="作品筛选"] a[aria-current="page"]\')?.getAttribute("href") === "/me?tab=works&filter=failed" && document.querySelectorAll(\'main a[href^="/result?task="]\').length === 2'))
  }
  for (const path of ['/me?tab=favorites', '/me?tab=works&fav=1', '/me?tab=favorites&fav=1&filter=failed', '/me?tab=works&fav=1&filter=failed']) {
    await browser.open(path)
    const isFailed = path.includes('filter=failed')
    const ids = isFailed ? expectedIds.failed : ['audit-works-done-fav']
    report(`混合任务旧地址兼容 ${path}`, await browser.url() === path && await waitUntil(`(() => { const links = Array.from(document.querySelectorAll('main a[href^="/result?task="]')); const actual = links.map((link) => new URLSearchParams(link.getAttribute('href').split('?')[1]).get('task')).sort(); return JSON.stringify(actual) === ${JSON.stringify(JSON.stringify([...ids].sort()))} && document.querySelector('nav[aria-label="作品筛选"] a[aria-current="page"]')?.getAttribute('href') === ${JSON.stringify(isFailed ? filterPaths.failed : filterPaths.fav)} })()`))
  }
  await browser.open(filterPaths.failed)
  await browser.evaluate(`(async () => {
    const { useStore } = await import('/src/store.ts')
    const { deleteTask } = await import('/src/lib/db.ts')
    for (const id of ['audit-works-error-empty', 'audit-works-error-partial']) await deleteTask(id)
    useStore.setState((state) => ({ tasks: state.tasks.filter((task) => task.status !== 'error') }))
  })()`)
  for (const width of [1440, 390, 320]) {
    await browser.setViewport(width, 900)
    report(`${width}px 失败空态没有生成 CTA`, await browser.url() === filterPaths.failed && await browser.evaluate('document.querySelector("main").innerText.includes("暂无失败记录") && !document.querySelector(\'main a[href="/studio"]\') && !document.querySelector(\'main a[href^="/result?task="]\')'))
    report(`${width}px 失败空态无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'))
    writeFileSync(resolve(output, `works-failed-empty-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'))
  }
  // Live 中断也可能有已完成的帧：单帧可下载静态图，多帧仍可预览并导出。
  await browser.evaluate(`(async () => {
    const { useStore } = await import('/src/store.ts')
    const { putImage, putTask } = await import('/src/lib/db.ts')
    const source = useStore.getState().tasks.find((task) => task.id === 'audit-works-done-fav')
    const canvas = document.createElement('canvas')
    canvas.width = 600
    canvas.height = 800
    canvas.getContext('2d').fillStyle = '#dac7f5'
    canvas.getContext('2d').fillRect(0, 0, 600, 800)
    await putImage({ id: 'audit-works-live-second', dataUrl: canvas.toDataURL(), source: 'generated' })
    const tasks = [1, 2].map((count) => ({ ...source, id: 'audit-works-live-partial-' + count, prompt: '实况部分失败 ' + count + ' 帧', status: 'error', error: '本地实况中断，保留已有帧', professionalPreset: 'live-blink', liveFrameCount: 8, liveFramesCompleted: count, outputImages: count === 1 ? ['audit-works-image'] : ['audit-works-image', 'audit-works-live-second'] }))
    for (const task of tasks) await putTask(task)
    useStore.setState((state) => ({ tasks: [...tasks, ...state.tasks] }))
  })()`)
  for (const count of [1, 2]) {
    const path = `/result?task=audit-works-live-partial-${count}`
    await browser.open(path)
    report(`Live 部分失败 ${count} 帧可查看保留内容`, await browser.url() === path && await waitUntil(count === 1
      ? 'document.querySelector("main").innerText.includes("已保留") && Array.from(document.querySelectorAll("main img")).some((image) => image.complete && image.naturalWidth > 0)'
      : 'document.querySelector("main").innerText.includes("已保留") && document.querySelector("main canvas")?.width > 0'))
    report(`Live 部分失败 ${count} 帧提供正确且可用下载入口`, await waitUntil(`Array.from(document.querySelectorAll('main button')).some((button) => button.innerText.trim() === ${JSON.stringify(count === 1 ? '下载' : '下载视频')} && !button.disabled)`))
    report(`Live 部分失败 ${count} 帧手机结果无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'))
    writeFileSync(resolve(output, `works-failed-live-${count}-320.png`), Buffer.from(await browser.screenshot(), 'base64'))
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
