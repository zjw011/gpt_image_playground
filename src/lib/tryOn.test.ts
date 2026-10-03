import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomProviderDefinition, TaskRecord, TryOnOptions } from '../types'
import { DEFAULT_PARAMS } from '../types'

vi.mock('./livePhoto', () => ({ preloadLiveFrames: vi.fn() }))
import { preloadLiveFrames } from './livePhoto'
import { appendTryOnPrompt, assertTryOnProviderSupportsReferences, isTryOnTask, normalizeTryOnOptions, normalizeTryOnTask, prepareTryOnSubmissionOptions, validateTryOnImageData, validateTryOnImages } from './tryOn'

const options: TryOnOptions = { mode: 'wear', category: 'clothing', scene: 'street', pose: 'natural' }
const person = { id: 'person', dataUrl: 'data:image/png;base64,person' }
const product = { id: 'product', dataUrl: 'data:image/png;base64,product' }
const image = { naturalWidth: 768, naturalHeight: 1024 } as HTMLImageElement

describe('try-on prompt and metadata', () => {
  afterEach(() => vi.restoreAllMocks())
  it('normalizes malformed external options without trusting arbitrary keys', () => {
    expect(normalizeTryOnOptions(null)).toEqual(options)
    expect(normalizeTryOnOptions({ mode: 'wrong', category: 'wrong', scene: 'wrong', pose: 'wrong', injected: 'x' })).toEqual(options)
    expect(normalizeTryOnOptions({ mode: 'hold', category: 'bag', scene: 'cafe', pose: 'sitting' })).toEqual({ mode: 'hold', category: 'bag', scene: 'cafe', pose: 'sitting' })
  })

  it('defaults reference elements and sanitizes, orders and deduplicates external selections', () => {
    const all = { ...options, mode: 'reference', pose: 'reference', referenceElements: ['outfit', 'scene', 'style'] }
    expect(normalizeTryOnOptions({ mode: 'reference', pose: 'reference' })).toEqual(all)
    expect(normalizeTryOnOptions({ mode: 'reference', referenceElements: ['style', 'outfit', 'style', 'invalid'] })).toEqual({ ...all, pose: 'natural', referenceElements: ['outfit', 'style'] })
    for (const referenceElements of [[], ['invalid'], 'outfit', null]) {
      expect(normalizeTryOnOptions({ mode: 'reference', referenceElements }).referenceElements).toEqual(['outfit', 'scene', 'style'])
    }
    const source = { ...options, mode: 'reference', referenceElements: ['scene'] }
    const normalized = normalizeTryOnOptions(source)
    source.referenceElements.push('style')
    expect(normalized.referenceElements).toEqual(['scene'])
  })

  it('preserves the old four-field shape and confines reference pose/elements to reference mode', () => {
    expect(normalizeTryOnOptions({ ...options, referenceElements: ['outfit'], poseVariant: 2 })).toEqual(options)
    expect(normalizeTryOnOptions({ ...options, mode: 'hold', pose: 'reference', referenceElements: ['scene'] })).toEqual({ ...options, mode: 'hold' })
    const random = vi.spyOn(Math, 'random')
    expect(normalizeTryOnOptions({ ...options, pose: 'random' })).toEqual({ ...options, pose: 'random' })
    expect(random).not.toHaveBeenCalled()
  })

  it.each([-1, 8, 2.5, NaN, Infinity, '2', null])('discards an invalid random pose variant %s', (poseVariant) => {
    expect(normalizeTryOnOptions({ ...options, pose: 'random', poseVariant })).toEqual({ ...options, pose: 'random' })
  })

  it('samples new random submissions only once, while preserving stored variants for retry', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.999)
    expect(prepareTryOnSubmissionOptions({ ...options, pose: 'random' }).poseVariant).toBe(0)
    expect(prepareTryOnSubmissionOptions({ ...options, pose: 'random' }).poseVariant).toBe(7)
    expect(random).toHaveBeenCalledTimes(2)
    const restored = { ...options, mode: 'hold', pose: 'random', poseVariant: 5 }
    expect(prepareTryOnSubmissionOptions(restored)).toEqual(restored)
    expect(prepareTryOnSubmissionOptions(options)).toEqual(options)
    expect(random).toHaveBeenCalledTimes(2)
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

  it('extracts the full outfit, scene and photography from reference without copying its person', () => {
    const prompt = appendTryOnPrompt('街头搭配', { ...options, mode: 'reference', pose: 'reference' })
    expect(prompt).toContain('第一张参考图是人物身份图')
    expect(prompt).toContain('第二张参考图是穿搭、场景和拍摄风格参考图')
    expect(prompt).toContain('整套穿搭')
    expect(prompt).toContain('上衣、下装、鞋履、包袋与配饰')
    expect(prompt).toContain('参考第二张图的场景')
    expect(prompt).toContain('光线、色调、构图与镜头视角')
    expect(prompt).toContain('不得复制其脸型、五官、年龄、肤色、体型或发型')
    expect(prompt).toContain('不得复制第二张图的水印、文字')
    expect(prompt).toContain('第二张图人物的肢体姿势')
    expect(prompt).not.toContain('第二张参考图是商品')
    expect(prompt).not.toContain('只替换对应类别的原有穿搭')
    expect(prompt).not.toContain('自然街景')
  })

  it('explicitly keeps unselected reference elements from the identity image', () => {
    const prompt = appendTryOnPrompt('', { ...options, mode: 'reference', referenceElements: ['scene'] })
    expect(prompt).toContain('不参考第二张图的穿搭，沿用第一张人物图的原有衣服')
    expect(prompt).toContain('不参考第二张图的拍摄风格，沿用第一张人物图的光线')
    expect(prompt).toContain('参考第二张图的场景、背景和环境布局')
    expect(prompt).not.toContain('参考第二张图的整套穿搭')
    const outfitOnly = appendTryOnPrompt('', { ...options, mode: 'reference', referenceElements: ['outfit'] })
    expect(outfitOnly).toContain('不参考第二张图的场景，沿用第一张人物图的背景与环境')
  })

  it('uses a stable sampled pose and rotates distinct output guidance within a single request', () => {
    const random = vi.spyOn(Math, 'random')
    const sampled: TryOnOptions = { ...options, mode: 'reference', pose: 'random', poseVariant: 7 }
    const prompt = appendTryOnPrompt('自然一些', sampled, 4)
    expect(appendTryOnPrompt('自然一些', sampled, 4)).toBe(prompt)
    expect(prompt).toContain('第1张自然倚靠或坐姿')
    expect(prompt).toContain('第2张正面自然站立')
    expect(prompt).toContain('第3张身体轻轻侧向')
    expect(prompt).toContain('第4张轻松向前行走')
    expect(prompt).not.toContain('第5张')
    expect(prompt).toContain('不要把所有输出画成同一姿势')
    expect(appendTryOnPrompt('自然一些', { ...sampled, poseVariant: 2 }, 4)).not.toBe(prompt)
    expect(random).not.toHaveBeenCalled()
    expect(appendTryOnPrompt('', { ...options, mode: 'hold', pose: 'random', poseVariant: 1 })).toContain('抓握有真实接触')
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
    const reference = { ...task, professionalPreset: 'try-on', tryOn: normalizeTryOnOptions({ mode: 'reference', pose: 'random', poseVariant: 6, referenceElements: ['scene', 'style'] }) }
    expect(normalizeTryOnTask(reference)).toBe(reference)
    expect(normalizeTryOnTask({ ...reference, tryOn: { ...reference.tryOn, referenceElements: ['style', 'style', 'scene'] } }).tryOn).toEqual(reference.tryOn)
  })

  it.each([undefined, -1, 8, 1.5, NaN, Infinity])('repairs a historical random task with invalid variant %s to the stable default', (poseVariant) => {
    const random = vi.spyOn(Math, 'random')
    const source: TaskRecord = { id: 'legacy-random', prompt: '公开描述', params: DEFAULT_PARAMS, inputImageIds: ['person', 'product'], outputImages: [], status: 'error', error: '失败', createdAt: 1, finishedAt: 1, elapsed: 0, professionalPreset: 'try-on', tryOn: { ...options, pose: 'random', poseVariant } }
    const restored = normalizeTryOnTask(source)
    expect(restored.tryOn).toEqual({ ...options, pose: 'random', poseVariant: 0 })
    expect(normalizeTryOnTask(restored)).toBe(restored)
    expect(prepareTryOnSubmissionOptions(restored.tryOn).poseVariant).toBe(0)
    expect(random).not.toHaveBeenCalled()
    expect(source.tryOn?.poseVariant).toBe(poseVariant)
    expect(normalizeTryOnOptions({ ...options, pose: 'random' }).poseVariant).toBeUndefined()
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
