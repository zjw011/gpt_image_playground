import type { QuickMotionOptions } from '../types'
import { preloadLiveFrames } from './livePhoto'

export function normalizeQuickMotionOptions(value: unknown): QuickMotionOptions {
  const opts = value && typeof value === 'object' ? value as Partial<QuickMotionOptions> : {}
  return {
    effect: opts.effect === 'pan-left' || opts.effect === 'pan-right' ? opts.effect : 'zoom',
    duration: typeof opts.duration === 'number' && Number.isFinite(opts.duration) ? Math.max(1, Math.min(3, opts.duration)) : 2,
    strength: typeof opts.strength === 'number' && Number.isFinite(opts.strength) ? Math.max(2, Math.min(5, opts.strength)) : 3,
  }
}

/** 余弦往返保证首尾位置与速度一致；横移预裁切，边缘始终覆盖画布。 */
export function drawQuickMotionFrame(ctx: CanvasRenderingContext2D, image: HTMLImageElement, options: QuickMotionOptions, progress: number) {
  const opts = normalizeQuickMotionOptions(options)
  const phase = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0
  const wave = (1 - Math.cos(phase * Math.PI * 2)) / 2
  const strength = opts.strength / 100
  const scale = Math.max(ctx.canvas.width / image.naturalWidth, ctx.canvas.height / image.naturalHeight)
    * (1 + strength * (opts.effect === 'zoom' ? wave : 1))
  const width = image.naturalWidth * scale
  const height = image.naturalHeight * scale
  const shift = opts.effect === 'zoom' ? 0 : (opts.effect === 'pan-left' ? -1 : 1)
    * Math.min((width - ctx.canvas.width) / 2, ctx.canvas.width * strength / 2) * wave
  ctx.globalAlpha = 1
  ctx.fillStyle = '#111111'
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.drawImage(image, (ctx.canvas.width - width) / 2 + shift, (ctx.canvas.height - height) / 2, width, height)
}

/** 使用真实编码格式导出短视频；它不是苹果相册的原生 Live Photo 配对文件。 */
export function exportQuickMotion(dataUrl: string, options: QuickMotionOptions, signal?: AbortSignal): Promise<{ blob: Blob; extension: 'mp4' | 'webm' }> {
  const opts = normalizeQuickMotionOptions(options)
  return new Promise((resolve, reject) => {
    let settled = false
    let stopping = false
    let recorder: MediaRecorder | undefined
    let stream: MediaStream | undefined
    let frameTimer: ReturnType<typeof setTimeout> | undefined
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const chunks: Blob[] = []
    const cleanup = () => {
      clearTimeout(frameTimer)
      clearTimeout(deadlineTimer)
      signal?.removeEventListener('abort', abort)
      document.removeEventListener('visibilitychange', visibility)
      if (recorder) {
        recorder.ondataavailable = null
        recorder.onstop = null
        recorder.onerror = null
        if (recorder.state !== 'inactive') {
          try { recorder.stop() } catch (err) { console.warn('快速运镜编码清理失败', err) }
        }
      }
      for (const track of stream?.getTracks() || []) track.stop()
    }
    const fail = (err: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err instanceof Error || err instanceof DOMException ? err : new Error('快速运镜导出失败'))
    }
    const abort = () => fail(new DOMException('导出已取消', 'AbortError'))
    const visibility = () => {
      // 后台标签的定时器会被节流，继续录制会把几秒短片拖长并跳帧。
      if (document.hidden) fail(new Error('导出已中止，请保持本页面在前台后重新导出'))
    }
    if (signal?.aborted) return abort()
    if (typeof MediaRecorder === 'undefined') return fail(new Error('当前浏览器不支持视频导出，请使用支持录制的最新版浏览器'))
    if (document.hidden) return fail(new Error('请保持本页面在前台后导出视频'))
    signal?.addEventListener('abort', abort, { once: true })
    document.addEventListener('visibilitychange', visibility)
    deadlineTimer = setTimeout(() => fail(new Error('图片读取超时，请重新选择图片')), 15000)
    void preloadLiveFrames([dataUrl]).then(([image]) => {
      if (settled) return
      if (!image.naturalWidth || !image.naturalHeight) return fail(new Error('图片尺寸无效，请重新选择图片'))
      const canvas = document.createElement('canvas')
      if (typeof canvas.captureStream !== 'function') return fail(new Error('当前浏览器不支持画布视频录制'))
      const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight))
      canvas.width = Math.max(2, Math.round(image.naturalWidth * scale / 2) * 2)
      canvas.height = Math.max(2, Math.round(image.naturalHeight * scale / 2) * 2)
      const ctx = canvas.getContext('2d')
      if (!ctx) return fail(new Error('浏览器无法创建视频画布'))
      drawQuickMotionFrame(ctx, image, opts, 0)
      stream = canvas.captureStream(30)
      const formats = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      for (const mimeType of formats) {
        if (!MediaRecorder.isTypeSupported(mimeType)) continue
        try {
          recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 })
          break
        } catch (err) { console.warn('浏览器无法初始化此视频编码，尝试兼容格式', err) }
      }
      if (!recorder) return fail(new Error('当前浏览器没有可用的 MP4 / WebM 视频编码器'))
      const mimeType = recorder.mimeType
      const extension = mimeType.startsWith('video/mp4') ? 'mp4' : mimeType.startsWith('video/webm') ? 'webm' : null
      if (!extension) return fail(new Error('浏览器返回了不支持的视频格式'))
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
      recorder.onerror = () => fail(new Error('视频编码失败，请重新导出'))
      recorder.onstop = () => {
        if (settled) return
        if (!stopping) return fail(new Error('视频录制意外中断，请重新导出'))
        const blob = new Blob(chunks, { type: mimeType })
        if (!blob.size) return fail(new Error('浏览器没有输出视频数据，请重新导出'))
        settled = true
        cleanup()
        resolve({ blob, extension })
      }
      clearTimeout(deadlineTimer)
      deadlineTimer = setTimeout(() => fail(new Error('视频导出超时，请保持页面在前台后重试')), opts.duration * 1000 + 10000)
      recorder.start(250)
      const started = performance.now()
      const render = () => {
        if (settled) return
        try {
          const progress = Math.min(1, (performance.now() - started) / (opts.duration * 1000))
          drawQuickMotionFrame(ctx, image, opts, progress)
          if (progress >= 1) {
            stopping = true
            recorder!.stop()
            return
          }
          frameTimer = setTimeout(render, 1000 / 30)
        } catch (err) { fail(err) }
      }
      render()
    }).catch(fail)
  })
}
