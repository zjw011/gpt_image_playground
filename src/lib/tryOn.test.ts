import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomProviderDefinition, TaskRecord, TryOnOptions } from '../types'
import { DEFAULT_PARAMS } from '../types'

vi.mock('./livePhoto', () => ({ preloadLiveFrames: vi.fn() }))
import { preloadLiveFrames } from './livePhoto'
import { appendTryOnPrompt, assertTryOnProviderSupportsReferences, isTryOnTask, normalizeTryOnOptions, normalizeTryOnTask, validateTryOnImageData, validateTryOnImages } from './tryOn'

const options: TryOnOptions = { mode: 'wear', category: 'clothing', scene: 'street', pose: 'natural' }
const person = { id: 'person', dataUrl: 'data:image/png;base64,person' }
const product = { id: 'product', dataUrl: 'data:image/png;base64,product' }
const image = { naturalWidth: 768, naturalHeight: 1024 } as HTMLImageElement

describe('try-on prompt and metadata', () => {
  it('normalizes malformed external options without trusting arbitrary keys', () => {
    expect(normalizeTryOnOptions(null)).toEqual(options)
    expect(normalizeTryOnOptions({ mode: 'wrong', category: 'wrong', scene: 'wrong', pose: 'wrong', injected: 'x' })).toEqual(options)
    expect(normalizeTryOnOptions({ mode: 'hold', category: 'bag', scene: 'cafe', pose: 'sitting' })).toEqual({ mode: 'hold', category: 'bag', scene: 'cafe', pose: 'sitting' })
  })

  it('separates the person and product roles while preserving identity, age and product details', () => {
    const prompt = appendTryOnPrompt(' 保留我的蓝色上衣 ', options)
    expect(prompt).toContain('保留我的蓝色上衣')
    expect(prompt).toContain('第一张参考图是人物')
    expect(prompt).toContain('第二张参考图是商品')
    expect(prompt).toContain('原有年龄')
    expect(prompt).toContain('身体比例')
    expect(prompt).toContain('品牌标识')
    expect(prompt).toContain('合理垂坠')
    expect(prompt).toContain('不要增加多余肢体')
    expect(prompt).not.toContain('成年')
  })

  it('uses holding anatomy, scenario and pose directives without claiming a real endorsement', () => {
    const prompt = appendTryOnPrompt('', { mode: 'hold', category: 'other', scene: 'studio', pose: 'showcase' })
    expect(prompt).toContain('拿着或使用')
    expect(prompt).toContain('抓握有真实接触')
    expect(prompt).toContain('干净摄影棚')
    expect(prompt).toContain('清楚展示商品')
    expect(prompt).toContain('不声称真实使用体验')
    expect(prompt).not.toContain('只替换对应类别的原有穿搭')
  })

  it.each(['clothing', 'shoes', 'bag', 'accessory', 'other'] as const)('keeps a realistic category guide for %s', (category) => {
    expect(appendTryOnPrompt('', { ...options, category, scene: 'outdoors', pose: 'walking' })).toContain('轻松行走')
  })

  it('repairs restored metadata and keeps the ordinary tasks untouched', () => {
    const task: TaskRecord = { id: 'x', prompt: '公开描述', params: DEFAULT_PARAMS, inputImageIds: ['person', 'product'], outputImages: [], status: 'done', error: null, createdAt: 1, finishedAt: 1, elapsed: 0 }
    expect(normalizeTryOnTask(task)).toBe(task)
    expect(isTryOnTask({ ...task, tryOn: undefined })).toBe(false)
    expect(normalizeTryOnTask({ ...task, professionalPreset: 'try-on', tryOn: null } as unknown as TaskRecord)).toMatchObject({ professionalPreset: 'try-on', tryOn: options })
    expect(normalizeTryOnTask({ ...task, tryOn: options })).toMatchObject({ professionalPreset: 'try-on', tryOn: options })
    const valid = { ...task, professionalPreset: 'try-on', tryOn: options }
    expect(normalizeTryOnTask(valid)).toBe(valid)
  })
})

describe('try-on two-image compatibility and validation', () => {
  beforeEach(() => vi.mocked(preloadLiveFrames).mockReset().mockResolvedValue([image, image]))
  afterEach(() => vi.useRealTimers())

  it('decodes exactly two references in person-product order', async () => {
    await validateTryOnImages(person, product)
    expect(preloadLiveFrames).toHaveBeenCalledWith([person.dataUrl, product.dataUrl])
  })

  it('validates a single uploaded image without trusting its image MIME', async () => {
    vi.mocked(preloadLiveFrames).mockResolvedValueOnce([image])
    await validateTryOnImageData([person.dataUrl])
    expect(preloadLiveFrames).toHaveBeenCalledWith([person.dataUrl])
    vi.mocked(preloadLiveFrames).mockRejectedValueOnce(new Error('坏文件不是可解码的图像'))
    await expect(validateTryOnImageData(['data:image/png;base64,malformed'])).rejects.toThrow('不是可解码')
    vi.mocked(preloadLiveFrames).mockRejectedValueOnce(new Error('实况帧读取失败，请重新生成'))
    await expect(validateTryOnImageData([person.dataUrl])).rejects.toThrow('参考图读取失败')
  })

  it('rejects empty, non-image, missing, zero-size and non-finite single upload results', async () => {
    await expect(validateTryOnImageData([])).rejects.toThrow('有效')
    await expect(validateTryOnImageData(['data:text/plain;base64,text'])).rejects.toThrow('有效')
    vi.mocked(preloadLiveFrames).mockResolvedValueOnce([])
    await expect(validateTryOnImageData([person.dataUrl])).rejects.toThrow('尺寸无效')
    vi.mocked(preloadLiveFrames).mockResolvedValueOnce([{ naturalWidth: 0, naturalHeight: 0 } as HTMLImageElement])
    await expect(validateTryOnImageData([person.dataUrl])).rejects.toThrow('尺寸无效')
    vi.mocked(preloadLiveFrames).mockResolvedValueOnce([{ naturalWidth: NaN, naturalHeight: 1024 } as HTMLImageElement])
    await expect(validateTryOnImageData([person.dataUrl])).rejects.toThrow('尺寸无效')
  })

  it('rejects a duplicate, invalid, damaged or missing role before use', async () => {
    await expect(validateTryOnImages(person, person)).rejects.toThrow('同一张图片')
    await expect(validateTryOnImages(person, { ...product, dataUrl: '' })).rejects.toThrow('分别上传')
    vi.mocked(preloadLiveFrames).mockRejectedValueOnce(new Error('图片损坏'))
    await expect(validateTryOnImages(person, product)).rejects.toThrow('图片损坏')
    vi.mocked(preloadLiveFrames).mockResolvedValueOnce([image])
    await expect(validateTryOnImages(person, product)).rejects.toThrow('尺寸无效')
    vi.mocked(preloadLiveFrames).mockResolvedValueOnce([image, { naturalWidth: 0, naturalHeight: 0 } as HTMLImageElement])
    await expect(validateTryOnImages(person, product)).rejects.toThrow('尺寸无效')
  })

  it('bounds stuck decoding and clears its timeout', async () => {
    vi.useFakeTimers()
    vi.mocked(preloadLiveFrames).mockImplementationOnce(() => new Promise(() => undefined))
    const rejected = expect(validateTryOnImages(person, product)).rejects.toThrow('读取超时')
    await vi.advanceTimersByTimeAsync(15000)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows native providers, all-image multipart and full/paired JSON mappings', () => {
    expect(() => assertTryOnProviderSupportsReferences(null)).not.toThrow()
    const provider: CustomProviderDefinition = { id: 'custom', name: 'custom', submit: { path: '/generate' }, editSubmit: { path: '/edit', contentType: 'multipart', files: [{ source: 'inputImages', field: 'image[]' }] } }
    expect(() => assertTryOnProviderSupportsReferences(provider)).not.toThrow()
    expect(() => assertTryOnProviderSupportsReferences({ ...provider, editSubmit: { path: '/edit', body: { images: '$inputImages.dataUrls' } } })).not.toThrow()
    expect(() => assertTryOnProviderSupportsReferences({ ...provider, editSubmit: { path: '/edit', body: { person: '$inputImages.dataUrls.0', product: '$inputImages.dataUrls.1' } } })).not.toThrow()
  })

  it('rejects provable single-image or no-image mappings, including a GET body that is never sent', () => {
    const provider: CustomProviderDefinition = { id: 'custom', name: 'custom', submit: { path: '/generate' }, editSubmit: { path: '/edit', body: { image: '$inputImages.dataUrls.0' } } }
    expect(() => assertTryOnProviderSupportsReferences(provider)).toThrow('没有双图参考映射')
    expect(() => assertTryOnProviderSupportsReferences({ ...provider, editSubmit: { path: '/edit', body: { prompt: '$prompt' } } })).toThrow('没有双图参考映射')
    expect(() => assertTryOnProviderSupportsReferences({ ...provider, editSubmit: { path: '/edit', method: 'GET', body: { images: '$inputImages.dataUrls' } } })).toThrow('没有双图参考映射')
  })
})
