// 双图换装真浏览器回归：隔离 Chrome、本地模拟接口，绝不调用付费绘图服务。
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { launchChrome } from './lib/cdp.mjs'
import { startDevServer } from './lib/devServer.mjs'

const PORT = Number(process.env.AUDIT_DEV_PORT || 5186)
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT || 9418)
const API_PORT = Number(process.env.AUDIT_MOCK_PORT || 5196)
const output = resolve('.tmp-check/try-on')
const fixtures = ['/art/work-seaside.jpg', '/art/cover-commerce-v2.jpg']
const imageBytes = fixtures.map((path) => readFileSync(resolve(`public${path}`)))
const imageHashes = imageBytes.map((bytes) => createHash('sha256').update(bytes).digest('hex'))
const referenceFixtures = ['/art/work-sakura.jpg', '/art/work-hanfu.jpg']
const referenceHashes = referenceFixtures.map((path) => createHash('sha256').update(readFileSync(resolve(`public${path}`))).digest('hex'))
const forbidden = /\/api\/relay|\/v1\/(?:images|responses|chat\/completions)|\/images\/(?:generations|edits)|fal\.run|queue\.fal/i
const consoleErrors = []
const requests = []
const upstream = []
const pending = []
let dev
let browser
let hold = true
let failNext = false
let checks = 0
let failed = 0
const report = (label, ok, detail = '') => {
  checks++
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  | ${detail}` : ''}`)
}

const respond = (res, record) => {
  if (res.destroyed) return
  res.statusCode = record.fail ? 400 : 200
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(record.fail
    ? { error: { message: 'AUDIT_TRY_ON_FAILURE' } }
    // 故意回传隐藏模板；专业工具不能把 revised_prompt 泄露到作品详情。
    : { data: Array.from({ length: Math.max(1, Math.min(4, Number(record.n) || 1)) }, () => ({ b64_json: imageBytes[0].toString('base64'), revised_prompt: record.prompt })) }))
}

const mock = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.method !== 'POST' || req.url !== '/v1/images/edits') throw new Error(`非预期接口 ${req.method} ${req.url}`)
    const form = await new Request(`http://127.0.0.1:${API_PORT}${req.url}`, {
      method: 'POST', headers: { 'Content-Type': req.headers['content-type'] }, body: Buffer.concat(chunks),
    }).formData()
    const files = []
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') continue
      files.push({ key, hash: createHash('sha256').update(Buffer.from(await value.arrayBuffer())).digest('hex'), type: value.type })
    }
    const record = { path: req.url, prompt: String(form.get('prompt') || ''), n: String(form.get('n')), size: String(form.get('size')), files, fail: failNext }
    failNext = false
    upstream.push(record)
    if (hold) pending.push({ res, record })
    else respond(res, record)
  } catch (err) {
    failed++
    console.error('模拟接口错误', err)
    res.statusCode = 500
    res.end(JSON.stringify({ error: { message: 'AUDIT_MOCK_ERROR' } }))
  }
})

const waitUntil = async (expression, timeout = 10000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await browser.evaluate(expression)) return true
    await browser.sleep(150)
  }
  return false
}

const collectRequests = async () => {
  requests.push(...await browser.evaluate('([...performance.getEntriesByType("resource").map((entry) => entry.name), ...(window.__tryOnRequests || [])])'))
}

const openAudited = async (path) => {
  await collectRequests()
  await browser.open(path)
  if (!await browser.waitFor('main')) throw new Error(`${path} 未渲染应用外壳`)
  await browser.evaluate(`(() => {
    window.__tryOnRequests = []
    const prohibited = ${forbidden.toString()}
    const allowed = ${JSON.stringify(`http://127.0.0.1:${API_PORT}/v1/images/edits`)}
    const originalFetch = window.fetch
    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : input.url || String(input)
      window.__tryOnRequests.push(url)
      if (prohibited.test(url) && url !== allowed) throw new Error('审计禁止调用非本地绘图接口')
      return originalFetch.call(this, input, init)
    }
    const originalOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      window.__tryOnRequests.push(String(url))
      if (prohibited.test(String(url)) && String(url) !== allowed) throw new Error('审计禁止调用非本地绘图接口')
      return originalOpen.call(this, method, url, ...args)
    }
  })()`)
  report(`${path} 路由落点`, await browser.url() === path)
}

const upload = async (role, fixture, alt = role === 'person' ? '人物参考图' : '商品参考图') => {
  await browser.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(fixture)})
    if (!response.ok) throw new Error('本地参考图读取失败')
    const blob = await response.blob()
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob) })
    window.__tryOnUploadedData ??= {}
    window.__tryOnUploadedData[${JSON.stringify(role)}] = dataUrl
    const files = new DataTransfer()
    files.items.add(new File([blob], ${JSON.stringify(`audit-${role}.jpg`)}, { type: 'image/jpeg' }))
    const input = document.querySelector(${JSON.stringify(`#try-on-${role}`)})
    input.files = files.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  return waitUntil(`(() => { const image = document.querySelector(${JSON.stringify(`img[alt="${alt}"]`)}); return image?.complete && image.naturalWidth > 0 && image.src === window.__tryOnUploadedData[${JSON.stringify(role)}] })()`)
}

const uploadInvalid = async (role) => {
  await browser.evaluate(`(() => {
    const files = new DataTransfer()
    files.items.add(new File(['not-a-real-png'], 'broken.png', { type: 'image/png' }))
    const input = document.querySelector(${JSON.stringify(`#try-on-${role}`)})
    input.files = files.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await browser.sleep(500)
}

const clickOption = async (label) => {
  const clicked = await browser.evaluate(`(() => { const button = Array.from(document.querySelectorAll('button[aria-pressed]')).find((item) => item.innerText.trim().split(String.fromCharCode(10))[0] === ${JSON.stringify(label)}); if (!button) return false; button.click(); return true })()`)
  if (!clicked) throw new Error(`缺少选项 ${label}`)
  await browser.sleep(120)
}

const setDescription = async (value) => {
  await browser.evaluate(`(() => {
    const input = document.querySelector('textarea[aria-label="补充要求"]')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await browser.sleep(100)
}

const taskSnapshot = async (id) => browser.evaluate(`(async () => {
  const { useStore } = await import('/src/store.ts')
  const task = ${id ? `useStore.getState().tasks.find((item) => item.id === ${JSON.stringify(id)})` : 'useStore.getState().tasks[0]'}
  return task ? { id: task.id, status: task.status, prompt: task.prompt, tryOn: task.tryOn, professionalPreset: task.professionalPreset, inputImageIds: task.inputImageIds, maskImageId: task.maskImageId, stylePreset: task.stylePreset, revisedPromptByImage: task.revisedPromptByImage, params: task.params, outputs: task.outputImages } : null
})()`)

try {
  mkdirSync(output, { recursive: true })
  await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(API_PORT, '127.0.0.1', resolve) })
  dev = await startDevServer({ port: PORT })
  browser = await launchChrome({ port: CDP_PORT, baseUrl: dev.url, onConsoleError: (msg) => consoleErrors.push(msg) })
  await browser.setViewport(1440, 960)
  await openAudited('/tools?tool=try-on')
  report('工具页显示独立双图换装界面', (await browser.text()).includes('AI 换装与种草') && await browser.evaluate('!!document.querySelector("#try-on-person") && !!document.querySelector("#try-on-product")'))
  report('缺少两张参考时禁止提交', await browser.evaluate('document.querySelector(\'button[aria-label="生成种草图"]\')?.disabled === true'))
  await browser.evaluate(`(async () => {
    const { useStore } = await import('/src/store.ts')
    const { createDefaultOpenAIProfile } = await import('/src/lib/apiProfiles.ts')
    const profile = createDefaultOpenAIProfile({ id: 'audit-try-on', name: '本地双图模拟', provider: 'openai', baseUrl: 'http://127.0.0.1:${API_PORT}/v1', apiKey: 'audit-only', model: 'gpt-image-2', apiMode: 'images', streamImages: false, apiProxy: false, codexCli: false, timeout: 30, responseFormatB64Json: true })
    useStore.getState().setSettings({ profiles: [profile], activeProfileId: profile.id, channelFailover: false })
  })()`)
  report('人物图真实上传完成', await upload('person', fixtures[0]))
  report('只有人物图仍不能提交', await browser.evaluate('document.querySelector(\'button[aria-label="生成种草图"]\').disabled'))
  report('商品图真实上传完成', await upload('product', fixtures[1]))
  report('双图上传后启用提交', await waitUntil('!document.querySelector(\'button[aria-label="生成种草图"]\').disabled'))
  const selected = await browser.evaluate('Array.from(document.querySelectorAll(\'button[aria-pressed="true"]\')).map((button) => button.innerText.trim().split("\\n")[0])')
  report('默认穿搭、衣服、街景、自然姿势与竖幅', ['上身穿搭', '衣服', '街头日常', '自然站姿', '3:4'].every((label) => selected.includes(label)), selected.join(' / '))
  for (let i = 0; i < 5; i++) await browser.click('button[aria-label="增加生成数量"]', 70)
  report('数量最多四张且增量按钮禁用', await browser.evaluate('document.querySelector(\'[aria-label="生成数量"]\').innerText === "4" && document.querySelector(\'button[aria-label="增加生成数量"]\').disabled'))
  for (let i = 0; i < 5; i++) await browser.click('button[aria-label="减少生成数量"]', 70)
  report('数量最少一张且减量按钮禁用', await browser.evaluate('document.querySelector(\'[aria-label="生成数量"]\').innerText === "1" && document.querySelector(\'button[aria-label="减少生成数量"]\').disabled'))

  const description = '保留人物的眼镜，商品标志清晰'
  await setDescription(description)
  // 污染通用草稿，验证独立工具不会读错图、模板或蒙版，也不会覆盖原有创作。
  await browser.evaluate(`(async () => {
    const { useStore } = await import('/src/store.ts')
    const { putImage } = await import('/src/lib/db.ts')
    const person = { id: 'audit-studio-person', dataUrl: document.querySelector('img[alt="人物参考图"]').src }
    const product = { id: 'audit-studio-product', dataUrl: document.querySelector('img[alt="商品参考图"]').src }
    await putImage(person)
    await putImage(product)
    useStore.getState().setPrompt('AUDIT_STUDIO_DRAFT')
    useStore.getState().setInputImages([product, person])
    useStore.setState({ maskDraft: { maskDataUrl: 'data:image/png;base64,AUDIT_MASK', targetImageId: product.id }, params: { ...useStore.getState().params, size: '1024x1024', n: 4 } })
    document.querySelector('button[aria-label="生成种草图"]').click()
    document.querySelector('button[aria-label="生成种草图"]').click()
  })()`)
  report('提交后进入结果页且显示生成中', await waitUntil('(async () => location.pathname === "/result" && (await import("/src/store.ts")).useStore.getState().tasks[0]?.status === "running")()'))
  const running = await taskSnapshot()
  if (!running) throw new Error('任务未创建')
  report('双击提交只创建一个任务', await browser.evaluate('(async () => (await import("/src/store.ts")).useStore.getState().tasks.length === 1)()'))
  report('任务只保存用户文案、双图角色与独立配置', running.prompt === description && running.inputImageIds.length === 2 && !running.maskImageId && !running.stylePreset && running.professionalPreset === 'try-on' && JSON.stringify(running.tryOn) === JSON.stringify({ mode: 'wear', category: 'clothing', scene: 'street', pose: 'natural' }), JSON.stringify({ options: running.tryOn, count: running.params.n, size: running.params.size }))
  report('通用 Studio 文案、参考图及数量未被独立提交覆盖', await browser.evaluate('(async () => { const state = (await import("/src/store.ts")).useStore.getState(); return state.prompt === "AUDIT_STUDIO_DRAFT" && state.inputImages.map((image) => image.id).join(",") === "audit-studio-product,audit-studio-person" && state.params.n === 4 })()'))
  await browser.click('a[href="/me?tab=works"]', 400)
  report('生成中可离开结果页进入我的作品', await browser.url() === '/me?tab=works')
  const resultPath = `/result?task=${running.id}`
  const card = `main a[href=${JSON.stringify(resultPath)}]`
  report('我的作品显示任务占位与等待进度', await waitUntil(`document.querySelector(${JSON.stringify(card)})?.innerText.includes('生成中') && document.querySelector(${JSON.stringify(card)})?.innerText.includes('已等待')`))
  report('本地接口收到一次双图编辑请求', upstream.length === 1 && upstream[0].files.length === 2)
  report('请求参考严格人物在前商品在后，无额外蒙版', upstream[0]?.files.map((file) => file.hash).join(',') === imageHashes.join(',') && upstream[0]?.files.every((file) => file.key === 'image[]'))
  report('实际请求自动拼接隐藏角色与真实摄影约束', upstream[0]?.prompt.includes(description) && ['第一张参考图是人物', '第二张参考图是商品', '真实摄影', '原有年龄', '品牌标识'].every((phrase) => upstream[0]?.prompt.includes(phrase)) && !upstream[0]?.prompt.includes('AUDIT_STUDIO_DRAFT'))
  hold = false
  for (const entry of pending.splice(0)) respond(entry.res, entry.record)
  report('模拟绘图返回后任务完成', await waitUntil(`(async () => (await import('/src/store.ts')).useStore.getState().tasks.find((task) => task.id === ${JSON.stringify(running.id)})?.status === 'done')()`))
  await browser.click(card)
  report('作品卡片进入对应结果页', await browser.url() === resultPath)
  report('换装结果有真实可解码图片', await waitUntil('Array.from(document.querySelectorAll("main img")).some((image) => image.complete && image.naturalWidth > 100)'))
  const done = await taskSnapshot(running.id)
  report('上游 revised_prompt 不泄露到任务公开文案', done.prompt === description && !done.revisedPromptByImage && !(await browser.text()).includes('第一张参考图是人物'))
  await browser.clickByText('编辑换装')
  const editPath = `/tools?tool=try-on&task=${running.id}`
  report('结果编辑进入单层换装工具地址', await browser.url() === editPath)
  report('编辑恢复两张独立原图和用户要求', await waitUntil(`(() => { const images = ['人物参考图', '商品参考图'].map((alt) => document.querySelector('img[alt="' + alt + '"]')); return images.every((image) => image?.complete && image.naturalWidth > 0) && images[0].src !== images[1].src && document.querySelector('textarea[aria-label="补充要求"]').value === ${JSON.stringify(description)} })()`))
  const sourceUrls = await browser.evaluate('Array.from(document.querySelectorAll(\'img[alt="人物参考图"], img[alt="商品参考图"]\')).map((image) => image.src)')
  await openAudited(editPath)
  report('硬刷新编辑地址仍恢复原图角色顺序', await waitUntil(`JSON.stringify(Array.from(document.querySelectorAll('img[alt="人物参考图"], img[alt="商品参考图"]')).map((image) => image.src)) === ${JSON.stringify(JSON.stringify(sourceUrls))}`))

  await clickOption('手持商品')
  await clickOption('其他商品')
  await clickOption('咖啡小店')
  await clickOption('商品展示')
  await clickOption('1:1')
  const secondDescription = '只添加一个购物袋，保持原图的眼镜'
  await setDescription(secondDescription)
  failNext = true
  await browser.click('button[aria-label="生成种草图"]', 300)
  report('模拟失败任务正确显示失败状态', await waitUntil('(async () => (await import("/src/store.ts")).useStore.getState().tasks[0]?.status === "error")()'))
  const errorTask = await taskSnapshot()
  report('手持配置与正方形参数写入失败任务', JSON.stringify(errorTask.tryOn) === JSON.stringify({ mode: 'hold', category: 'other', scene: 'cafe', pose: 'showcase' }) && errorTask.params.size === '1024x1024' && errorTask.prompt === secondDescription)
  await browser.evaluate(`(async () => { const { useStore, retryTask } = await import('/src/store.ts'); const task = useStore.getState().tasks.find((item) => item.id === ${JSON.stringify(errorTask.id)}); await retryTask(task) })()`)
  report('失败重试仍是双图任务并正常完成', await waitUntil(`(async () => { const task = (await import('/src/store.ts')).useStore.getState().tasks[0]; return task.id !== ${JSON.stringify(errorTask.id)} && task.status === 'done' && task.professionalPreset === 'try-on' })()`))
  const retried = await taskSnapshot()
  report('重试保留角色图片、手持参数与用户文案', JSON.stringify(retried.tryOn) === JSON.stringify(errorTask.tryOn) && JSON.stringify(retried.inputImageIds) === JSON.stringify(errorTask.inputImageIds) && retried.prompt === secondDescription && upstream.length === 3 && upstream[2].files.map((file) => file.hash).join(',') === imageHashes.join(',') && upstream[2].prompt.includes('自然拿着'))
  const retryResult = `/result?task=${retried.id}`
  const retryEdit = `/tools?tool=try-on&task=${retried.id}`
  report('IndexedDB 持久化真实双图、选项与用户文案', await browser.evaluate(`(async () => { const { getAllTasks } = await import('/src/lib/db.ts'); const task = (await getAllTasks()).find((item) => item.id === ${JSON.stringify(retried.id)}); return task?.status === 'done' && JSON.stringify(task.tryOn) === ${JSON.stringify(JSON.stringify(errorTask.tryOn))} && JSON.stringify(task.inputImageIds) === ${JSON.stringify(JSON.stringify(errorTask.inputImageIds))} && task.prompt === ${JSON.stringify(secondDescription)} && !task.revisedPromptByImage })()`))

  for (const width of [1440, 390, 320]) {
    await browser.setViewport(width, 900)
    for (const [path, name] of [[retryEdit, 'editor'], [retryResult, 'result']]) {
      await openAudited(path)
      report(`${width}px ${name} 图片实际完成解码`, await waitUntil(name === 'editor'
        ? `JSON.stringify(Array.from(document.querySelectorAll('img[alt="人物参考图"], img[alt="商品参考图"]')).map((image) => image.src)) === ${JSON.stringify(JSON.stringify(sourceUrls))}`
        : 'Array.from(document.querySelectorAll("main img")).some((image) => image.complete && image.naturalWidth > 100)'))
      if (name === 'editor') report(`${width}px 编辑恢复选中参数`, await browser.evaluate(`(() => { const selected = Array.from(document.querySelectorAll('button[aria-pressed="true"]')).map((button) => button.innerText.trim().split(String.fromCharCode(10))[0]); return ['手持商品', '其他商品', '咖啡小店', '商品展示', '1:1'].every((label) => selected.includes(label)) && document.querySelector('textarea[aria-label="补充要求"]').value === ${JSON.stringify(secondDescription)} })()`))
      report(`${width}px ${name} 无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'))
      writeFileSync(resolve(output, `${name}-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'))
      if (name === 'editor' && width < 768) {
        await browser.evaluate('document.querySelector(\'button[aria-label="生成种草图"]\').scrollIntoView({ block: "center" })')
        await browser.sleep(150)
        report(`${width}px 生成按钮可滚动触达且不被底栏遮挡`, await browser.evaluate('(() => { const button = document.querySelector(\'button[aria-label="生成种草图"]\'); const rect = button.getBoundingClientRect(); return rect.width >= 44 && rect.height >= 44 && rect.top > 50 && rect.bottom <= innerHeight - 55 && !button.disabled })()'))
        writeFileSync(resolve(output, `editor-controls-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'))
      }
    }
  }

  await openAudited(retryEdit)
  await waitUntil(`JSON.stringify(Array.from(document.querySelectorAll('img[alt="人物参考图"], img[alt="商品参考图"]')).map((image) => image.src)) === ${JSON.stringify(JSON.stringify(sourceUrls))}`)
  await uploadInvalid('product')
  const errorVisible = await waitUntil('(async () => { const toast = (await import("/src/store.ts")).useStore.getState().toast; return toast?.type === "error" && toast.message.trim().length > 0 && document.body.innerText.includes(toast.message) })()')
  report('真实坏文件上传有可见错误提示', errorVisible, errorVisible ? '' : JSON.stringify(await browser.evaluate('(async () => (await import("/src/store.ts")).useStore.getState().toast)()')))
  report('真实损坏文件上传保留之前可用商品图', await waitUntil(`(() => { const image = document.querySelector('img[alt="商品参考图"]'); return image?.src === ${JSON.stringify(sourceUrls[1])} && image.complete && image.naturalWidth > 0 && !document.querySelector('button[aria-label="生成种草图"]').disabled })()`), '错误上传不得替换已选择的有效图片')
  await openAudited('/tools?tool=try-on')
  await upload('person', fixtures[0])
  await uploadInvalid('product')
  report('初次商品图损坏不能误启用生成按钮', await browser.evaluate('document.querySelector(\'button[aria-label="生成种草图"]\').disabled && !document.querySelector(\'img[alt="商品参考图"]\')') && upstream.length === 3)

  const invalid = await browser.evaluate(`(async () => {
    const { useStore, submitTryOnTask } = await import('/src/store.ts')
    const { getImage, getAllTasks } = await import('/src/lib/db.ts')
    const before = (await getAllTasks()).length
    const person = await getImage(${JSON.stringify(running.inputImageIds[0])})
    const args = { person, product: { id: 'audit-broken', dataUrl: 'data:image/png;base64,bm90LWEtcG5n' }, prompt: '', options: {}, size: '1024x1024', count: 1 }
    const damaged = await submitTryOnTask(args)
    const duplicate = await submitTryOnTask({ ...args, product: person })
    return { damaged, duplicate, before, after: (await getAllTasks()).length, memory: useStore.getState().tasks.length, sourceFound: !!person }
  })()`)
  report('损坏图片与重复双图在创建任务前被拒绝', invalid.damaged === false && invalid.duplicate === false && invalid.before === invalid.after && invalid.memory === invalid.before && upstream.length === 3, JSON.stringify(invalid))

  await browser.setViewport(1440, 960)
  await openAudited('/tools?tool=try-on')
  await clickOption('爆款参考')
  report('爆款参考明确第二张角色且隐藏商品配置', await browser.evaluate('!!document.querySelector(\'button[aria-label="选择爆款参考图"]\') && document.querySelector("#try-on-product").getAttribute("aria-label") === "上传爆款参考图片" && !Array.from(document.querySelectorAll("button")).some((button) => button.innerText.trim() === "衣服")'))
  report('默认全面参考并跟随第二图姿势', await browser.evaluate('Array.from(document.querySelectorAll(\'button[aria-label^="参考"]\')).length === 3 && Array.from(document.querySelectorAll(\'button[aria-label^="参考"]\')).every((button) => button.getAttribute("aria-pressed") === "true") && Array.from(document.querySelectorAll(\'button[aria-pressed="true"]\')).some((button) => button.innerText.trim() === "跟随参考姿势")'))
  report('爆款人物图真实上传完成', await upload('person', fixtures[0]))
  report('爆款第二参考图真实上传完成', await upload('product', referenceFixtures[0], '爆款参考图'))
  await browser.click('button[aria-label="移除爆款参考图"]', 100)
  report('移除第二图立即禁用生成且保留人物身份', await browser.evaluate('!document.querySelector(\'img[alt="爆款参考图"]\') && !!document.querySelector(\'img[alt="人物参考图"]\') && document.querySelector(\'button[aria-label="生成种草图"]\').disabled'))
  report('移除后可重新上传另一张爆款参考', await upload('product', referenceFixtures[1], '爆款参考图'))
  await browser.click('button[aria-label="移除人物图"]', 100)
  report('移除人物图立即禁用生成且保留第二图', await browser.evaluate('!document.querySelector(\'img[alt="人物参考图"]\') && !!document.querySelector(\'img[alt="爆款参考图"]\') && document.querySelector(\'button[aria-label="生成种草图"]\').disabled'))
  report('人物清除后可重传并恢复提交', await upload('person', fixtures[0]) && await waitUntil('!document.querySelector(\'button[aria-label="生成种草图"]\').disabled'))
  const referenceSources = await browser.evaluate('Array.from(document.querySelectorAll(\'img[alt="人物参考图"], img[alt="爆款参考图"]\')).map((image) => image.src)')
  const referenceDescription = '保留我的长发，不复制参考图的人脸'
  await setDescription(referenceDescription)
  await browser.click('button[aria-label="生成种草图"]', 200)
  report('爆款全面参考提交后正确进入结果并完成', await waitUntil('(async () => { const task = (await import("/src/store.ts")).useStore.getState().tasks[0]; return location.pathname === "/result" && task?.status === "done" && task.tryOn?.mode === "reference" })()'))
  const fullReference = await taskSnapshot()
  const fullRequest = upstream[3]
  report('爆款任务存完整参考项、跟随姿势和双图引用', fullReference.tryOn?.mode === 'reference' && fullReference.tryOn.pose === 'reference' && JSON.stringify(fullReference.tryOn.referenceElements) === JSON.stringify(['outfit', 'scene', 'style']) && fullReference.inputImageIds.length === 2 && fullReference.prompt === referenceDescription)
  report('重传后的实际字节严格人物在前、新爆款在后', fullRequest?.files.map((file) => file.hash).join(',') === [imageHashes[0], referenceHashes[1]].join(',') && fullRequest?.files.every((file) => file.key === 'image[]') && !fullRequest?.files.some((file) => file.hash === referenceHashes[0]))
  report('全面参考请求保护人物身份并分别约束三项与跟随姿势', ['第一张参考图是人物身份图', '第二张参考图是穿搭、场景和拍摄风格参考图', '不得复制其脸型、五官、年龄、肤色、体型或发型', '参考第二张图的整套穿搭', '参考第二张图的场景、背景', '参考第二张图的拍摄风格', '仅参考第二张图人物的肢体姿势'].every((phrase) => fullRequest?.prompt.includes(phrase)) && fullRequest.prompt.includes(referenceDescription))
  report('爆款结果不公开辅助提示词或上游修订词', fullReference.prompt === referenceDescription && !fullReference.revisedPromptByImage && !(await browser.text()).includes('第一张参考图是人物身份图'))
  await browser.clickByText('编辑换装')
  const fullEdit = `/tools?tool=try-on&task=${fullReference.id}`
  report('爆款结果编辑保持精确单层路由', await browser.url() === fullEdit)
  report('爆款编辑恢复两张原图、模式和全部参考项', await waitUntil(`(() => { const selected = Array.from(document.querySelectorAll('button[aria-pressed="true"]')).map((button) => button.innerText.trim().split(String.fromCharCode(10))[0]); return JSON.stringify(Array.from(document.querySelectorAll('img[alt="人物参考图"], img[alt="爆款参考图"]')).map((image) => image.src)) === ${JSON.stringify(JSON.stringify(referenceSources))} && ['爆款参考', '跟随参考姿势'].every((label) => selected.includes(label)) && Array.from(document.querySelectorAll('button[aria-label^="参考"]')).every((button) => button.getAttribute('aria-pressed') === 'true') && document.querySelector('textarea[aria-label="补充要求"]').value === ${JSON.stringify(referenceDescription)} })()`))
  await openAudited(fullEdit)
  report('全面参考硬刷新仍还原模式、角色与跟随选项', await waitUntil(`(() => { const images = Array.from(document.querySelectorAll('img[alt="人物参考图"], img[alt="爆款参考图"]')); return JSON.stringify(images.map((image) => image.src)) === ${JSON.stringify(JSON.stringify(referenceSources))} && images.every((image) => image.complete && image.naturalWidth > 0) && Array.from(document.querySelectorAll('button[aria-pressed="true"]')).some((button) => button.innerText.trim() === '跟随参考姿势') && Array.from(document.querySelectorAll('button[aria-label^="参考"]')).every((button) => button.getAttribute('aria-pressed') === 'true') })()`))
  await browser.click('button[aria-label="参考场景背景"]', 100)
  await browser.click('button[aria-label="参考拍摄风格"]', 100)
  report('可以只参考穿搭且最后一项禁止取消', await browser.evaluate('document.querySelector(\'button[aria-label="参考整套穿搭"]\').disabled && document.querySelector(\'button[aria-label="参考整套穿搭"]\').getAttribute("aria-pressed") === "true" && document.querySelector(\'button[aria-label="参考场景背景"]\').getAttribute("aria-pressed") === "false" && document.querySelector(\'button[aria-label="参考拍摄风格"]\').getAttribute("aria-pressed") === "false"'))
  await browser.click('button[aria-label="参考整套穿搭"]', 100)
  await clickOption('自然站姿')
  await clickOption('1:1')
  const outfitDescription = '只换参考穿搭，保留我的背景和光线'
  await setDescription(outfitDescription)
  await browser.click('button[aria-label="生成种草图"]', 200)
  report('仅穿搭新创作正常完成', await waitUntil(`(async () => { const task = (await import('/src/store.ts')).useStore.getState().tasks[0]; return task?.id !== ${JSON.stringify(fullReference.id)} && task?.status === 'done' && task.tryOn?.mode === 'reference' })()`))
  const outfit = await taskSnapshot()
  const outfitRequest = upstream[4]
  report('仅穿搭任务保存单项选择和单独姿势', JSON.stringify(outfit.tryOn.referenceElements) === JSON.stringify(['outfit']) && outfit.tryOn.pose === 'natural' && outfit.prompt === outfitDescription && outfitRequest?.files.map((file) => file.hash).join(',') === [imageHashes[0], referenceHashes[1]].join(','))
  report('仅穿搭请求明确不引用第二图的背景和拍摄风格', ['参考第二张图的整套穿搭', '不参考第二张图的场景，沿用第一张人物图', '不参考第二张图的拍摄风格，沿用第一张人物图', '人物姿势采用自然放松的姿态'].every((phrase) => outfitRequest?.prompt.includes(phrase)) && !outfitRequest.prompt.includes('仅参考第二张图人物的肢体姿势'))
  const outfitEdit = `/tools?tool=try-on&task=${outfit.id}`
  await openAudited(outfitEdit)
  report('仅穿搭刷新恢复单项而非回落到默认全选', await waitUntil(`(() => { const image = document.querySelector('img[alt="爆款参考图"]'); return image?.src === ${JSON.stringify(referenceSources[1])} && !document.querySelector('button[aria-label="生成种草图"]').disabled && document.querySelector('button[aria-label="参考整套穿搭"]').getAttribute('aria-pressed') === 'true' && document.querySelector('button[aria-label="参考场景背景"]').getAttribute('aria-pressed') === 'false' && document.querySelector('button[aria-label="参考拍摄风格"]').getAttribute('aria-pressed') === 'false' })()`))

  await clickOption('随机自然姿势')
  await browser.click('button[aria-label="增加生成数量"]', 100)
  const randomDescription = '自然变化姿势，穿搭保持一致'
  await setDescription(randomDescription)
  // 固定两次抽样的不同返回值，避免偶然抽到同一姿势掩盖新生成/重试差别。
  await browser.evaluate('window.__tryOnOriginalRandom = Math.random; Math.random = () => 0.01')
  failNext = true
  await browser.click('button[aria-label="生成种草图"]', 200)
  report('随机参考预设失败正常写入失败任务', await waitUntil(`(async () => { const task = (await import('/src/store.ts')).useStore.getState().tasks[0]; return task?.id !== ${JSON.stringify(outfit.id)} && task?.status === 'error' && task.tryOn?.pose === 'random' })()`))
  await browser.evaluate('Math.random = window.__tryOnOriginalRandom')
  const randomError = await taskSnapshot()
  const randomErrorRequest = upstream[5]
  report('随机姿势在提交时仅抽样一次并保存稳定编号', randomError.tryOn.poseVariant === 0 && randomError.params.n === 2 && JSON.stringify(randomError.tryOn.referenceElements) === JSON.stringify(['outfit']) && randomError.prompt === randomDescription)
  report('多张随机请求引导不同自然动作且维持参考身份', ['本次随机姿势采用正面自然站立', '各输出按顺序采用不同自然姿势', '第1张', '第2张', '保持人物身份与所选参考元素一致'].every((phrase) => randomErrorRequest?.prompt.includes(phrase)) && randomErrorRequest.n === '2')
  await browser.evaluate(`(async () => { const { useStore, retryTask } = await import('/src/store.ts'); const task = useStore.getState().tasks.find((item) => item.id === ${JSON.stringify(randomError.id)}); const original = Math.random; Math.random = () => 0.99; try { await retryTask(task) } finally { Math.random = original } })()`)
  report('随机失败重试仍正常完成参考任务', await waitUntil(`(async () => { const task = (await import('/src/store.ts')).useStore.getState().tasks[0]; return task?.id !== ${JSON.stringify(randomError.id)} && task?.status === 'done' && task.tryOn?.mode === 'reference' })()`))
  const randomRetry = await taskSnapshot()
  const randomRetryRequest = upstream[6]
  report('重试忽略新的随机数、复用原姿势编号与完整请求', JSON.stringify(randomRetry.tryOn) === JSON.stringify(randomError.tryOn) && JSON.stringify(randomRetry.inputImageIds) === JSON.stringify(randomError.inputImageIds) && randomRetryRequest?.prompt === randomErrorRequest?.prompt && JSON.stringify(randomRetryRequest?.files) === JSON.stringify(randomErrorRequest?.files) && randomRetry.outputs.length === 2)
  report('随机参考选项、单项参考与编号真实持久化', await browser.evaluate(`(async () => { const task = (await (await import('/src/lib/db.ts')).getAllTasks()).find((item) => item.id === ${JSON.stringify(randomRetry.id)}); return task?.status === 'done' && JSON.stringify(task.tryOn) === ${JSON.stringify(JSON.stringify(randomError.tryOn))} && task.prompt === ${JSON.stringify(randomDescription)} && !task.revisedPromptByImage })()`))
  const randomEdit = `/tools?tool=try-on&task=${randomRetry.id}`
  const randomResult = `/result?task=${randomRetry.id}`
  for (const width of [1440, 390, 320]) {
    await browser.setViewport(width, 900)
    for (const [path, name] of [[randomEdit, 'reference-editor'], [randomResult, 'reference-result']]) {
      await openAudited(path)
      report(`${width}px ${name} 原图或输出真实解码`, await waitUntil(name === 'reference-editor'
        ? `(() => { const images = Array.from(document.querySelectorAll('img[alt="人物参考图"], img[alt="爆款参考图"]')); return JSON.stringify(images.map((image) => image.src)) === ${JSON.stringify(JSON.stringify(referenceSources))} && images.every((image) => image.complete && image.naturalWidth > 0) })()`
        : 'Array.from(document.querySelectorAll("main img")).some((image) => image.complete && image.naturalWidth > 100)'))
      if (name === 'reference-editor') report(`${width}px 随机参考刷新恢复单项、姿势、数量与用户文案`, await browser.evaluate(`(() => { const selected = Array.from(document.querySelectorAll('button[aria-pressed="true"]')).map((button) => button.innerText.trim().split(String.fromCharCode(10))[0]); return ['爆款参考', '随机自然姿势', '1:1'].every((label) => selected.includes(label)) && document.querySelector('button[aria-label="参考整套穿搭"]').disabled && document.querySelector('button[aria-label="参考场景背景"]').getAttribute('aria-pressed') === 'false' && document.querySelector('button[aria-label="参考拍摄风格"]').getAttribute('aria-pressed') === 'false' && document.querySelector('[aria-label="生成数量"]').innerText === '2' && document.querySelector('textarea[aria-label="补充要求"]').value === ${JSON.stringify(randomDescription)} })()`))
      report(`${width}px ${name} 无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'))
      writeFileSync(resolve(output, `${name}-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'))
      if (name === 'reference-editor' && width < 768) {
        report(`${width}px 新模式、参考与姿势控件具备44px触控高度`, await browser.evaluate('Array.from(document.querySelectorAll("button[aria-pressed]")).every((button) => { const rect = button.getBoundingClientRect(); return rect.width >= 44 && rect.height >= 44 })'))
        await browser.evaluate('document.querySelector(\'button[aria-label="参考拍摄风格"]\').scrollIntoView({ block: "center" })')
        await browser.sleep(150)
        writeFileSync(resolve(output, `reference-options-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'))
        await browser.evaluate('document.querySelector(\'button[aria-label="生成种草图"]\').scrollIntoView({ block: "center" })')
        await browser.sleep(150)
        report(`${width}px 爆款生成按钮可触达且不被底栏遮挡`, await browser.evaluate('(() => { const button = document.querySelector(\'button[aria-label="生成种草图"]\'); const rect = button.getBoundingClientRect(); return rect.width >= 44 && rect.height >= 44 && rect.top > 50 && rect.bottom <= innerHeight - 55 && !button.disabled })()'))
        writeFileSync(resolve(output, `reference-controls-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'))
      }
    }
  }

  await browser.setViewport(1440, 960)
  await openAudited(randomEdit)
  await waitUntil('!document.querySelector(\'button[aria-label="生成种草图"]\').disabled')
  await browser.evaluate('window.__tryOnOriginalRandom = Math.random; Math.random = () => 0.99')
  await browser.click('button[aria-label="生成种草图"]', 200)
  report('编辑随机记录不改变选项也可重新创作', await waitUntil(`(async () => { const task = (await import('/src/store.ts')).useStore.getState().tasks[0]; return task?.id !== ${JSON.stringify(randomRetry.id)} && task?.status === 'done' && task.tryOn?.mode === 'reference' })()`))
  await browser.evaluate('Math.random = window.__tryOnOriginalRandom')
  const freshRandom = await taskSnapshot()
  report('编辑直接新生成重新抽姿势而不复用历史编号', freshRandom.tryOn.poseVariant === 7 && freshRandom.tryOn.pose === 'random' && JSON.stringify(freshRandom.tryOn.referenceElements) === JSON.stringify(['outfit']) && freshRandom.prompt === randomDescription && upstream[7]?.prompt !== randomRetryRequest?.prompt && upstream[7]?.prompt.includes('本次随机姿势采用自然倚靠或坐姿'))
  await openAudited(randomEdit)
  await waitUntil('!document.querySelector(\'button[aria-label="生成种草图"]\').disabled')
  await clickOption('跟随参考姿势')
  await clickOption('手持商品')
  report('参考跟随姿势切回商品模式降级自然姿势并移除参考专属控件', await browser.evaluate('!document.querySelector(\'button[aria-label="参考整套穿搭"]\') && !Array.from(document.querySelectorAll("button")).some((button) => button.innerText.trim() === "跟随参考姿势") && Array.from(document.querySelectorAll(\'button[aria-pressed="true"]\')).some((button) => button.innerText.trim() === "自然站姿") && !!document.querySelector(\'img[alt="商品参考图"]\')'))
  await clickOption('随机自然姿势')
  await clickOption('其他商品')
  await browser.click('button[aria-label="移除商品图"]', 100)
  report('商品模式也可清除第二图并安全禁用提交', await browser.evaluate('!document.querySelector(\'img[alt="商品参考图"]\') && document.querySelector(\'button[aria-label="生成种草图"]\').disabled'))
  report('清除参考后上传真实商品替换第二角色', await upload('product', fixtures[1]))
  await setDescription('随机手持商品，保留自己的脸')
  await browser.evaluate('window.__tryOnOriginalRandom = Math.random; Math.random = () => 0.99')
  await browser.click('button[aria-label="生成种草图"]', 200)
  report('商品模式新增随机姿势正常完成', await waitUntil(`(async () => { const task = (await import('/src/store.ts')).useStore.getState().tasks[0]; return task?.id !== ${JSON.stringify(randomRetry.id)} && task?.status === 'done' && task.tryOn?.mode === 'hold' })()`))
  await browser.evaluate('Math.random = window.__tryOnOriginalRandom')
  const productRandom = await taskSnapshot()
  const productRequest = upstream[8]
  report('新创作重新抽样且不携带参考模式附加字段', productRandom.tryOn.pose === 'random' && productRandom.tryOn.poseVariant === 7 && !Object.prototype.hasOwnProperty.call(productRandom.tryOn, 'referenceElements') && Object.keys(productRandom.tryOn).length === 5 && productRandom.params.n === 2)
  report('商品随机请求使用真实新商品并保留手持规则', productRequest?.files.map((file) => file.hash).join(',') === imageHashes.join(',') && productRequest?.prompt.includes('第二张参考图是商品') && productRequest.prompt.includes('自然拿着') && productRequest.prompt.includes('本次随机姿势采用自然倚靠或坐姿') && !productRequest.prompt.includes('第二张参考图是穿搭、场景和拍摄风格参考图'))
  report('旧商品模式四字段任务没有被新选项扩写', await browser.evaluate(`(async () => { const tasks = await (await import('/src/lib/db.ts')).getAllTasks(); return [${JSON.stringify(running.id)}, ${JSON.stringify(retried.id)}].every((id) => { const options = tasks.find((task) => task.id === id)?.tryOn; return options && Object.keys(options).length === 4 && !('referenceElements' in options) && !('poseVariant' in options) }) })()`))

  await collectRequests()
  const external = requests.filter((url) => forbidden.test(url) && url !== `http://127.0.0.1:${API_PORT}/v1/images/edits`)
  report('所有绘图请求仅访问隔离本地模拟接口', external.length === 0, external.slice(0, 3).join(' | '))
  report('没有 console.error 报错', consoleErrors.length === 0, consoleErrors.join(' | '))
  console.log(`本地绘图请求 ${upstream.length} 次（包括 ${upstream.filter((record) => record.fail).length} 次预设失败），截图保存在 ${output}`)
} catch (err) {
  failed++
  console.error(err)
} finally {
  for (const entry of pending.splice(0)) entry.res.end()
  await browser?.close()
  await dev?.stop()
  mock.closeAllConnections()
  await new Promise((resolve) => mock.close(resolve))
  console.log(`检查 ${checks} 项，失败 ${failed} 项`)
  process.exitCode = failed ? 1 : 0
}
