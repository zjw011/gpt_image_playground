import { useEffect, useRef, useState } from 'react'
import { createLiveFrameSequence, drawLiveFrameBlend, preloadLiveFrames } from '../lib/livePhoto'

export default function LivePhotoPlayer({ frames }: { frames: string[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const positionRef = useRef(0)
  const [playing, setPlaying] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => { positionRef.current = 0 }, [frames])

  useEffect(() => {
    let active = true
    let animation = 0
    setError('')
    void preloadLiveFrames(frames).then((images) => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!active || !canvas || !ctx || !images.length) return
      const first = images[0]
      const scale = Math.min(1, 1280 / Math.max(first.naturalWidth, first.naturalHeight))
      canvas.width = Math.max(1, Math.round(first.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(first.naturalHeight * scale))
      const sequence = createLiveFrameSequence(images.length)
      const initialPosition = positionRef.current
      let started = 0
      const render = (now: number) => {
        if (!active) return
        if (!started) started = now
        const position = initialPosition + (playing ? (now - started) / 280 : 0)
        positionRef.current = position
        const idx = Math.floor(position) % sequence.length
        drawLiveFrameBlend(ctx, images[sequence[idx]], images[sequence[(idx + 1) % sequence.length]], position % 1)
        if (playing) animation = requestAnimationFrame(render)
      }
      animation = requestAnimationFrame(render)
    }).catch((err) => {
      if (active) setError(err instanceof Error ? err.message : '实况帧加载失败')
    })
    return () => {
      active = false
      cancelAnimationFrame(animation)
    }
  }, [frames, playing])

  return (
    <div className="relative flex h-[62vh] max-h-[720px] w-full items-center justify-center overflow-hidden rounded-2xl bg-[#111] shadow-lg">
      <canvas ref={canvasRef} aria-label="Live 实况预览" className="max-h-full max-w-full object-contain" />
      {error && <p role="alert" className="absolute rounded-xl bg-black/80 px-4 py-3 text-sm text-white">{error}</p>}
      <span className="absolute left-4 top-4 rounded-full bg-black/55 px-3 py-1.5 text-[11px] font-semibold text-white backdrop-blur">LIVE · {frames.length} AI 关键帧</span>
      <button type="button" onClick={() => setPlaying((value) => !value)} className="absolute bottom-4 right-4 rounded-full bg-black/60 px-4 py-2 text-xs font-semibold text-white hover:bg-black/80">{playing ? '暂停播放' : '播放实况'}</button>
    </div>
  )
}
