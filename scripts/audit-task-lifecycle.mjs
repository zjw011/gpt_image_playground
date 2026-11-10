// 自带服务与隔离 Chrome，所有出图响应都在浏览器内合成，不调用收费接口。
import { launchChrome } from './lib/cdp.mjs'
import { startDevServer } from './lib/devServer.mjs'

let dev
let browser
let secondSocket
let checks = 0
const report = (name, value) => {
  checks++
  console.log(`${value ? 'PASS' : 'FAIL'} ${name}`)
  if (!value) throw new Error(name)
}
async function waitFor(evaluate, expression) {
  const until = Date.now() + 20_000
  while (Date.now() < until) {
    if (await evaluate(expression)) return
    await browser.sleep(100)
  }
  console.log(await evaluate(`JSON.stringify({ url: location.pathname + location.search, calls: window.auditCalls, tasks: window.auditStore?.useStore.getState().tasks.map(({ id, status, error, saveError, outputImages }) => ({ id, status, error, saveError, count: outputImages.length })) })`))
  throw new Error(`等待超时：${expression}`)
}

try {
  dev = await startDevServer({ port: 5197 })
  browser = await launchChrome({ port: 9437, baseUrl: dev.url })
  await browser.open('/studio')
  if (!await browser.waitFor('textarea', 20_000)) throw new Error('Studio 未就绪')
  report('创作页精确路由', await browser.url() === '/studio')
  await browser.evaluate(`(async () => {
    window.auditStore = await import('/src/store.ts')
    window.auditDB = await import('/src/lib/db.ts')
    const { createDefaultOpenAIProfile } = await import('/src/lib/apiProfiles.ts')
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32
    canvas.getContext('2d').fillRect(0, 0, 32, 32)
    window.auditImage = canvas.toDataURL('image/png')
    window.auditCalls = 0; window.auditDownloadCalls = 0; window.auditResponse = null; window.auditDelay = 0
    const original = window.fetch
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      if (url.pathname.startsWith('/mock-generation/')) {
        window.auditCalls++
        if (window.auditDelay) await new Promise((resolve) => setTimeout(resolve, window.auditDelay))
        else await new Promise((resolve) => { window.auditResponse = resolve })
        return new Response(JSON.stringify({ data: [{ b64_json: window.auditImage.split(',')[1] }] }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (url.pathname === '/mock-result.png') {
        window.auditDownloadCalls++
        return original(window.auditImage)
      }
      if (url.origin !== location.origin && url.protocol !== 'data:') throw new Error('专项禁止外部请求')
      return original(input, init)
    }
    const profile = { ...createDefaultOpenAIProfile(), id: 'lifecycle-audit', baseUrl: location.origin + '/mock-generation/', apiKey: 'local-only', timeout: 30 }
    auditStore.useStore.getState().setSettings({ profiles: [profile], activeProfileId: profile.id, channelFailover: false, clearInputAfterSubmit: false })
    auditStore.useStore.getState().setPrompt('本地双击测试')
  })()`)
  await browser.evaluate(`(() => { const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '生成'); if (!button) throw new Error('找不到生成按钮'); button.click(); button.click() })()`)
  await waitFor(browser.evaluate, 'window.auditCalls === 1 && window.auditResponse !== null')
  report('真实按钮双击只创建一笔任务', await browser.evaluate('auditStore.useStore.getState().tasks.length === 1'))
  await waitFor(browser.evaluate, `location.pathname + location.search === '/result'`)
  report('结果页精确路由', await browser.url() === '/result')

  // 同一个浏览器配置中新建标签页，真实共享 IndexedDB 和 Web Locks。
  const target = await (await fetch('http://127.0.0.1:9437/json/new?about:blank', { method: 'PUT' })).json()
  secondSocket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { secondSocket.onopen = resolve; secondSocket.onerror = reject })
  let nextId = 1
  const pending = new Map()
  secondSocket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const handler = pending.get(message.id)
    if (!handler) return
    pending.delete(message.id)
    if (message.error || message.result?.exceptionDetails) handler.reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)))
    else handler.resolve(message.result?.result?.value)
  }
  const evaluateSecond = (expression) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    secondSocket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  await evaluateSecond(`location.href = ${JSON.stringify(`${dev.url}/me?tab=works`)}`)
  await browser.sleep(1000)
  await waitFor(evaluateSecond, `!!document.querySelector('main')`)
  report('第二标签页精确路由', await evaluateSecond(`location.pathname + location.search === '/me?tab=works'`))
  await waitFor(evaluateSecond, `(async () => { window.auditStore = await import('/src/store.ts'); return auditStore.useStore.getState().tasks.length === 1 })()`)
  report('新标签页不将其他页运行任务标为中断', await evaluateSecond(`auditStore.useStore.getState().tasks[0].status === 'running'`))
  report('共享数据库中的任务保持运行', await browser.evaluate(`(async () => (await auditDB.getAllTasks())[0].status === 'running')()`))
  await browser.evaluate('window.auditResponse()')
  await waitFor(browser.evaluate, `auditStore.useStore.getState().tasks[0].status === 'done'`)
  await waitFor(evaluateSecond, `auditStore.useStore.getState().tasks[0].status === 'done'`)
  report('原页完成后同步到另一页且没有重复请求', await browser.evaluate('window.auditCalls === 1'))

  const abortResult = await browser.evaluate(`(async () => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(value, ...args) {
      const request = original.call(this, value, ...args)
      if (this.name === 'tasks' && value.id === 'abort-after-success') request.addEventListener('success', () => this.transaction.abort())
      return request
    }
    let rejected = false
    try { await auditDB.putTask({ ...auditStore.useStore.getState().tasks[0], id: 'abort-after-success' }) } catch { rejected = true }
    finally { IDBObjectStore.prototype.put = original }
    return rejected && !(await auditDB.getAllTasks()).some((task) => task.id === 'abort-after-success')
  })()`)
  report('IDB请求成功后事务回滚会正确报错且不假报已保存', abortResult)

  await browser.evaluate(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#aabbcc'; ctx.fillRect(0, 0, 32, 32)
    window.auditImage = canvas.toDataURL('image/png')
    window.auditOriginalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(value, ...args) {
      if (this.name === 'images') throw new DOMException('模拟磁盘不足', 'QuotaExceededError')
      return window.auditOriginalPut.call(this, value, ...args)
    }
    window.auditDelay = 20
    auditStore.useStore.getState().setPrompt('磁盘不足仍保留成品')
    await auditStore.submitTask()
  })()`)
  await waitFor(browser.evaluate, `auditStore.useStore.getState().tasks.some((task) => !!task.saveError)`)
  report('保存失败仍有可下载的原图，不再次生成', await browser.evaluate(`(async () => {
    const task = auditStore.useStore.getState().tasks.find((task) => task.saveError)
    const { ensureImageCached } = await import('/src/lib/imageCache.ts')
    window.auditPendingTask = task.id
    return task.outputImages.length === 1 && (await ensureImageCached(task.outputImages[0])) === window.auditImage && window.auditCalls === 2
  })()`))
  await browser.evaluate('IDBObjectStore.prototype.put = window.auditOriginalPut')
  report('只重试保存可恢复，不额外调用生成接口', await browser.evaluate(`(async () => {
    const ok = await auditStore.retryTaskSave(window.auditPendingTask)
    return ok && window.auditCalls === 2 && (await auditDB.getAllTasks()).some((task) => task.id === window.auditPendingTask && task.status === 'done' && !task.saveError)
  })()`))
  report('缺失参考图阻止复用和误提交', await browser.evaluate(`(async () => {
    const task = { ...auditStore.useStore.getState().tasks[0], inputImageIds: ['missing-reference'], maskImageId: undefined }
    return await auditStore.reuseConfig(task) === false && window.auditCalls === 2
  })()`))
  report('仅重取现有结果链接，不重新生成', await browser.evaluate(`(async () => {
    const task = { ...auditStore.useStore.getState().tasks[0], id: 'download-only', status: 'error', outputImages: [], inputImageIds: [], rawImageUrls: [location.origin + '/mock-result.png'], error: '图片下载失败', saveError: undefined }
    await auditDB.putTask(task)
    auditStore.useStore.getState().setTasks([task, ...auditStore.useStore.getState().tasks])
    return await auditStore.retryTaskDownload(task.id) && window.auditCalls === 2 && window.auditDownloadCalls === 1
  })()`))
  await browser.evaluate(`(async () => {
    const state = auditStore.useStore.getState()
    state.setSettings({ profiles: state.settings.profiles.map((profile) => ({ ...profile, timeout: 1 })) })
    state.setPrompt('八帧连续生成')
    state.clearInputImages()
    window.auditDelay = 200
    await auditStore.submitTask({ professionalPreset: 'live-breeze', liveFrameCount: 8 })
  })()`)
  await waitFor(browser.evaluate, `auditStore.useStore.getState().tasks.some((task) => task.liveFrameCount === 8 && task.status !== 'running')`)
  report('8帧累计超过单次超时仍完整保留成品', await browser.evaluate(`auditStore.useStore.getState().tasks.some((task) => task.liveFrameCount === 8 && task.status === 'done' && task.outputImages.length === 8) && window.auditCalls === 10`))
  console.log(`任务生命周期专项：${checks} 项通过`)
} finally {
  secondSocket?.close()
  await browser?.close()
  await dev?.stop()
}
