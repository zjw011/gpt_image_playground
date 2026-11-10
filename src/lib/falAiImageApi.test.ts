import { fal } from '@fal-ai/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultFalProfile, DEFAULT_FAL_BASE_URL, DEFAULT_SETTINGS } from './apiProfiles'
import { callFalAiImageApi, getFalQueuedImageResult } from './falAiImageApi'
import { classifyGenerationError } from './generationError.mjs'

vi.mock('@fal-ai/client', () => ({
  fal: {
    config: vi.fn(),
    subscribe: vi.fn(),
    queue: {
      subscribeToStatus: vi.fn(),
      result: vi.fn(),
    },
  },
}))

const falMock = fal as unknown as {
  config: Mock
  subscribe: Mock
  queue: { subscribeToStatus: Mock; result: Mock }
}

describe('callFalAiImageApi', () => {
  afterEach(() => {
    vi.resetAllMocks()
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

    expect(falMock.config).toHaveBeenCalledWith({
      credentials: 'fal-key',
      suppressLocalCredentialsWarning: true,
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

    expect(falMock.config).toHaveBeenCalledWith({
      credentials: 'fal-key',
      suppressLocalCredentialsWarning: true,
      proxyUrl: 'https://fal-proxy.example.com/api/fal',
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
})
