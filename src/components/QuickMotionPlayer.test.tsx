// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { preloadLiveFrames } from '../lib/livePhoto'
import { drawQuickMotionFrame } from '../lib/quickMotion'
import QuickMotionPlayer from './QuickMotionPlayer'

vi.mock('../lib/livePhoto', () => ({ preloadLiveFrames: vi.fn() }))
vi.mock('../lib/quickMotion', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/quickMotion')>()
  return { ...original, drawQuickMotionFrame: vi.fn() }
})

const opts = { effect: 'zoom', duration: 2, strength: 3 } as const
const image = { naturalWidth: 100, naturalHeight: 100 } as HTMLImageElement
let el: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
  vi.mocked(preloadLiveFrames).mockReset().mockResolvedValue([image])
  vi.mocked(drawQuickMotionFrame).mockClear()
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
})

afterEach(async () => {
  await act(async () => root.unmount())
  el.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('快速运镜预览', () => {
  it('预先完整解码后播放，可暂停和继续播放', async () => {
    await act(async () => root.render(<QuickMotionPlayer src="first" options={opts} />))
    const button = el.querySelector('button')!
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe('暂停播放')
    expect(el.querySelector('canvas')?.getAttribute('aria-label')).toBe('快速运镜预览')
    await act(async () => button.click())
    expect(button.textContent).toBe('播放运镜')
    await act(async () => button.click())
    expect(button.textContent).toBe('暂停播放')
  })

  it('遵循系统减少动态偏好，首帧静止直到手动播放', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    await act(async () => root.render(<QuickMotionPlayer src="first" options={opts} />))
    expect(el.querySelector('button')?.textContent).toBe('播放运镜')
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(drawQuickMotionFrame).toHaveBeenCalled()
  })

  it('切换图片后迟到的旧图片不会覆盖新预览', async () => {
    let finishFirst!: (images: HTMLImageElement[]) => void
    const second = { naturalWidth: 200, naturalHeight: 100 } as HTMLImageElement
    vi.mocked(preloadLiveFrames)
      .mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve }))
      .mockResolvedValueOnce([second])
    await act(async () => root.render(<QuickMotionPlayer src="first" options={opts} />))
    await act(async () => root.render(<QuickMotionPlayer src="second" options={opts} />))
    await act(async () => finishFirst([image]))
    expect(el.querySelector('canvas')?.width).toBe(200)
    expect(vi.mocked(drawQuickMotionFrame).mock.calls.every((call) => call[1] === second)).toBe(true)
  })

  it('图片解码失败可见错误并禁用播放', async () => {
    vi.mocked(preloadLiveFrames).mockRejectedValue(new Error('图片读取失败'))
    await act(async () => root.render(<QuickMotionPlayer src="invalid" options={opts} />))
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('图片读取失败')
    expect(el.querySelector('button')?.disabled).toBe(true)
  })

  it('后台标签停止动画调度，回到前台继续且不跳进度', async () => {
    await act(async () => root.render(<QuickMotionPlayer src="first" options={opts} />))
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2)
    expect(cancelAnimationFrame).toHaveBeenCalled()
  })

  it('图片解码悬挂时结束等待，迟到结果也不会恢复播放', async () => {
    vi.useFakeTimers()
    let finish!: (images: HTMLImageElement[]) => void
    vi.mocked(preloadLiveFrames).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await act(async () => root.render(<QuickMotionPlayer src="pending" options={opts} />))
    await act(async () => { await vi.advanceTimersByTimeAsync(15001) })
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('图片读取超时')
    await act(async () => finish([image]))
    expect(el.querySelector('button')?.disabled).toBe(true)
    expect(drawQuickMotionFrame).not.toHaveBeenCalled()
  })
})
