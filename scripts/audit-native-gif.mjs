// 原生 GIF 真浏览器审计：隔离后台、真实中继、本地动图上游与原文件下载。
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createServer as createViteServer } from 'vite'
import { launchChrome } from './lib/cdp.mjs'
import { handleAdminRoute } from '../server/lib/adminRoutes.mjs'
import { initCards } from '../server/lib/cards.mjs'
import { addCredits, getBalance, getReserved, initCredits } from '../server/lib/credits.mjs'
import { handleGuestRoute } from '../server/lib/guestRoutes.mjs'
import { sendError } from '../server/lib/http.mjs'
import { getConfig, initStore, normalizeChannel, normalizeUser, updateConfig } from '../server/lib/store.mjs'
import { flushUsage, initUsage } from '../server/lib/usage.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.tmp-check/native-gif')
const dataDir = mkdtempSync(join(tmpdir(), 'gip-native-gif-audit-'))
const userId = 'u-native-gif-audit'
const prompt = '一只淡紫色蝴蝶在花朵上轻轻扇动翅膀，动作自然循环'
const editorPath = '/tools?tool=live&liveMode=gif'
// 两帧有效 GIF，第二帧换为白色；NETSCAPE 扩展让浏览器持续循环。
const gif = Buffer.from([
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0x80, 0, 0, 139, 92, 246, 255, 255, 255,
  0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0,
  0x21, 0xf9, 4, 0, 20, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0,
  0x21, 0xf9, 4, 0, 20, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 1, 0,
  0x3b,
])
const gifB64 = gif.toString('base64')
const errors = []
const calls = []
let checked = 0
let failed = 0
let primaryFails = true
let vite
let app
let upstream
let browser

function report(label, ok, detail = '') {
  checked++
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` | ${detail}` : ''}`)
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function waitFor(expression, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await browser.evaluate(expression)) return
    await browser.sleep(100)
  }
  throw new Error(`浏览器条件超时：${expression}`)
}

async function open(path) {
  await browser.open(path, 500)
  await waitFor('!!document.querySelector("main")')
  report(`${path} 路由落点`, await browser.url() === path)
  await browser.evaluate(`(() => {
    const originalFetch = window.fetch
    window.fetch = function (input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      if (url.hostname === 'v1.hitokoto.cn') return Promise.resolve(new Response(JSON.stringify({ hitokoto: '本地动图验证', from: '审计' }), { headers: { 'Content-Type': 'application/json' } }))
      if (/^https?:$/.test(url.protocol) && url.origin !== location.origin) throw new Error('审计禁止外部网络：' + url.hostname)
      return originalFetch.call(this, input, init)
    }
  })()`)
}

async function setValue(selector, value) {
  await browser.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) throw new Error('找不到输入控件')
    const prototype = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, ${JSON.stringify(String(value))})
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })()`)
}

async function fillAdminField(label, value) {
  await browser.evaluate(`(() => {
    const el = Array.from(document.querySelectorAll('label')).find((item) => item.innerText.startsWith(${JSON.stringify(label)}))?.querySelector('input')
    if (!el) throw new Error('找不到渠道字段')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
}

async function capture(name) {
  report(`${name} 无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'))
  writeFileSync(resolve(output, `${name}.png`), Buffer.from(await browser.screenshot(), 'base64'))
}

try {
  mkdirSync(output, { recursive: true })
  initStore(dataDir)
  initUsage(dataDir)
  initCredits(dataDir)
  initCards(dataDir)
  upstream = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      const contentType = req.headers['content-type'] ?? ''
      let fields
      let image = ''
      if (contentType.includes('multipart/form-data')) {
        const form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData()
        fields = Object.fromEntries([...form].filter(([, value]) => typeof value === 'string'))
        const file = form.get('image[]') ?? form.get('image')
        if (file && typeof file !== 'string') image = Buffer.from(await file.arrayBuffer()).toString('base64')
      } else {
        fields = JSON.parse(body.toString())
      }
      calls.push({ path: req.url, fields, image })
      await new Promise((resolve) => setTimeout(resolve, 150))
      res.setHeader('Content-Type', 'application/json')
      if (req.url.startsWith('/primary/') && primaryFails) {
        res.statusCode = 503
        res.end(JSON.stringify({ error: { code: 'upstream_unavailable', message: 'Temporary upstream failure' } }))
        return
      }
      res.end(JSON.stringify({ data: [{ b64_json: gifB64 }] }))
    } catch (err) {
      errors.push(err.message)
      res.statusCode = 500
      res.end(JSON.stringify({ error: { message: err.message } }))
    }
  })
  const upstreamUrl = await listen(upstream)
  updateConfig((config) => {
    config.site.accessMode = 'open'
    config.site.failoverEnabled = true
    config.site.failoverMaxAttempts = 0
    config.site.allowGuestParamOverride = true
    config.site.credits = { ...config.site.credits, enabled: true, costPerImage: 1, luckyEnabled: false, channelRates: {} }
    config.users = [normalizeUser({ id: userId, username: 'gif-audit-admin', displayName: '动图审计', role: 'admin' }, userId)]
    config.channels = [normalizeChannel({ id: 'static', name: '静态图专用', model: 'gpt-image-2', baseUrl: `${upstreamUrl}/static/v1`, apiKey: 'local-static-key' }, 'static')]
    return config
  })
  addCredits(userId, 100)
  app = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (!url.pathname.startsWith('/api/')) return vite.middlewares(req, res)
    const ctx = { path: url.pathname, search: url.search, role: 'admin', user: getConfig().users[0], login: () => {}, register: () => {}, logout: () => {} }
    try {
      await (url.pathname.startsWith('/api/admin/') ? handleAdminRoute : handleGuestRoute)(req, res, ctx)
    } catch (err) {
      if (res.headersSent) return res.destroy()
      sendError(res, err.status || 500, err.message, err.extra)
    }
  })
  // 与当前审计的随机 HTTP 端口共用升级连接，避免多个 Vite 实例占用同一个 HMR 端口。
  vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { server: app } }, appType: 'spa', logLevel: 'error' })
  const baseUrl = await listen(app)
  browser = await launchChrome({ port: Number(process.env.AUDIT_CDP_PORT || 9438), baseUrl, onConsoleError: (line) => errors.push(line) })
  await browser.setViewport(1440, 1000)
  await open(editorPath)
  await waitFor('!!document.querySelector("#live-tab-gif")')
  report('GIF 独立页签与未配置提示', await browser.evaluate('document.querySelector("#live-tab-gif").getAttribute("aria-selected") === "true" && document.body.innerText.includes("暂无可用的原生 GIF 渠道")'))
  report('无动图渠道不能提交，也不让用户填写密钥', await browser.evaluate('Array.from(document.querySelectorAll("button")).find((el) => el.innerText.trim() === "生成 GIF 动图")?.disabled && !document.querySelector("input[type=password]")'))

  await open('/admin?tab=channels')
  await waitFor('document.body.innerText.includes("静态图专用")')
  for (const [name, model, path, manual] of [
    ['GIF 主线', 'gpt-image-2.6-sunburst', 'primary', false],
    ['GIF 备用别名', 'gateway-gif', 'backup', true],
  ]) {
    await browser.clickByText('新建渠道', 100)
    await fillAdminField('渠道名称', name)
    await fillAdminField('API 地址', `${upstreamUrl}/${path}/v1`)
    await fillAdminField('模型', model)
    await fillAdminField('API Key', `local-${path}-key`)
    report(`${name} 模型默认能力正确`, await browser.evaluate(`Array.from(document.querySelectorAll('label')).find((el) => el.innerText.includes('支持原生 GIF 动图')).querySelector('input').checked === ${!manual}`))
    if (manual) await browser.evaluate("Array.from(document.querySelectorAll('label')).find((el) => el.innerText.includes('支持原生 GIF 动图')).querySelector('input').click()")
    await browser.clickByText('保存', 200)
    await waitFor(`Array.from(document.querySelectorAll('tbody tr')).some((el) => el.innerText.includes(${JSON.stringify(name)}))`)
    const channel = getConfig().channels.find((item) => item.name === name)
    report(`${name} 后台真实保存 GIF 能力和 Images 接口`, channel?.supportsNativeGif === true && channel.apiMode === 'images')
  }
  const primary = getConfig().channels.find((item) => item.name === 'GIF 主线')
  const backup = getConfig().channels.find((item) => item.name === 'GIF 备用别名')
  await browser.evaluate("Array.from(document.querySelectorAll('tbody tr')).find((el) => el.innerText.includes('GIF 主线')).querySelector('button[title=编辑]').click()")
  await browser.evaluate("Array.from(document.querySelectorAll('label')).find((el) => el.innerText.includes('支持原生 GIF 动图')).querySelector('input').click()")
  await browser.clickByText('保存', 200)
  await waitFor('!document.body.innerText.includes("编辑渠道")')
  report('显式关闭已知模型能力，同时保留原密钥', getConfig().channels.find((item) => item.id === primary.id).supportsNativeGif === false && getConfig().channels.find((item) => item.id === primary.id).apiKey === 'local-primary-key')
  await browser.evaluate("Array.from(document.querySelectorAll('tbody tr')).find((el) => el.innerText.includes('GIF 主线')).querySelector('button[title=编辑]').click()")
  await browser.evaluate("Array.from(document.querySelectorAll('label')).find((el) => el.innerText.includes('支持原生 GIF 动图')).querySelector('input').click()")
  await browser.clickByText('保存', 200)
  await waitFor('!document.body.innerText.includes("编辑渠道")')
  const projected = await (await fetch(`${baseUrl}/api/bootstrap`)).json()
  report('公开引导只下发能力，真实地址与密钥不下发', projected.channels.some((item) => item.id === primary.id && item.supportsNativeGif) && projected.channels.every((item) => !('apiKey' in item) && !('baseUrl' in item)))

  await open(editorPath)
  await waitFor(`document.querySelector('select[aria-label="GIF 生成渠道"]')?.options.length === 2`)
  report('生成渠道仅列出两条 GIF 渠道', await browser.evaluate(`!Array.from(document.querySelector('select[aria-label="GIF 生成渠道"]').options).some((option) => option.text.includes('静态图'))`))
  await setValue('select[aria-label="GIF 生成渠道"]', `backend-${backup.id}`)
  report('可以手动选择动图备用渠道', await browser.evaluate(`document.querySelector('select[aria-label="GIF 生成渠道"]').value === ${JSON.stringify(`backend-${backup.id}`)}`))
  await setValue('select[aria-label="GIF 生成渠道"]', `backend-${primary.id}`)
  await setValue('textarea[aria-label="GIF 动作描述"]', prompt)
  await setValue('select[aria-label="GIF 动画帧数"]', 2)
  await setValue('select[aria-label="GIF 每帧时长"]', 200)
  await setValue('select[aria-label="GIF 画面尺寸"]', '1024x1024')
  for (const width of [1440, 390, 320]) {
    await browser.setViewport(width, 1000)
    await browser.evaluate('window.scrollTo(0, 0)')
    await capture(`editor-${width}`)
    await browser.evaluate(`Array.from(document.querySelectorAll('button')).find((el) => el.innerText.trim() === '生成 GIF 动图').scrollIntoView({ block: 'center' })`)
    report(`${width}px 提交按钮不被底栏遮住且可点击`, await browser.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find((el) => el.innerText.trim() === '生成 GIF 动图')
      const rect = button.getBoundingClientRect()
      return !button.disabled && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === button
    })()`))
    await capture(`editor-controls-${width}`)
  }
  await browser.setViewport(1440, 1000)
  await browser.clickByText('生成 GIF 动图', 200)
  await waitFor('(async () => { const task = (await import("/src/store.ts")).useStore.getState().tasks[0]; return task && task.status !== "running" })()')
  await waitFor('location.pathname === "/result"')
  const result = await browser.evaluate('(async () => { const { useStore } = await import("/src/store.ts"); const { getImage } = await import("/src/lib/db.ts"); const task = useStore.getState().tasks[0]; const image = task.outputImages[0] ? await getImage(task.outputImages[0]) : null; return { task, dataUrl: image?.dataUrl } })()')
  report('文字生成完成后进入结果页', await browser.url() === '/result' && result.task.status === 'done', result.task.error || '')
  report('主线失败后只调用动图备用，静态线路未调用', calls.length === 2 && calls[0].path.startsWith('/primary/') && calls[1].path.startsWith('/backup/'))
  report('参数按单次 GIF 转发，无逐帧调用与静态专属参数', calls.every((call) => call.fields.output_format === 'gif' && Number(call.fields.frame_count) === 2 && Number(call.fields.frame_duration_ms) === 200 && Number(call.fields.n ?? 1) === 1 && call.fields.stream == null && call.fields.partial_images == null && call.fields.output_compression == null && call.fields.prompt === prompt))
  report('原始 GIF 字节保存进作品，成品只扣一次积分', result.dataUrl === `data:image/gif;base64,${gifB64}` && getBalance(userId) === 99 && getReserved(userId) === 0)
  await waitFor('!!document.querySelector("img[data-image-id]")')
  report('浏览器真实解码动图并显示专用下载按钮', await browser.evaluate('(async () => { const img = document.querySelector("img[data-image-id]"); await img.decode(); return img.naturalWidth === 1 && document.body.innerText.includes("下载 GIF") && document.body.innerText.includes("AI 原生 GIF · 动图预览") })()'))
  await browser.evaluate(`(() => {
    window.gifDownloads = []
    const original = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download) return original.call(this)
      const download = { name: this.download }
      download.ready = fetch(this.href).then((res) => res.blob()).then((blob) => new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => { download.dataUrl = reader.result; resolve() }
        reader.onerror = reject
        reader.readAsDataURL(blob)
      }))
      window.gifDownloads.push(download)
    }
  })()`)
  await browser.clickByText('下载 GIF', 100)
  const downloaded = await browser.evaluate('(async () => { await Promise.all(window.gifDownloads.map((item) => item.ready)); return window.gifDownloads.map(({ name, dataUrl }) => ({ name, dataUrl })) })()')
  report('真实下载操作保留 .gif 后缀和逐字节相同的原文件', downloaded.length === 1 && downloaded[0].name.endsWith('.gif') && downloaded[0].dataUrl?.split(',')[1] === gifB64)
  for (const width of [1440, 390, 320]) {
    await browser.setViewport(width, 1000)
    await capture(`result-${width}`)
  }
  const savedPath = `/result?task=${result.task.id}`
  await open(savedPath)
  await waitFor('!!document.querySelector("img[data-image-id]")')
  report('硬刷新作品仍保留原始动画', await browser.evaluate(`document.querySelector('img[data-image-id]').src === ${JSON.stringify(`data:image/gif;base64,${gifB64}`)}`))
  await browser.clickByText('编辑动图', 200)
  const editPath = `${editorPath}&task=${result.task.id}`
  await waitFor(`!!document.querySelector('textarea[aria-label="GIF 动作描述"]')`)
  report('重新生成只回到专用编辑页，不擅自重复收费', await browser.url() === editPath && calls.length === 2 && getBalance(userId) === 99)
  report('恢复原任务提示词、帧数和成功渠道', await browser.evaluate(`document.querySelector('textarea[aria-label="GIF 动作描述"]').value === ${JSON.stringify(prompt)} && document.querySelector('select[aria-label="GIF 动画帧数"]').value === '2' && document.querySelector('select[aria-label="GIF 生成渠道"]').value === ${JSON.stringify(`backend-${backup.id}`)}`))

  primaryFails = false
  await browser.evaluate(`(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 32
    canvas.getContext('2d').fillRect(0, 0, 32, 32)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    window.gifReferenceB64 = canvas.toDataURL().split(',')[1]
    const files = new DataTransfer()
    files.items.add(new File([blob], 'gif-reference.png', { type: 'image/png' }))
    const input = document.querySelector('input[aria-label="上传 GIF 参考图"]')
    input.files = files.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await waitFor(`!!document.querySelector('img[alt="GIF 参考图"]')`)
  await browser.clickByText('生成 GIF 动图', 200)
  await waitFor(`(async () => { const task = (await import('/src/store.ts')).useStore.getState().tasks[0]; return task.id !== ${JSON.stringify(result.task.id)} && task.status !== 'running' })()`)
  report('参考图使用一次 multipart 图片编辑请求生成 GIF', calls.length === 3 && calls[2].path.endsWith('/images/edits') && calls[2].image === await browser.evaluate('window.gifReferenceB64') && calls[2].fields.output_format === 'gif')
  report('第二份动图只追加一份成品积分', getBalance(userId) === 98 && getReserved(userId) === 0)
  report('开发连接正常且无前端控制台或本地上游异常', vite.ws.clients.size > 0 && errors.length === 0, errors.join(' | ') || (vite.ws.clients.size ? '' : 'Vite WebSocket 未连接'))
  console.log(`原生 GIF 专项：${checked} 项检查，${failed} 项失败。截图：${output}`)
} catch (err) {
  failed++
  console.error(err)
} finally {
  await browser?.close()
  if (app) await new Promise((resolve) => app.close(resolve))
  await vite?.close()
  if (upstream) await new Promise((resolve) => upstream.close(resolve))
  flushUsage()
  if (resolve(dataDir).startsWith(`${resolve(tmpdir())}${sep}`)) rmSync(dataDir, { recursive: true, force: true })
}
process.exitCode = failed ? 1 : 0
