export type LiveMotion = 'slow-zoom' | 'horizontal-pan' | 'gentle-float'

export function getLiveMotionFrame(progress: number, motion: LiveMotion) {
  const value = Math.max(0, Math.min(1, progress))
  if (motion === 'horizontal-pan') return { scale: 1.09, x: (value - 0.5) * 0.08, y: 0 }
  if (motion === 'gentle-float') return { scale: 1.055 + Math.sin(value * Math.PI) * 0.018, x: 0, y: Math.sin(value * Math.PI * 2) * 0.012 }
  return { scale: 1.02 + value * 0.09, x: 0, y: 0 }
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片读取失败，请重新上传'))
    image.src = dataUrl
  })
}

/** 把静态图制作成真实可播放、可下载的 WebM 实况短片。 */
export async function exportLivePhoto(dataUrl: string, motion: LiveMotion, durationSeconds: number) {
  if (typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持生成实况视频，请使用最新版 Chrome')

  const image = await loadImage(dataUrl)
  const maxEdge = 1280
  const ratio = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(image.naturalWidth * ratio / 2) * 2)
  canvas.height = Math.max(2, Math.round(image.naturalHeight * ratio / 2) * 2)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器无法创建视频画布')

  const stream = canvas.captureStream(30)
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type))
  if (!mimeType) throw new Error('当前浏览器不支持 WebM 视频编码')

  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 })
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }

  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.onerror = () => reject(new Error('实况视频编码失败'))
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }))
  })

  const duration = Math.max(3, Math.min(8, durationSeconds)) * 1000
  recorder.start(250)
  const startedAt = performance.now()

  await new Promise<void>((resolve) => {
    const draw = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration)
      const frame = getLiveMotionFrame(progress, motion)
      const cover = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight) * frame.scale
      const width = image.naturalWidth * cover
      const height = image.naturalHeight * cover
      const offsetX = frame.x * canvas.width
      const offsetY = frame.y * canvas.height

      ctx.fillStyle = '#111111'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(image, (canvas.width - width) / 2 + offsetX, (canvas.height - height) / 2 + offsetY, width, height)

      if (progress < 1) {
        requestAnimationFrame(draw)
        return
      }
      resolve()
    }
    requestAnimationFrame(draw)
  })

  recorder.stop()
  const blob = await finished
  for (const track of stream.getTracks()) track.stop()
  return blob
}
