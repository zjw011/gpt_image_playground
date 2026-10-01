import { describe, expect, it, vi } from 'vitest'
import { createLiveFrameSequence, drawLiveFrameBlend } from './livePhoto'

describe('Live 混合亮度', () => {
  it('保持前帧完全不透明，避免相同白色帧过渡时透出黑底', () => {
    const alphas: number[] = []
    const ctx = {
      canvas: { width: 100, height: 100 },
      globalAlpha: 1,
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(() => { alphas.push(ctx.globalAlpha) }),
    }
    const frame = { naturalWidth: 100, naturalHeight: 100 } as HTMLImageElement
    drawLiveFrameBlend(ctx as unknown as CanvasRenderingContext2D, frame, frame, 0.5)
    expect(alphas).toEqual([1, 0.5])
    // 不透明底帧与叠加帧合成后覆盖率恒为 1。
    expect(alphas[1] + alphas[0] * (1 - alphas[1])).toBe(1)
    expect(ctx.globalAlpha).toBe(1)
  })
})

describe('createLiveFrameSequence', () => {
  it('让 AI 关键帧往返播放，避免结尾突然跳回开头', () => {
    expect(createLiveFrameSequence(6)).toEqual([0, 1, 2, 3, 4, 5, 4, 3, 2, 1])
  })

  it('没有足够帧时安全回落到首帧', () => {
    expect(createLiveFrameSequence(0)).toEqual([0])
    expect(createLiveFrameSequence(1)).toEqual([0])
  })
})
