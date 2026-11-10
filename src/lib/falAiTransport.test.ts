// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultFalProfile, DEFAULT_SETTINGS } from './apiProfiles'
import { callFalAiImageApi, getFalQueuedImageResult } from './falAiImageApi'
import { classifyGenerationError } from './generationError.mjs'
import { isFailoverableError } from './failover'

const options = { settings: DEFAULT_SETTINGS, prompt: 'test', params: DEFAULT_PARAMS, inputImageDataUrls: [] }
const profile = createDefaultFalProfile({ apiKey: 'managed', baseUrl: 'https://site.test/api/relay/fal-a/' })

function json(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } })
}

describe('fal SDK transport', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('503 提交只请求一次，交由任务层换渠道，且只在声明接管时发送标记', async () => {
    const request = vi.fn().mockImplementation(() => Promise.resolve(json({ error: 'upstream unavailable' }, 503)))
    vi.stubGlobal('fetch', request)

    await expect(callFalAiImageApi({ ...options, clientFailover: true }, profile)).rejects.toThrow('upstream unavailable')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toBe('https://site.test/api/relay/fal-a')
    expect(new Headers(request.mock.calls[0][1].headers).get('x-gip-failover')).toBe('client')

    request.mockClear()
    await expect(callFalAiImageApi(options, profile)).rejects.toThrow('upstream unavailable')
    expect(request).toHaveBeenCalledTimes(1)
    expect(new Headers(request.mock.calls[0][1].headers).has('x-gip-failover')).toBe(false)
  })

  it('本站 stop 限流保留禁止重试标记，SDK 不自行重试', async () => {
    const request = vi.fn().mockImplementation(() => Promise.resolve(json({ error: '你已有生成任务正在处理' }, 429, { 'x-gip-failover': 'stop' })))
    vi.stubGlobal('fetch', request)
    await expect(callFalAiImageApi({ ...options, clientFailover: true }, profile)).rejects.toMatchObject({ retryable: false, status: 429 })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ error: { code: 'content_policy_violation', message: 'Rejected' } }, 'content_policy'],
    [{ status: 'cancelled' }, 'cancelled'],
  ])('HTTP 200 提交错误不使用 undefined 任务 ID 查询', async (payload, kind) => {
    const request = vi.fn().mockImplementation(() => Promise.resolve(json(payload)))
    vi.stubGlobal('fetch', request)
    const error = await callFalAiImageApi(options, profile).catch((err: unknown) => err)
    expect(classifyGenerationError(error)).toBe(kind)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('入队后状态取消能够结束轮询并保留已受理 ID', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(json({ request_id: 'known-id' }))
      .mockResolvedValueOnce(json({ status: 'CANCELLED' }))
    vi.stubGlobal('fetch', request)
    const onFalRequestEnqueued = vi.fn()
    const error = await callFalAiImageApi({ ...options, onFalRequestEnqueued }, profile).catch((err: unknown) => err)
    expect(classifyGenerationError(error)).toBe('cancelled')
    expect(request).toHaveBeenCalledTimes(2)
    expect(onFalRequestEnqueued).toHaveBeenCalledWith({ requestId: 'known-id', endpoint: 'openai/gpt-image-2' })
  })

  it('提交同时返回任务 ID 和错误时先登记已受理任务，禁止重新提交到其他渠道', async () => {
    const request = vi.fn().mockResolvedValue(json({ request_id: 'accepted-id', error: { message: 'queue temporarily unavailable' } }))
    vi.stubGlobal('fetch', request)
    const onFalRequestEnqueued = vi.fn()
    const error = await callFalAiImageApi({ ...options, clientFailover: true, onFalRequestEnqueued }, profile).catch((err: unknown) => err)
    expect(onFalRequestEnqueued).toHaveBeenCalledOnce()
    expect(onFalRequestEnqueued).toHaveBeenCalledWith({ requestId: 'accepted-id', endpoint: 'openai/gpt-image-2' })
    expect(error).toMatchObject({ message: 'queue temporarily unavailable', retryable: false })
    expect(isFailoverableError(error)).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('并发恢复不同渠道时，各自的结果查询始终使用原渠道和凭据', async () => {
    let resolveStatusA: (response: Response) => void = () => undefined
    let statusAStarted: () => void = () => undefined
    const statusReady = new Promise<void>((resolve) => { statusAStarted = resolve })
    const statusA = new Promise<Response>((resolve) => { resolveStatusA = resolve })
    const calls: Array<{ url: string; key: string | null; target: string | null }> = []
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const headers = new Headers(init?.headers)
      const url = String(input)
      const target = headers.get('x-fal-target-url')
      calls.push({ url, key: headers.get('authorization'), target })
      if (url.endsWith('/fal-a') && target?.includes('/status')) {
        statusAStarted()
        return statusA
      }
      if (target?.includes('/status')) return json({ status: 'COMPLETED' })
      return json({ images: [{ b64_json: 'aW1hZ2U=' }] })
    }))

    const first = getFalQueuedImageResult({ ...profile, apiKey: 'key-a' }, 'openai/gpt-image-2', 'id-a', DEFAULT_PARAMS)
    await statusReady
    await getFalQueuedImageResult({ ...profile, baseUrl: 'https://site.test/api/relay/fal-b/', apiKey: 'key-b' }, 'openai/gpt-image-2', 'id-b', DEFAULT_PARAMS)
    resolveStatusA(json({ status: 'COMPLETED' }))
    await first

    expect(calls.filter((call) => call.target?.includes('id-a')).map((call) => [call.url, call.key])).toEqual([
      ['https://site.test/api/relay/fal-a', 'Key key-a'],
      ['https://site.test/api/relay/fal-a', 'Key key-a'],
    ])
    expect(calls.filter((call) => call.target?.includes('id-b')).every((call) => call.url.endsWith('/fal-b') && call.key === 'Key key-b')).toBe(true)
  })
})
