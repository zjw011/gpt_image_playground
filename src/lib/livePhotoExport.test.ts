// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordCanvasVideo } from './canvasVideo'
import { exportLiveFrames } from './livePhoto'

vi.mock('./canvasVideo', () => ({ recordCanvasVideo: vi.fn() }))

describe('AI 实况视频共用编码与连续时间轴', () => {
  beforeEach(() => vi.mocked(recordCanvasVideo).mockReset())

  it.each(['mp4', 'webm'] as const)('返回实际 %s 容器，传递取消信号与完整往返时长', async (extension) => {
    const controller = new AbortController()
    const blob = new Blob(['video'], { type: `video/${extension}` })
    vi.mocked(recordCanvasVideo).mockResolvedValue({ blob, extension })
    expect(await exportLiveFrames(['frame-0', 'frame-1', 'frame-2'], 280, controller.signal)).toBe(blob)
    expect(recordCanvasVideo).toHaveBeenCalledWith(expect.any(Function), 1120, expect.any(Function), controller.signal)
  })

  it('连续时间轴首尾相同，过渡始终有不透明底帧', async () => {
    vi.mocked(recordCanvasVideo).mockResolvedValue({ blob: new Blob(['video']), extension: 'webm' })
    await exportLiveFrames(['frame-0', 'frame-1', 'frame-2'])
    const draw = vi.mocked(recordCanvasVideo).mock.calls[0][2]
    const images = Array.from({ length: 3 }, () => ({ naturalWidth: 100, naturalHeight: 100 }) as HTMLImageElement)
    const alphas: number[] = []
    const ctx = {
      canvas: { width: 100, height: 100 }, globalAlpha: 1, fillStyle: '', fillRect: vi.fn(),
      drawImage: vi.fn(() => alphas.push(ctx.globalAlpha)),
    }
    const calls = []
    for (const progress of [0, 0.125, 0.25, 0.5, 0.75, 1]) {
      draw(ctx as unknown as CanvasRenderingContext2D, images, progress)
      calls.push(ctx.drawImage.mock.calls.slice(-2))
    }
    expect(calls[5]).toEqual(calls[0])
    expect(alphas).toEqual([1, 0, 1, 0.5, 1, 0, 1, 0, 1, 0, 1, 0])
  })

  it.each([[NaN, 1120], [Infinity, 1120], [-10, 480], [10000, 2000]])('外部过渡时长 %s 被规范为安全的录制时长', async (input, expected) => {
    vi.mocked(recordCanvasVideo).mockResolvedValue({ blob: new Blob(['video']), extension: 'webm' })
    await exportLiveFrames(['frame-0', 'frame-1', 'frame-2'], input)
    expect(vi.mocked(recordCanvasVideo).mock.calls[0][1]).toBe(expected)
  })

  it('不足两帧时不启动编码', async () => {
    await expect(exportLiveFrames(['frame-0'])).rejects.toThrow('至少需要两张')
    expect(recordCanvasVideo).not.toHaveBeenCalled()
  })
})
