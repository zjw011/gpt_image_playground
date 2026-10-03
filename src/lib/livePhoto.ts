import { recordCanvasVideo } from './canvasVideo'

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      if (!image.decode) return resolve(image)
      void image.decode().then(() => resolve(image)).catch(() => resolve(image))
    }
    image.onerror = () => reject(new Error('实况帧读取失败，请重新生成'))
    image.src = dataUrl
  })
}

/** 所有大图都完成解码后再开始播放，避免透明帧被浏览器延迟解码造成黑闪。 */
export async function preloadLiveFrames(dataUrls: string[]) {
  return Promise.all(dataUrls.map((dataUrl) => loadImage(dataUrl)))
}

/** 前帧必须不透明，后帧再覆盖；两帧同时降低 alpha 会透出底色，导致周期性暗闪。 */
export function drawLiveFrameBlend(ctx: CanvasRenderingContext2D, from: HTMLImageElement, to: HTMLImageElement, mix: number) {
  const draw = (image: HTMLImageElement, alpha: number) => {
    const scale = Math.max(ctx.canvas.width / image.naturalWidth, ctx.canvas.height / image.naturalHeight)
    const width = image.naturalWidth * scale
    const height = image.naturalHeight * scale
    ctx.globalAlpha = alpha
    ctx.drawImage(image, (ctx.canvas.width - width) / 2, (ctx.canvas.height - height) / 2, width, height)
  }
  ctx.globalAlpha = 1
  ctx.fillStyle = '#111111'
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  draw(from, 1)
  draw(to, Math.max(0, Math.min(1, mix)))
  ctx.globalAlpha = 1
}

export function createLiveFrameSequence(frameCount: number) {
  if (frameCount <= 1) return [0]
  const forward = Array.from({ length: frameCount }, (_, idx) => idx)
  return [...forward, ...forward.slice(1, -1).reverse()]
}

/** 按实际时间混合往返关键帧；AI 关键帧数不同于编码视频的 30fps 播放帧数。 */
export async function exportLiveFrames(dataUrls: string[], transitionDurationMs = 280, signal?: AbortSignal) {
  if (dataUrls.length < 2) throw new Error('至少需要两张 AI 连续帧才能生成实况视频')
  const sequence = createLiveFrameSequence(dataUrls.length)
  const transitionDuration = Number.isFinite(transitionDurationMs) ? Math.max(120, Math.min(500, transitionDurationMs)) : 280
  const result = await recordCanvasVideo(
    () => preloadLiveFrames(dataUrls),
    sequence.length * transitionDuration,
    (ctx, images, progress) => {
      const position = progress >= 1 ? 0 : progress * sequence.length
      const idx = Math.floor(position)
      drawLiveFrameBlend(ctx, images[sequence[idx]], images[sequence[(idx + 1) % sequence.length]], position - idx)
    },
    signal,
  )
  return result.blob
}
