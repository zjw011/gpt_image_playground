import { createFalClient } from '@fal-ai/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultFalProfile, DEFAULT_FAL_BASE_URL, DEFAULT_SETTINGS } from './apiProfiles'
import { callFalAiImageApi, getFalQueuedImageResult } from './falAiImageApi'
import { classifyGenerationError } from './generationError.mjs'

vi.mock('@fal-ai/client', () => ({
  createFalClient: vi.fn(),
}))

const falMock = {
  subscribe: vi.fn(),
  queue: { subscribeToStatus: vi.fn(), result: vi.fn() },
}

describe('callFalAiImageApi', () => {
  beforeEach(() => {
    vi.mocked(createFalClient).mockReturnValue(falMock as unknown as ReturnType<typeof createFalClient>)
  })
  afterEach(() => {
    vi.resetAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses the default fal endpoint without proxyUrl', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ b64_json: 'aW1hZ2U=' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, createDefaultFalProfile({ apiKey: 'fal-key', baseUrl: DEFAULT_FAL_BASE_URL }))

    expect(createFalClient).toHaveBeenCalledWith({
      credentials: 'fal-key',
      suppressLocalCredentialsWarning: true,
      fetch: expect.any(Function),
    })
  })

  it('passes custom fal API URL to the SDK proxyUrl option', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ b64_json: 'aW1hZ2U=' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, createDefaultFalProfile({
      apiKey: 'fal-key',
      baseUrl: 'https://fal-proxy.example.com/api/fal/',
    }))

    expect(createFalClient).toHaveBeenCalledWith({
      credentials: 'fal-key',
      suppressLocalCredentialsWarning: true,
      proxyUrl: 'https://fal-proxy.example.com/api/fal',
      fetch: expect.any(Function),
    })
  })

  it('保留 SDK 校验错误中的审核类型，不被普通 msg 覆盖', async () => {
    falMock.subscribe.mockRejectedValue(Object.assign(new Error('Unprocessable Entity'), {
      body: { detail: [{ type: 'content_policy_violation', msg: 'Request rejected', loc: ['body', 'prompt'] }] },
    }))
    const err = await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, createDefaultFalProfile({ apiKey: 'fal-key' })).catch((error: unknown) => error)

    expect(classifyGenerationError(err)).toBe('content_policy')
    expect((err as Error).message).toContain('Request rejected')
  })

  it.each([
    [{ error: { code: 'content_policy_violation', message: 'Rejected' } }, 'content_policy'],
    [{ status: 'cancelled' }, 'cancelled'],
  ])('成功 HTTP 响应携带失败时保留真实错误类型', async (data, kind) => {
    falMock.subscribe.mockResolvedValue({ requestId: 'req-failed', data })
    const err = await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, createDefaultFalProfile({ apiKey: 'fal-key' })).catch((error: unknown) => error)

    expect(classifyGenerationError(err)).toBe(kind)
    expect((err as Error).message).not.toContain('未返回可用图片')
  })

  it('恢复队列任务时同样保留结构化审核错误', async () => {
    falMock.queue.subscribeToStatus.mockResolvedValue({ status: 'COMPLETED' })
    falMock.queue.result.mockRejectedValue(Object.assign(new Error('Unprocessable Entity'), {
      body: { error: { code: 'content_policy_violation', message: 'Rejected' } },
    }))
    const err = await getFalQueuedImageResult(
      createDefaultFalProfile({ apiKey: 'fal-key' }), 'image-endpoint', 'req-failed', DEFAULT_PARAMS,
    ).catch((error: unknown) => error)

    expect(classifyGenerationError(err)).toBe('content_policy')
  })

  it('一张下载失败时保留已经完成的图片、原始链接和准确索引', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-partial',
      data: { images: [
        { b64_json: 'Zmlyc3Q=', width: 1024, height: 768 },
        { url: 'https://images.example/expired.png' },
        { b64_json: 'dGhpcmQ=', width: 768, height: 1024 },
      ] },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('expired', { status: 404 })))
    const result = await callFalAiImageApi({ settings: DEFAULT_SETTINGS, prompt: 'prompt', params: DEFAULT_PARAMS, inputImageDataUrls: [] }, createDefaultFalProfile({ apiKey: 'fal-key' }))

    expect(result.images).toEqual(['data:image/png;base64,Zmlyc3Q=', 'data:image/png;base64,dGhpcmQ='])
    expect(result.actualParamsList).toEqual([{ size: '1024x768' }, { size: '768x1024' }])
    expect(result.rawImageUrls).toEqual(['https://images.example/expired.png'])
    expect(result.failedRequests).toEqual([{ requestIndex: 1, error: expect.stringContaining('图片结果下载失败') }])
  })

  it('局部审核拒绝不抹掉其他已完成图片', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-partial',
      data: { images: [{ b64_json: 'Zmlyc3Q=' }, { error: { code: 'content_policy_violation', message: 'Rejected' } }] },
    })
    const result = await callFalAiImageApi({ settings: DEFAULT_SETTINGS, prompt: 'prompt', params: DEFAULT_PARAMS, inputImageDataUrls: [] }, createDefaultFalProfile({ apiKey: 'fal-key' }))
    expect(result.images).toHaveLength(1)
    expect(result.failedRequests).toEqual([{ requestIndex: 1, error: expect.stringContaining('内容安全审核未通过') }])
  })

  it('无任务 ID 时停止查询，且最终缺少响应头不会清掉已保存的 ID', async () => {
    const onFalRequestEnqueued = vi.fn()
    falMock.subscribe.mockImplementation(async (_endpoint, opts) => {
      opts.onEnqueue('request-known')
      return { requestId: '', data: { images: [{ b64_json: 'aW1hZ2U=' }] } }
    })
    const opts = { settings: DEFAULT_SETTINGS, prompt: 'prompt', params: DEFAULT_PARAMS, inputImageDataUrls: [], onFalRequestEnqueued }
    await callFalAiImageApi(opts, createDefaultFalProfile({ apiKey: 'fal-key' }))
    expect(onFalRequestEnqueued).toHaveBeenCalledTimes(1)
    expect(onFalRequestEnqueued).toHaveBeenCalledWith({ requestId: 'request-known', endpoint: 'openai/gpt-image-2' })

    falMock.subscribe.mockImplementation(async (_endpoint, options) => options.onEnqueue(undefined))
    await expect(callFalAiImageApi(opts, createDefaultFalProfile({ apiKey: 'fal-key' }))).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('未返回有效任务 ID') })
  })
})
