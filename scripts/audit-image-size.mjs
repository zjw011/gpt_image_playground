// 参考图大小回归：自带服务和隔离 Chrome，只使用本地合成素材，不调用绘图接口。
import { launchChrome } from './lib/cdp.mjs'
import { startDevServer } from './lib/devServer.mjs'

let dev
let browser
let failed = 0
let checked = 0
const errors = []
const report = (label, ok) => {
  checked++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failed++
}

try {
  dev = await startDevServer({ port: 5192 })
  browser = await launchChrome({ port: 9432, baseUrl: dev.url, onConsoleError: (line) => errors.push(line) })
  await browser.open('/studio')
  if (!await browser.waitFor('textarea', 15000)) throw new Error('创作页未就绪')
  report('创作页路由', await browser.url() === '/studio')

  // 确定性噪声避免纯色图片压缩率过高、没有实际走到大图处理分支。
  await browser.evaluate(`(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 3200
    canvas.height = 2400
    const ctx = canvas.getContext('2d')
    const pixels = ctx.createImageData(canvas.width, canvas.height)
    let seed = 123456789
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      pixels.data[i] = seed & 255
      pixels.data[i + 1] = (seed >>> 8) & 255
      pixels.data[i + 2] = (seed >>> 16) & 255
      pixels.data[i + 3] = 255
    }
    ctx.putImageData(pixels, 0, 0)
    ctx.clearRect(0, 0, 96, 96)
    window.sizeAuditCanvas = canvas
  })()`)

  for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
    const result = await browser.evaluate(`(async () => {
      const { prepareReferenceImages, REFERENCE_IMAGE_TARGET_BYTES } = await import('/src/lib/referenceImages.ts')
      const { getDataUrlDecodedByteSize } = await import('/src/lib/imageApiShared.ts')
      const { loadImage } = await import('/src/lib/canvasImage.ts')
      const mime = ${JSON.stringify(mime)}
      const original = window.sizeAuditCanvas.toDataURL(mime, 1)
      const input = [original]
      const output = await prepareReferenceImages(input)
      const image = await loadImage(output[0])
      const sample = document.createElement('canvas')
      sample.width = 1
      sample.height = 1
      const ctx = sample.getContext('2d')
      ctx.drawImage(image, 0, 0)
      const mask = await prepareReferenceImages(input, 'data:image/png;base64,mask-audit')
      return {
        actualMime: original.slice(0, original.indexOf(';')),
        sourceBytes: getDataUrlDecodedByteSize(original),
        outputBytes: getDataUrlDecodedByteSize(output[0]),
        target: REFERENCE_IMAGE_TARGET_BYTES,
        width: image.naturalWidth,
        height: image.naturalHeight,
        alpha: ctx.getImageData(0, 0, 1, 1).data[3],
        sourceUnchanged: input.length === 1 && input[0] === original,
        hasCopy: output[0] !== original,
        maskUnchanged: mask === input && mask[0] === original,
        outputMime: output[0].slice(0, output[0].indexOf(';')),
      }
    })()`)
    console.log(`${mime} ${JSON.stringify(result)}`)
    report(`${mime} 实际大图进入压缩分支`, result.actualMime === `data:${mime}` && result.sourceBytes > result.target && result.hasCopy)
    report(`${mime} 压缩副本不超过 4 MiB`, result.outputBytes > 0 && result.outputBytes <= result.target)
    report(`${mime} 长边和比例正确`, Math.max(result.width, result.height) <= 2560 && Math.abs(result.width - result.height * 4 / 3) <= 1)
    report(`${mime} 原参考值不变`, result.sourceUnchanged)
    report(`${mime} 有遮罩时保持原值和坐标`, result.maskUnchanged)
    if (mime !== 'image/jpeg') report(`${mime} 透明区域保留`, result.outputMime === 'data:image/png' && result.alpha === 0)
  }

  const upload = await browser.evaluate(`(async () => {
    const store = await import('/src/store.ts')
    const { getImage, putTask } = await import('/src/lib/db.ts')
    const { DEFAULT_PARAMS } = await import('/src/types.ts')
    const blob = await (await fetch('/art/work-cat.jpg')).blob()
    const reference = await store.createInputImageFromFile(new File([blob], 'original.jpg', { type: 'image/jpeg' }))
    store.useStore.getState().setInputImages([reference])
    const original = await getImage(reference.id)
    const file = new File(['oversize-test'], 'large.png', { type: 'image/png' })
    Object.defineProperty(file, 'size', { value: 51 * 1024 * 1024 })
    const read = FileReader.prototype.readAsDataURL
    let reads = 0
    let message = ''
    FileReader.prototype.readAsDataURL = function (...args) { reads++; return read.apply(this, args) }
    try {
      await store.createInputImageFromFile(file)
    } catch (err) {
      message = err.message
    } finally {
      FileReader.prototype.readAsDataURL = read
    }
    const task = {
      id: 'size-audit-failure', prompt: '参考图大小专项测试', params: { ...DEFAULT_PARAMS },
      inputImageIds: [reference.id], outputImages: [], status: 'error', createdAt: Date.now(),
      error: 'HTTP 400: {"error":{"message":"invalid request: file too large","type":"invalid_request_error"}}',
    }
    await putTask(task)
    store.useStore.getState().setTasks([task])
    sessionStorage.setItem('size-audit-reference', reference.id)
    return {
      reads, message,
      referenceRetained: store.useStore.getState().inputImages[0].id === reference.id,
      originalRetained: (await getImage(reference.id)).dataUrl === original.dataUrl,
    }
  })()`)
  report('超过 50 MiB 读取前拒绝', upload.reads === 0 && upload.message.includes('50 MB') && upload.message.includes('参考图片过大'))
  report('拒绝上传后保留原参考和存储原图', upload.referenceRetained && upload.originalRetained)

  await browser.open('/result?task=size-audit-failure')
  if (!await browser.waitFor('main', 15000)) throw new Error('结果页未就绪')
  report('失败结果页精确路由', await browser.url() === '/result?task=size-audit-failure')
  report('历史失败任务显示中文大小提示', (await browser.text()).includes('参考图片过大，请调整后再试'))
  report('历史失败任务提供调整参考入口', (await browser.text()).includes('返回调整参考图'))
  for (const width of [1440, 390, 320]) {
    await browser.setViewport(width, 900)
    report(`结果页 ${width}px 无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
    const buttonSize = await browser.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find((button) => button.innerText.trim() === '返回调整参考图')
      return button ? { height: button.getBoundingClientRect().height, width: button.getBoundingClientRect().width } : null
    })()`)
    console.log(`结果页 ${width}px 调整按钮 ${JSON.stringify(buttonSize)}`)
    report(`结果页 ${width}px 调整按钮至少 44px`, buttonSize && buttonSize.height >= 44)
  }

  // 拦截所有业务请求作为保险，检查返回编辑不能悄悄重新生成或扣积分。
  await browser.evaluate(`(() => {
    const originalFetch = window.fetch
    window.sizeAuditApiCalls = []
    window.fetch = function (input, init) {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/api/') || url.includes('/v1/') || url.includes('/images/') || url.includes('/responses')) {
        window.sizeAuditApiCalls.push(url)
        return Promise.reject(new Error('大小审计禁止实际 API 调用'))
      }
      return originalFetch.call(this, input, init)
    }
  })()`)
  report('点击返回调整参考图', await browser.clickByText('返回调整参考图') === 'clicked')
  if (!await browser.waitFor('textarea', 15000)) throw new Error('未返回创作编辑器')
  report('返回图生图编辑页精确路由', await browser.url() === '/studio?mode=image')
  report('返回编辑没有绘图或积分请求', await browser.evaluate('window.sizeAuditApiCalls.length === 0'))
  report('返回编辑恢复原任务参考图', await browser.evaluate(`(async () => {
    const { useStore } = await import('/src/store.ts')
    const state = useStore.getState()
    return state.inputImages.length === 1 && state.inputImages[0].id === sessionStorage.getItem('size-audit-reference') && state.prompt === '参考图大小专项测试'
  })()`))
  for (const width of [1440, 390, 320]) {
    await browser.setViewport(width, 900)
    report(`创作页 ${width}px 无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
  }
  report('无控制台错误', errors.length === 0)
  if (errors.length) console.log(errors)
  console.log(`图片大小专项结束：${checked} 项检查，${failed} 项失败。真实浏览器合成图片与模拟超限文件，不调用外部绘图接口；手机宽度不等同于真机验收。`)
} catch (err) {
  failed++
  console.error(err)
} finally {
  await browser?.close()
  await dev?.stop()
}
process.exitCode = failed ? 1 : 0
