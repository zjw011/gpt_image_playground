import { useEffect, useMemo, useRef, useState } from 'react'
import type { QuickMotionOptions } from '../types'
import { preloadLiveFrames } from '../lib/livePhoto'
import { drawQuickMotionFrame, normalizeQuickMotionOptions } from '../lib/quickMotion'

export default function QuickMotionPlayer({ src, options }: { src: string; options: QuickMotionOptions }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const positionRef = useRef(0)
  const opts = useMemo(() => normalizeQuickMotionOptions(options), [options.effect, options.duration, options.strength])
  const [playing, setPlaying] = useState(() => typeof matchMedia !== 'function' || !matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      if (!active) return
      active = false
      setError('图片读取超时，请重新选择图片')
    }, 15000)
    positionRef.current = 0
    imageRef.current = null
    setReady(false)
    setError('')
    void preloadLiveFrames([src]).then(([image]) => {
      if (!active) return
      clearTimeout(timer)
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) throw new Error('浏览器无法创建预览画布')
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片尺寸无效，请重新选择图片')
      const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight))
      canvas.width = Math.max(2, Math.round(image.naturalWidth * scale))
      canvas.height = Math.max(2, Math.round(image.naturalHeight * scale))
      imageRef.current = image
      setReady(true)
    }).catch((err) => {
      clearTimeout(timer)
      if (active) setError(err instanceof Error ? err.message : '图片读取失败')
    })
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [src])

  useEffect(() => {
    const image = imageRef.current
    const ctx = canvasRef.current?.getContext('2d')
    if (!ready || !image || !ctx) return
    let animation = 0
    let previous = 0
    const render = (now: number) => {
      if (document.hidden) return
      if (previous && playing) positionRef.current += (now - previous) / (opts.duration * 1000)
      previous = now
      drawQuickMotionFrame(ctx, image, opts, positionRef.current % 1)
      if (playing) animation = requestAnimationFrame(render)
    }
    const visibility = () => {
      cancelAnimationFrame(animation)
      previous = 0
      if (!document.hidden) animation = requestAnimationFrame(render)
    }
    drawQuickMotionFrame(ctx, image, opts, positionRef.current % 1)
    if (playing && !document.hidden) animation = requestAnimationFrame(render)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      cancelAnimationFrame(animation)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [ready, src, opts, playing])

  return (
    <div style={{ aspectRatio: ready && imageRef.current ? `${imageRef.current.naturalWidth} / ${imageRef.current.naturalHeight}` : '1' }} className="relative mx-auto flex min-h-36 max-h-[48vh] w-full items-center justify-center overflow-hidden rounded-2xl bg-[#111] shadow-lg sm:h-[62vh] sm:max-h-[640px]">
      <canvas ref={canvasRef} aria-label="快速运镜预览" className="max-h-full max-w-full object-contain" />
      {!ready && !error && <p role="status" className="absolute text-sm text-white/75">正在读取图片…</p>}
      {error && <p role="alert" className="absolute rounded-xl bg-black/80 px-4 py-3 text-sm text-white">{error}</p>}
      <span className="absolute left-4 top-4 rounded-full bg-black/55 px-3 py-1.5 text-[11px] font-semibold text-white backdrop-blur">快速运镜 · {opts.duration} 秒 · 本地生成</span>
      <button type="button" disabled={!ready || Boolean(error)} aria-pressed={playing} onClick={() => setPlaying((value) => !value)} className="absolute bottom-4 right-4 min-h-11 rounded-full bg-black/60 px-4 py-2 text-xs font-semibold text-white hover:bg-black/80 disabled:opacity-50">{playing ? '暂停播放' : '播放运镜'}</button>
    </div>
  )
}
