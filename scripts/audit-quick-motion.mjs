// 快速运镜真浏览器回归：本地上传、作品恢复、真实视频编码与手机布局。
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { launchChrome } from './lib/cdp.mjs'
import { startDevServer } from './lib/devServer.mjs'

const PORT = Number(process.env.AUDIT_DEV_PORT || 5185)
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT || 9417)
const output = resolve('.tmp-check/quick-motion')
const forbidden = /\/api\/relay|\/v1\/(?:images|responses|chat\/completions)|\/images\/(?:generations|edits)|fal\.run|queue\.fal/i
const consoleErrors = []
const requests = []
let dev
let browser
let failed = 0
const report = (label, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  | ${detail}` : ''}`)
}

const collectRequests = async () => {
  requests.push(...await browser.evaluate('([...performance.getEntriesByType("resource").map((entry) => entry.name), ...(window.__quickMotionRequests || [])])'))
}

const openAudited = async (path) => {
  await collectRequests()
  await browser.open(path)
  await browser.waitFor('main')
  await browser.evaluate(`(() => {
    window.__quickMotionRequests = []
    const prohibited = ${forbidden.toString()}
    const originalFetch = window.fetch
    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : input.url || String(input)
      window.__quickMotionRequests.push(url)
      if (prohibited.test(url)) throw new Error('审计禁止调用付费绘图接口')
      return originalFetch.call(this, input, init)
    }
    const originalOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      window.__quickMotionRequests.push(String(url))
      if (prohibited.test(String(url))) throw new Error('审计禁止调用付费绘图接口')
      return originalOpen.call(this, method, url, ...args)
    }
  })()`)
  report(`${path} 路由落点`, await browser.url() === path)
}

const waitUntil = async (expression, timeout = 10000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await browser.evaluate(expression)) return true
    await browser.sleep(150)
  }
  return false
}

const uploadReference = async () => {
  await browser.evaluate(`(async () => {
    const response = await fetch('/art/work-seaside.jpg')
    if (!response.ok) throw new Error('本地参考图读取失败')
    const blob = await response.blob()
    const file = new File([blob], 'audit-seaside.jpg', { type: 'image/jpeg' })
    const files = new DataTransfer()
    files.items.add(file)
    const input = document.querySelector('#quick-motion-upload')
    input.files = files.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  return waitUntil('!!document.querySelector(\'canvas[aria-label="快速运镜预览"]\')?.width && !Array.from(document.querySelectorAll("button")).find((button) => button.innerText === "保存作品与预览")?.disabled')
}

try {
  mkdirSync(output, { recursive: true })
  dev = await startDevServer({ port: PORT })
  browser = await launchChrome({ port: CDP_PORT, baseUrl: dev.url, onConsoleError: (msg) => consoleErrors.push(msg) })
  await browser.setViewport(1440, 960)
  await openAudited('/tools?tool=live')
  report('默认打开免费快速运镜', (await browser.text()).includes('原图轻动 · 0 积分') && await browser.evaluate('document.querySelector("#live-tab-quick")?.getAttribute("aria-selected") === "true"'))
  await browser.click('details summary', 200)
  report('展开格式说明后明确不提供苹果原生实况', (await browser.text()).includes('当前不提供苹果原生 Live Photo'))
  await browser.click('details summary', 200)
  report('本地图片可真实上传并预览', await uploadReference())
  const sourceId = await browser.evaluate('(async () => (await import("/src/store.ts")).useStore.getState().inputImages[0]?.id)()')
  report('重复上传同一图片仍保留一个正确的参考图', await uploadReference() && await browser.evaluate(`(async () => { const state = (await import('/src/store.ts')).useStore.getState(); return state.inputImages.length === 1 && state.inputImages[0].id === ${JSON.stringify(sourceId)} })()`))
  await browser.evaluate('Array.from(document.querySelectorAll("button")).find((button) => button.innerText.startsWith("向右轻移")).click()')
  await browser.clickByText('1 秒', 200)
  await browser.clickByText('轻柔 · 2%', 200)
  await browser.clickByText('保存作品与预览')
  const resultPath = await browser.url()
  const taskId = new URLSearchParams(resultPath.split('?')[1]).get('task')
  report('保存完成后进入该作品的结果页', Boolean(taskId) && resultPath === `/result?task=${taskId}`)
  report('结果页保留免费与非苹果原生实况说明', (await browser.text()).includes('0 积分') && (await browser.text()).includes('不是苹果相册中的原生实况照片'))
  report('结果页真实运镜画布完成解码', await waitUntil('document.querySelector(\'canvas[aria-label="快速运镜预览"]\')?.width > 10'))
  const recipe = await browser.evaluate(`(async () => { const { getAllTasks } = await import('/src/lib/db.ts'); const task = (await getAllTasks()).find((item) => item.id === ${JSON.stringify(taskId)}); return { recipe: task?.quickMotion, source: task?.inputImageIds[0], output: task?.outputImages[0], status: task?.status, channel: task?.apiProfileId ?? null } })()`)
  report('IndexedDB 持久化正确原图与参数，无收费渠道', JSON.stringify(recipe.recipe) === JSON.stringify({ effect: 'pan-right', duration: 1, strength: 2 }) && recipe.source === sourceId && recipe.output === sourceId && recipe.status === 'done' && recipe.channel === null, JSON.stringify(recipe))

  await openAudited(resultPath)
  report('硬刷新结果页仍能播放已存作品', await waitUntil('document.querySelector(\'canvas[aria-label="快速运镜预览"]\')?.width > 10'))
  await openAudited('/me?tab=works')
  const card = `main a[href=${JSON.stringify(resultPath)}]`
  report('我的作品有带时长标记的运镜卡片', await browser.evaluate(`!!document.querySelector(${JSON.stringify(card)}) && document.querySelector(${JSON.stringify(card)}).innerText.includes('运镜 · 1 秒')`))
  await browser.click(card)
  report('作品卡片进入正确结果页', await browser.url() === resultPath)
  await browser.clickByText('编辑运镜')
  const editPath = `/tools?tool=live&task=${taskId}`
  report('编辑运镜进入单层工具路径', await browser.url() === editPath)
  report('编辑恢复原图及三个选中参数', await waitUntil(`(async () => {
    const state = (await import('/src/store.ts')).useStore.getState()
    const selected = Array.from(document.querySelectorAll('button[aria-pressed="true"]')).map((button) => button.innerText)
    return state.inputImages[0]?.id === ${JSON.stringify(sourceId)} && selected.some((label) => label.startsWith('向右轻移')) && selected.includes('1 秒') && selected.includes('轻柔 · 2%')
  })()`))
  // 故意污染共享草稿，再硬刷新编辑地址：应按任务恢复，不得编辑上一页的图片。
  await browser.evaluate(`(async () => {
    const { useStore } = await import('/src/store.ts')
    const { putImage } = await import('/src/lib/db.ts')
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 32
    canvas.getContext('2d').fillRect(0, 0, 32, 32)
    const image = { id: 'audit-unrelated-image', dataUrl: canvas.toDataURL() }
    await putImage(image)
    useStore.getState().setInputImages([image])
  })()`)
  await openAudited(editPath)
  const restored = await waitUntil(`(async () => (await import('/src/store.ts')).useStore.getState().inputImages[0]?.id === ${JSON.stringify(sourceId)})()`)
  report('硬刷新编辑地址恢复该任务原图而非无关草稿', restored, restored ? '' : await browser.evaluate('(async () => (await import("/src/store.ts")).useStore.getState().inputImages.map((image) => image.id).join(","))()'))

  for (const width of [1440, 390, 320]) {
    await browser.setViewport(width, 900)
    for (const [path, name] of [[editPath, 'editor'], [resultPath, 'result']]) {
      await openAudited(path)
      report(`${width}px ${name} 运镜预览实际完成`, await waitUntil('document.querySelector(\'canvas[aria-label="快速运镜预览"]\')?.width > 10'))
      if (name === 'editor') report(`${width}px 编辑页实际仍是任务原图`, await browser.evaluate(`(async () => (await import('/src/store.ts')).useStore.getState().inputImages[0]?.id === ${JSON.stringify(sourceId)})()`))
      report(`${width}px ${name} 无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'))
      writeFileSync(resolve(output, `${name}-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'))
    }
  }

  await openAudited(resultPath)
  const encoded = await browser.evaluate(`(async () => {
    const { exportQuickMotion } = await import('/src/lib/quickMotion.ts')
    const { exportLiveFrames } = await import('/src/lib/livePhoto.ts')
    const { getImage } = await import('/src/lib/db.ts')
    const image = await getImage(${JSON.stringify(sourceId)})
    const mp4Supported = ['video/mp4;codecs=avc1.42E01E', 'video/mp4'].some((type) => MediaRecorder.isTypeSupported(type))
    const outputs = []
    for (const effect of ['zoom', 'pan-left', 'pan-right', 'ai-frames']) {
      const result = effect === 'ai-frames'
        ? await exportLiveFrames([image.dataUrl, image.dataUrl, image.dataUrl], 250).then((blob) => ({ blob, extension: blob.type.startsWith('video/mp4') ? 'mp4' : 'webm' }))
        : await exportQuickMotion(image.dataUrl, { effect, duration: 1, strength: 3 })
      const url = URL.createObjectURL(result.blob)
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.preload = 'auto'
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('视频解码超时')), 8000)
          video.onloadeddata = () => { clearTimeout(timer); resolve() }
          video.onerror = () => { clearTimeout(timer); reject(new Error('视频无法解码')) }
          video.src = url
        })
        if (!Number.isFinite(video.duration)) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('视频时长读取超时')), 5000)
            video.onseeked = () => { clearTimeout(timer); resolve() }
            video.currentTime = 100000
          })
        }
        outputs.push({ effect, extension: result.extension, type: result.blob.type, bytes: result.blob.size, width: video.videoWidth, height: video.videoHeight, duration: video.duration, mp4Supported })
      } finally {
        video.removeAttribute('src')
        video.load()
        URL.revokeObjectURL(url)
      }
    }
    return outputs
  })()`)
  for (const video of encoded) {
    report(`${video.effect} 真实视频编码与扩展名一致`, video.bytes > 0 && video.type.startsWith(`video/${video.extension}`) && (video.mp4Supported ? video.extension === 'mp4' : video.extension === 'webm'), JSON.stringify(video))
    report(`${video.effect} 真实视频可解码且时长约 1 秒`, video.width > 0 && video.height > 0 && video.duration >= 0.8 && video.duration <= 1.4)
  }

  // 只构造隔离资料中的本地连续帧记录，不提交绘图请求。
  await browser.evaluate(`(async () => {
    const { useStore } = await import('/src/store.ts')
    const { putTask } = await import('/src/lib/db.ts')
    const original = useStore.getState().tasks.find((task) => task.id === ${JSON.stringify(taskId)})
    const ai = { ...original, id: 'audit-ai-live-export', prompt: '本地 AI 关键帧导出验证', professionalPreset: 'live-blink', quickMotion: undefined, outputImages: Array(3).fill(${JSON.stringify(sourceId)}), liveFrameCount: 3, liveFramesCompleted: 3 }
    await putTask(ai)
    useStore.setState({ tasks: [ai, ...useStore.getState().tasks] })
  })()`)
  for (const width of [1440, 390, 320]) {
    await browser.setViewport(width, 900)
    await openAudited('/result?task=audit-ai-live-export')
    report(`${width}px AI 实况结果完成解码`, await waitUntil('document.querySelector(\'canvas[aria-label="Live 实况预览"]\')?.width > 10'))
    const text = await browser.text()
    report(`${width}px AI 实况明确视频格式与苹果原生边界`, text.includes('优先导出 MP4') && text.includes('不是苹果相册中的原生实况照片') && text.includes('下载视频'))
    report(`${width}px AI 实况结果无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'))
    writeFileSync(resolve(output, `ai-result-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'))
  }

  const opaque = await browser.evaluate(`(async () => {
    const { drawQuickMotionFrame } = await import('/src/lib/quickMotion.ts')
    const { preloadLiveFrames } = await import('/src/lib/livePhoto.ts')
    const original = document.createElement('canvas')
    original.width = 200
    original.height = 140
    original.getContext('2d').fillStyle = '#fff'
    original.getContext('2d').fillRect(0, 0, 200, 140)
    const [image] = await preloadLiveFrames([original.toDataURL()])
    const canvas = document.createElement('canvas')
    canvas.width = 80
    canvas.height = 90
    const ctx = canvas.getContext('2d')
    for (const effect of ['zoom', 'pan-left', 'pan-right']) {
      for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
        drawQuickMotionFrame(ctx, image, { effect, duration: 1, strength: 5 }, progress)
        for (const [x, y] of [[0, 0], [79, 0], [0, 89], [79, 89], [40, 45]]) {
          if (!Array.from(ctx.getImageData(x, y, 1, 1).data).every((value) => value === 255)) return false
        }
      }
    }
    return true
  })()`)
  report('三种效果首中尾白图角落完全不透明，无暗闪或黑边', opaque)
  const invalid = await browser.evaluate(`(async () => {
    const { useStore, submitQuickMotionTask } = await import('/src/store.ts')
    const { getAllTasks } = await import('/src/lib/db.ts')
    const before = (await getAllTasks()).length
    const id = await submitQuickMotionTask({ effect: 'zoom', duration: 1, strength: 3 }, { id: 'audit-broken-image', dataUrl: 'data:image/png;base64,bm90LWEtcG5n' })
    return id === null && (await getAllTasks()).length === before && useStore.getState().tasks.every((task) => task.outputImages[0] !== 'audit-broken-image')
  })()`)
  report('真实坏图片不能保存成成功作品', invalid)
  await collectRequests()
  const paid = requests.filter((url) => forbidden.test(url))
  report('全过程 fetch / XHR 与资源请求没有绘图或 relay 调用', paid.length === 0, paid.slice(0, 3).join(' | '))
  report('没有控制台报错', consoleErrors.length === 0, consoleErrors.join(' | '))
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
