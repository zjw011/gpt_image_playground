import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { DEFAULT_SETTINGS } from './apiProfiles'
import { callImageApi, type CallApiOptions } from './api'
import { callFalAiImageApi } from './falAiImageApi'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import { prepareReferenceImages } from './referenceImages'

vi.mock('./referenceImages', () => ({ prepareReferenceImages: vi.fn() }))
vi.mock('./falAiImageApi', () => ({ callFalAiImageApi: vi.fn() }))
vi.mock('./openaiCompatibleImageApi', () => ({ callOpenAICompatibleImageApi: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prepareReferenceImages).mockResolvedValue(['optimized-person', 'optimized-product'])
  vi.mocked(callFalAiImageApi).mockResolvedValue({ images: [] })
  vi.mocked(callOpenAICompatibleImageApi).mockResolvedValue({ images: [] })
})

describe('统一图片 API 的请求副本入口', () => {
  it.each(['openai', 'fal'])('%s 接收优化副本，原参数、双图顺序和回调保持不变', async (provider) => {
    const opts: CallApiOptions = {
      settings: { ...DEFAULT_SETTINGS, profiles: [{ ...DEFAULT_SETTINGS.profiles[0], provider }] },
      params: DEFAULT_PARAMS,
      prompt: '测试人物与商品',
      inputImageDataUrls: ['original-person', 'original-product'],
      onPartialImage: vi.fn(),
    }
    await callImageApi(opts)
    const api = provider === 'fal' ? callFalAiImageApi : callOpenAICompatibleImageApi
    expect(api).toHaveBeenCalledOnce()
    expect(vi.mocked(api).mock.calls[0][0]).toEqual({ ...opts, inputImageDataUrls: ['optimized-person', 'optimized-product'] })
    expect(prepareReferenceImages).toHaveBeenCalledWith(opts.inputImageDataUrls, undefined)
    expect(opts.inputImageDataUrls).toEqual(['original-person', 'original-product'])
  })

  it('向预处理传递遮罩，保留已有跳过压缩的决策', async () => {
    const opts: CallApiOptions = { settings: DEFAULT_SETTINGS, params: DEFAULT_PARAMS, prompt: '重绘', inputImageDataUrls: ['original'], maskDataUrl: 'mask' }
    vi.mocked(prepareReferenceImages).mockResolvedValue(opts.inputImageDataUrls)
    await callImageApi(opts)
    expect(prepareReferenceImages).toHaveBeenCalledWith(opts.inputImageDataUrls, 'mask')
    expect(vi.mocked(callOpenAICompatibleImageApi).mock.calls[0][0]).toEqual(opts)
  })

  it('压缩失败时不发送任何绘图请求', async () => {
    vi.mocked(prepareReferenceImages).mockRejectedValue(new Error('参考图片过大'))
    await expect(callImageApi({ settings: DEFAULT_SETTINGS, params: DEFAULT_PARAMS, prompt: '测试', inputImageDataUrls: ['original'] })).rejects.toThrow('参考图片过大')
    expect(callFalAiImageApi).not.toHaveBeenCalled()
    expect(callOpenAICompatibleImageApi).not.toHaveBeenCalled()
  })
})
