import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { isNativeGifTask, inspectNativeGif, normalizeNativeGifParams, supportsNativeGif } from './nativeGif'

const header = [71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]
const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0]
const frameWithDelay = (delay: number) => [0x21, 0xf9, 4, 0, delay & 255, delay >> 8, 0, 0, ...frame]
const asDataUrl = (bytes: number[], mime = 'image/gif') => `data:${mime};base64,${btoa(String.fromCharCode(...bytes))}`

describe('原生 GIF 渠道能力和任务身份', () => {
  it('官方模型自动识别，别名需管理员确认且显式禁用优先', () => {
    const profile = { provider: 'openai', apiMode: 'images' as const, model: 'gpt-image-2.6-flare' }
    expect(supportsNativeGif(profile)).toBe(true)
    expect(supportsNativeGif({ ...profile, model: 'gpt-image-2.6-sunburst-2026-11-04' })).toBe(true)
    expect(supportsNativeGif({ ...profile, model: 'gpt-image-2' })).toBe(false)
    expect(supportsNativeGif({ ...profile, model: 'gpt-image-2.6-flare-fake', supportsNativeGif: false })).toBe(false)
    expect(supportsNativeGif({ ...profile, model: 'my-gif-alias', supportsNativeGif: true })).toBe(true)
    expect(supportsNativeGif({ ...profile, apiMode: 'responses', supportsNativeGif: true })).toBe(false)
    expect(supportsNativeGif({ ...profile, provider: 'fal', supportsNativeGif: true })).toBe(false)
  })

  it('保留旧任务参数与专用预设两条识别路径', () => {
    expect(isNativeGifTask({ params: { ...DEFAULT_PARAMS, output_format: 'gif' } })).toBe(true)
    expect(isNativeGifTask({ params: DEFAULT_PARAMS, professionalPreset: 'live-gif' })).toBe(true)
    expect(isNativeGifTask({ params: DEFAULT_PARAMS, professionalPreset: 'live-blink' })).toBe(false)
  })
})

describe('原生 GIF 参数兼容', () => {
  it('保留自动尺寸，以单次动图请求的默认值清除静态图专属参数', () => {
    expect(normalizeNativeGifParams({ ...DEFAULT_PARAMS, output_format: 'gif', n: 4, transparent_output: true, output_compression: 70 })).toEqual({
      ...DEFAULT_PARAMS,
      output_format: 'gif',
      frame_count: 9,
      frame_duration_ms: 200,
    })
  })

  it.each([
    [-2, -50, 2, 20],
    [100, 5000, 16, 2000],
    [7.9, 234, 7, 230],
    [Number.NaN, Number.POSITIVE_INFINITY, 9, 200],
  ])('恢复异常参数 %s / %s 时仍得到有效帧数和时间', (frames, duration, expectedFrames, expectedDuration) => {
    expect(normalizeNativeGifParams({ ...DEFAULT_PARAMS, output_format: 'gif', frame_count: frames, frame_duration_ms: duration })).toMatchObject({
      frame_count: expectedFrames,
      frame_duration_ms: expectedDuration,
    })
  })

  it('静态图不受动图约束影响', () => {
    const params = { ...DEFAULT_PARAMS, output_format: 'webp' as const, n: 4, transparent_output: true, output_compression: 70 }
    expect(normalizeNativeGifParams(params)).toBe(params)
  })
})

describe('GIF 结果使用实际帧结构校验', () => {
  it('读取多帧尺寸与实际延时，忽略 MIME 误标且不重写输入', () => {
    const input = asDataUrl([...header, ...frameWithDelay(20), ...frameWithDelay(30), 0x3b], 'application/octet-stream')
    const before = input
    expect(inspectNativeGif(input)).toEqual({ width: 1, height: 1, frameCount: 2, durationMs: 500 })
    expect(input).toBe(before)
  })

  it('87a 无延时多帧仍识别为多帧，不猜测浏览器默认播放时间', () => {
    const oldHeader = [...header]
    oldHeader[4] = 55
    expect(inspectNativeGif(asDataUrl([...oldHeader, ...frame, ...frame, 0x3b]))).toMatchObject({ frameCount: 2, durationMs: 0 })
  })

  it('颜色表、注释和压缩子块内的帧标记不计数', () => {
    const falseFrame = [...frame]
    falseFrame[12] = 0x2c
    const bytes = [...header, 0x21, 0xfe, 4, 0x2c, 0x21, 0xf9, 0x3b, 0, ...falseFrame, 0x3b]
    expect(() => inspectNativeGif(asDataUrl(bytes))).toThrow('静态图片')
  })

  it('支持局部颜色表和应用扩展', () => {
    const local = [...frame.slice(0, 9), 0x80, 0, 0, 0, 255, 255, 255, ...frame.slice(10)]
    const extension = [0x21, 0xff, 11, ...Array.from('NETSCAPE2.0', (ch) => ch.charCodeAt(0)), 3, 1, 0, 0, 0]
    expect(inspectNativeGif(asDataUrl([...header, ...extension, ...local, ...local, 0x3b]))).toMatchObject({ frameCount: 2 })
  })

  it.each([
    ['PNG 冒充 GIF', asDataUrl([137, 80, 78, 71, 13, 10, 26, 10])],
    ['单帧 GIF', asDataUrl([...header, ...frame, 0x3b])],
    ['缺少文件尾', asDataUrl([...header, ...frame, ...frame])],
    ['截断颜色表', asDataUrl(header.slice(0, 14))],
    ['截断图像子块', asDataUrl([...header, ...frame.slice(0, -3)])],
    ['越界帧', asDataUrl([...header, 0x2c, 1, 0, 0, 0, ...frame.slice(5), ...frame, 0x3b])],
    ['残缺控制扩展', asDataUrl([...header, 0x21, 0xf9, 4, 0, 20])],
    ['损坏编码', 'data:image/gif;base64,@@@'],
    ['外部 URL', 'https://example.com/animation.gif'],
  ])('%s 不冒充成功，而且禁止自动整单重投', (_, input) => {
    let error: unknown
    try { inspectNativeGif(input) } catch (err) { error = err }
    expect(error).toMatchObject({ retryable: false })
    expect((error as Error).message).toContain('原生 GIF 结果无效')
  })
})
