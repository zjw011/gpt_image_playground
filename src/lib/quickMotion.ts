import type { QuickMotionOptions } from '../types'
import { preloadLiveFrames } from './livePhoto'
import { recordCanvasVideo } from './canvasVideo'

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
export function exportQuickMotion(dataUrl: string, options: QuickMotionOptions, signal?: AbortSignal) {
  const opts = normalizeQuickMotionOptions(options)
  return recordCanvasVideo(
    () => preloadLiveFrames([dataUrl]),
    opts.duration * 1000,
    (ctx, images, progress) => drawQuickMotionFrame(ctx, images[0], opts, progress),
    signal,
  )
}
