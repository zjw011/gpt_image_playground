function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('实况帧读取失败，请重新生成'))
    image.src = dataUrl
  })
}

export function createLiveFrameSequence(frameCount: number) {
  if (frameCount <= 1) return [0]
  const forward = Array.from({ length: frameCount }, (_, idx) => idx)
  return [...forward, ...forward.slice(1, -1).reverse()]
}

/** 把 AI 生成的连续帧按往返顺序合成为可播放、可下载的 WebM 实况短片。 */
export async function exportLiveFrames(dataUrls: string[], transitionDurationMs = 200) {
  if (dataUrls.length < 2) throw new Error('至少需要两张 AI 连续帧才能生成实况视频')
  if (typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持生成实况视频，请使用最新版 Chrome')

  const images = await Promise.all(dataUrls.map((dataUrl) => loadImage(dataUrl)))
  const first = images[0]
  const maxEdge = 1280
  const ratio = Math.min(1, maxEdge / Math.max(first.naturalWidth, first.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(first.naturalWidth * ratio / 2) * 2)
  canvas.height = Math.max(2, Math.round(first.naturalHeight * ratio / 2) * 2)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器无法创建视频画布')

  const stream = canvas.captureStream(30)
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type))
  if (!mimeType) {
    for (const track of stream.getTracks()) track.stop()
    throw new Error('当前浏览器不支持 WebM 视频编码')
  }

  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 })
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.onerror = () => reject(new Error('实况视频编码失败'))
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }))
  })

  const sequence = createLiveFrameSequence(images.length)
  const transitionDuration = Math.max(120, Math.min(500, transitionDurationMs))
  const draw = (image: HTMLImageElement, alpha: number) => {
    const cover = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight)
    const width = image.naturalWidth * cover
    const height = image.naturalHeight * cover
    ctx.globalAlpha = alpha
    ctx.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
  }
  recorder.start(250)
  try {
    for (let idx = 0; idx < sequence.length - 1; idx += 1) {
      const from = images[sequence[idx]]
      const to = images[sequence[idx + 1]]
      const steps = Math.max(3, Math.round(transitionDuration / (1000 / 30)))
      for (let step = 0; step < steps; step += 1) {
        const mix = step / steps
        ctx.globalAlpha = 1
        ctx.fillStyle = '#111111'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        draw(from, 1 - mix)
        draw(to, mix)
        ctx.globalAlpha = 1
        await new Promise((resolve) => window.setTimeout(resolve, transitionDuration / steps))
      }
    }
    ctx.globalAlpha = 1
    ctx.fillStyle = '#111111'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    draw(images[sequence[sequence.length - 1]], 1)
    await new Promise((resolve) => window.setTimeout(resolve, transitionDuration))
    recorder.stop()
    return await finished
  } finally {
    if (recorder.state !== 'inactive') recorder.stop()
    for (const track of stream.getTracks()) track.stop()
  }
}
