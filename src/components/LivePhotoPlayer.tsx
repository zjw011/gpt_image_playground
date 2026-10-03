import { useEffect, useRef, useState } from 'react'
import { createLiveFrameSequence, drawLiveFrameBlend, preloadLiveFrames } from '../lib/livePhoto'

export default function LivePhotoPlayer({ frames }: { frames: string[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imagesRef = useRef<HTMLImageElement[]>([])
  const positionRef = useRef(0)
  const [playing, setPlaying] = useState(() => typeof matchMedia !== 'function' || !matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      if (!active) return
      active = false
      setError('实况帧读取超时，请重新打开作品')
    }, 15000)
    positionRef.current = 0
    imagesRef.current = []
    setReady(false)
    setError('')
    void preloadLiveFrames(frames).then((images) => {
      if (!active) return
      clearTimeout(timer)
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) throw new Error('浏览器无法创建预览画布')
      if (!images.length || images.some((image) => !image.naturalWidth || !image.naturalHeight)) throw new Error('实况帧尺寸无效，请重新生成')
      const image = images[0]
      const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight))
      canvas.width = Math.max(2, Math.round(image.naturalWidth * scale))
      canvas.height = Math.max(2, Math.round(image.naturalHeight * scale))
      imagesRef.current = images
      setReady(true)
    }).catch((err) => {
      clearTimeout(timer)
      if (active) setError(err instanceof Error ? err.message : '图片读取失败')
    })
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [frames])

  useEffect(() => {
    const images = imagesRef.current
    const ctx = canvasRef.current?.getContext('2d')
    if (!ready || !images.length || !ctx) return
    const sequence = createLiveFrameSequence(images.length)
    let animation = 0
    let previous = 0
    const draw = () => {
      const position = positionRef.current % sequence.length
      const idx = Math.floor(position)
      drawLiveFrameBlend(ctx, images[sequence[idx]], images[sequence[(idx + 1) % sequence.length]], position % 1)
    }
    const render = (now: number) => {
      if (document.hidden) return
      if (previous && playing) positionRef.current += (now - previous) / 280
      previous = now
      draw()
      if (playing) animation = requestAnimationFrame(render)
    }
    const visibility = () => {
      cancelAnimationFrame(animation)
      previous = 0
      if (!document.hidden) animation = requestAnimationFrame(render)
    }
    draw()
    if (playing && !document.hidden) animation = requestAnimationFrame(render)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      cancelAnimationFrame(animation)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [ready, frames, playing])

  const first = imagesRef.current[0]
  return (
    <div style={{ aspectRatio: ready && first ? `${first.naturalWidth} / ${first.naturalHeight}` : '1' }} className="relative mx-auto flex min-h-36 max-h-[48vh] w-full items-center justify-center overflow-hidden rounded-2xl bg-[#111] shadow-lg sm:h-[62vh] sm:max-h-[640px]">
      <canvas ref={canvasRef} aria-label="Live 实况预览" className="max-h-full max-w-full object-contain" />
      {!ready && !error && <p role="status" className="absolute text-sm text-white/75">正在读取实况帧…</p>}
      {error && <p role="alert" className="absolute rounded-xl bg-black/80 px-4 py-3 text-sm text-white">{error}</p>}
      <span className="absolute left-4 top-4 rounded-full bg-black/55 px-3 py-1.5 text-[11px] font-semibold text-white backdrop-blur">LIVE · {frames.length} AI 关键帧</span>
      <button type="button" disabled={!ready || Boolean(error)} aria-pressed={playing} onClick={() => setPlaying((value) => !value)} className="absolute bottom-4 right-4 min-h-11 rounded-full bg-black/60 px-4 py-2 text-xs font-semibold text-white hover:bg-black/80 disabled:opacity-50">{playing ? '暂停播放' : '播放实况'}</button>
    </div>
  )
}
