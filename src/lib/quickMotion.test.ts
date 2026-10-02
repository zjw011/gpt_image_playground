// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { preloadLiveFrames } from './livePhoto'
import { drawQuickMotionFrame, exportQuickMotion, normalizeQuickMotionOptions } from './quickMotion'

vi.mock('./livePhoto', () => ({ preloadLiveFrames: vi.fn() }))

const image = { naturalWidth: 100, naturalHeight: 100 } as HTMLImageElement
const opts = { effect: 'zoom', duration: 1, strength: 3 } as const

function createContext() {
  return {
    canvas: { width: 100, height: 100 },
    globalAlpha: 0,
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  }
}

describe('快速运镜参数与连续性', () => {
  it('外部输入缺失、非法数字或效果时使用默认值', () => {
    expect(normalizeQuickMotionOptions(undefined)).toEqual({ effect: 'zoom', duration: 2, strength: 3 })
    expect(normalizeQuickMotionOptions({ effect: 'invalid', duration: NaN, strength: Infinity })).toEqual({ effect: 'zoom', duration: 2, strength: 3 })
    expect(normalizeQuickMotionOptions({ effect: 'pan-left', duration: -100, strength: 100 })).toEqual({ effect: 'pan-left', duration: 1, strength: 5 })
    expect(normalizeQuickMotionOptions({ effect: 'pan-right', duration: 100, strength: -100 })).toEqual({ effect: 'pan-right', duration: 3, strength: 2 })
  })

  it('缩放首尾完全一致，中点轻微放大且完全不透明', () => {
    const ctx = createContext()
    for (const progress of [0, 0.5, 1]) drawQuickMotionFrame(ctx as unknown as CanvasRenderingContext2D, image, opts, progress)
    expect(ctx.drawImage.mock.calls[0]).toEqual([image, 0, 0, 100, 100])
    expect(ctx.drawImage.mock.calls[1]).toEqual([image, -1.5, -1.5, 103, 103])
    expect(ctx.drawImage.mock.calls[2]).toEqual(ctx.drawImage.mock.calls[0])
    expect(ctx.globalAlpha).toBe(1)
  })

  it.each(['pan-left', 'pan-right'] as const)('%s 横移全程无黑边，起点与终点完全一致', (effect) => {
    const ctx = createContext()
    for (let idx = 0; idx <= 20; idx += 1) drawQuickMotionFrame(ctx as unknown as CanvasRenderingContext2D, image, { ...opts, effect }, idx / 20)
    for (const call of ctx.drawImage.mock.calls) {
      const [, x, y, width, height] = call
      expect(x).toBeLessThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(0)
      expect(x + width).toBeGreaterThanOrEqual(100)
      expect(y + height).toBeGreaterThanOrEqual(100)
    }
    expect(ctx.drawImage.mock.calls[20]).toEqual(ctx.drawImage.mock.calls[0])
  })

  it('任意画布比例仍覆盖全部画面，非法进度回落首帧', () => {
    const ctx = createContext()
    ctx.canvas.width = 200
    drawQuickMotionFrame(ctx as unknown as CanvasRenderingContext2D, image, opts, NaN)
    expect(ctx.drawImage).toHaveBeenCalledWith(image, 0, -50, 200, 200)
  })
})

describe('快速运镜视频导出', () => {
  let stopTrack: ReturnType<typeof vi.fn>
  let drawImage: ReturnType<typeof vi.fn>
  const supported = new Set<string>()
  const rejected = new Set<string>()
  const recorders: Recorder[] = []
  class Recorder {
    static isTypeSupported(type: string) { return supported.has(type) }
    mimeType: string
    state = 'inactive'
    ondataavailable: ((event: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(_stream: MediaStream, options: { mimeType: string }) {
      if (rejected.has(options.mimeType)) throw new Error('初始化失败')
      this.mimeType = options.mimeType
      recorders.push(this)
    }
    start() { this.state = 'recording' }
    stop() {
      this.state = 'inactive'
      this.ondataavailable?.({ data: new Blob(['video']) })
      this.onstop?.()
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    vi.stubGlobal('MediaRecorder', Recorder)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    vi.mocked(preloadLiveFrames).mockResolvedValue([image])
    supported.clear()
    rejected.clear()
    recorders.length = 0
    stopTrack = vi.fn()
    const ctx = createContext()
    drawImage = ctx.drawImage
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
      configurable: true,
      value: vi.fn(() => ({ getTracks: () => [{ stop: stopTrack }] })),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    delete (HTMLCanvasElement.prototype as Partial<HTMLCanvasElement>).captureStream
  })

  it('优先 MP4 / AVC，返回真实容器扩展名并清理轨道', async () => {
    supported.add('video/mp4;codecs=avc1.42E01E')
    supported.add('video/webm')
    const output = exportQuickMotion('data:image/png;base64,test', opts)
    await vi.advanceTimersByTimeAsync(1100)
    const result = await output
    expect(result.extension).toBe('mp4')
    expect(result.blob.type).toBe('video/mp4;codecs=avc1.42e01e')
    expect(result.blob.size).toBeGreaterThan(0)
    expect(drawImage.mock.calls.length).toBeGreaterThanOrEqual(30)
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(recorders[0].state).toBe('inactive')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('MP4 不可用时导出 WebM，不能冒充 MP4 后缀', async () => {
    supported.add('video/webm;codecs=vp8')
    const output = exportQuickMotion('data:image/png;base64,test', opts)
    await vi.advanceTimersByTimeAsync(1100)
    expect((await output).extension).toBe('webm')
    expect(stopTrack).toHaveBeenCalledOnce()
  })

  it('编码器声明支持但无法初始化时继续兼容格式', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    supported.add('video/mp4')
    supported.add('video/webm')
    rejected.add('video/mp4')
    const output = exportQuickMotion('data:image/png;base64,test', opts)
    await vi.advanceTimersByTimeAsync(1100)
    expect((await output).extension).toBe('webm')
  })

  it('不支持编码时反馈错误，释放已创建的视频轨道', async () => {
    await expect(exportQuickMotion('data:image/png;base64,test', opts)).rejects.toThrow('没有可用的')
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('预先取消不读取图片或创建轨道', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(exportQuickMotion('data:image/png;base64,test', opts, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(stopTrack).not.toHaveBeenCalled()
  })

  it('取消录制会停止编码、释放轨道且不遗留定时器', async () => {
    supported.add('video/webm')
    const controller = new AbortController()
    const output = exportQuickMotion('data:image/png;base64,test', opts, controller.signal)
    const failure = expect(output).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await failure
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(recorders[0].state).toBe('inactive')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('后台标签取消导出而不是录出长时间的跳帧视频', async () => {
    supported.add('video/webm')
    const output = exportQuickMotion('data:image/png;base64,test', opts)
    const failure = expect(output).rejects.toThrow('请保持本页面在前台')
    await vi.advanceTimersByTimeAsync(100)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await failure
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('图片解码失败可见反馈，不会创建视频轨道', async () => {
    vi.mocked(preloadLiveFrames).mockRejectedValue(new Error('实况帧读取失败'))
    await expect(exportQuickMotion('invalid', opts)).rejects.toThrow('实况帧读取失败')
    expect(stopTrack).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('图片解码不返回时由超时结束，避免永久等待', async () => {
    vi.mocked(preloadLiveFrames).mockReturnValue(new Promise(() => undefined))
    const output = exportQuickMotion('invalid', opts)
    const failure = expect(output).rejects.toThrow('图片读取超时')
    await vi.advanceTimersByTimeAsync(15001)
    await failure
    expect(vi.getTimerCount()).toBe(0)
  })

  it('编码器错误结束录制并清理所有资源', async () => {
    supported.add('video/webm')
    const output = exportQuickMotion('data:image/png;base64,test', opts)
    const failure = expect(output).rejects.toThrow('视频编码失败')
    await vi.advanceTimersByTimeAsync(100)
    recorders[0].onerror?.()
    await failure
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
