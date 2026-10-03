/** 两种实况模式共用录制生命周期；普通视频不包含苹果 Live Photo 配对元数据。 */
export function recordCanvasVideo(
  load: () => Promise<HTMLImageElement[]>,
  durationMs: number,
  draw: (ctx: CanvasRenderingContext2D, images: HTMLImageElement[], progress: number) => void,
  signal?: AbortSignal,
): Promise<{ blob: Blob; extension: 'mp4' | 'webm' }> {
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
          try { recorder.stop() } catch (err) { console.warn('视频编码清理失败', err) }
        }
      }
      for (const track of stream?.getTracks() || []) track.stop()
    }
    const fail = (err: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err instanceof Error || err instanceof DOMException ? err : new Error('视频导出失败'))
    }
    const abort = () => fail(new DOMException('导出已取消', 'AbortError'))
    const visibility = () => {
      // 后台标签会节流定时器，继续录制会把几秒短片拖长并跳帧。
      if (document.hidden) fail(new Error('导出已中止，请保持本页面在前台后重新导出'))
    }
    if (signal?.aborted) return abort()
    if (typeof MediaRecorder === 'undefined') return fail(new Error('当前浏览器不支持视频导出，请使用支持录制的最新版浏览器'))
    if (document.hidden) return fail(new Error('请保持本页面在前台后导出视频'))
    signal?.addEventListener('abort', abort, { once: true })
    document.addEventListener('visibilitychange', visibility)
    deadlineTimer = setTimeout(() => fail(new Error('图片读取超时，请重新选择图片')), 15000)
    void Promise.resolve().then(load).then((images) => {
      if (settled) return
      if (!images.length || images.some((image) => !image.naturalWidth || !image.naturalHeight)) return fail(new Error('图片尺寸无效，请重新选择图片'))
      const image = images[0]
      const canvas = document.createElement('canvas')
      if (typeof canvas.captureStream !== 'function') return fail(new Error('当前浏览器不支持画布视频录制'))
      const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight))
      canvas.width = Math.max(2, Math.round(image.naturalWidth * scale / 2) * 2)
      canvas.height = Math.max(2, Math.round(image.naturalHeight * scale / 2) * 2)
      const ctx = canvas.getContext('2d')
      if (!ctx) return fail(new Error('浏览器无法创建视频画布'))
      draw(ctx, images, 0)
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
      deadlineTimer = setTimeout(() => fail(new Error('视频导出超时，请保持页面在前台后重试')), durationMs + 10000)
      recorder.start(250)
      const started = performance.now()
      const render = () => {
        if (settled) return
        try {
          const progress = Math.min(1, (performance.now() - started) / durationMs)
          draw(ctx, images, progress)
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
