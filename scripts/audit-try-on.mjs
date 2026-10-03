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
    : { data: [{ b64_json: imageBytes[0].toString('base64'), revised_prompt: record.prompt }] }))
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

const upload = async (role, fixture) => {
  await browser.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(fixture)})
    if (!response.ok) throw new Error('本地参考图读取失败')
    const files = new DataTransfer()
    files.items.add(new File([await response.blob()], ${JSON.stringify(`audit-${role}.jpg`)}, { type: 'image/jpeg' }))
    const input = document.querySelector(${JSON.stringify(`#try-on-${role}`)})
    input.files = files.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  return waitUntil(`(() => { const image = document.querySelector(${JSON.stringify(`img[alt="${role === 'person' ? '人物' : '商品'}参考图"]`)}); return image?.complete && image.naturalWidth > 0 })()`)
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
  await collectRequests()
  const external = requests.filter((url) => forbidden.test(url) && url !== `http://127.0.0.1:${API_PORT}/v1/images/edits`)
  report('所有绘图请求仅访问隔离本地模拟接口', external.length === 0, external.slice(0, 3).join(' | '))
  report('没有 console.error 报错', consoleErrors.length === 0, consoleErrors.join(' | '))
  console.log(`本地绘图请求 ${upstream.length} 次（包括一次预设失败），截图保存在 ${output}`)
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
