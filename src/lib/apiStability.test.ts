import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type ApiProfile, type CustomProviderDefinition } from '../types'
import { callImageApi } from './api'
import { DEFAULT_SETTINGS, getCustomProviderDefinition } from './apiProfiles'
import { isFailoverableError } from './failover'
import { fetchImageUrlAsDataUrl, type CallApiOptions } from './imageApiShared'
import { getCustomQueuedImageResult } from './openaiCompatibleImageApi'
import { getTaskFailureHint } from './taskFailure'

function options(overrides: Partial<ApiProfile> = {}): CallApiOptions {
  const profile = { ...DEFAULT_SETTINGS.profiles[0], id: 'stability', apiKey: 'test', baseUrl: 'https://api.example.com/v1', timeout: 1, streamImages: false, ...overrides }
  return {
    settings: { ...DEFAULT_SETTINGS, ...profile, profiles: [profile], activeProfileId: profile.id },
    params: { ...DEFAULT_PARAMS }, prompt: '测试描述', inputImageDataUrls: [],
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('请求的切换所有权和超时', () => {
  it.each([false, true])('只有进入客户端编排的请求才接管中继重试：%s', async (clientFailover) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] })))
    await callImageApi({ ...options({ baseUrl: '/api/relay/first/' }), clientFailover })
    const headers = new Headers(fetch.mock.calls[0][1]?.headers)
    expect(headers.get('x-gip-failover')).toBe(clientFailover ? 'client' : null)
    expect(headers.get('x-gip-keepalive')).toBe('1')
  })

  it.each([401, 402, 429])('本站 HTTP %s 拒绝不会换渠道，上游同状态仍可切换', async (status) => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: '请求受限' }), { status, headers: { 'X-GIP-Failover': 'stop' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: '请求受限' }), { status }))
    const local = await callImageApi(options()).catch((err) => err)
    expect(local).toMatchObject({ status, retryable: false })
    expect(isFailoverableError(local)).toBe(false)
    const upstream = await callImageApi(options()).catch((err) => err)
    expect(isFailoverableError(upstream)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each(['images', 'responses'] as const)('读取 %s 普通正文超时保留超时语义，不误判为主动取消', async (apiMode) => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('The operation was aborted', 'AbortError')), { once: true })
      },
    })))
    const result = callImageApi(options({ apiMode })).catch((err) => err)
    await vi.advanceTimersByTimeAsync(1000)
    const error = await result
    expect(error.message).toContain('超时')
    expect(isFailoverableError(error)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['images', 'responses'] as const)('%s 建立流式响应后仍有超时保护', async (apiMode) => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'text/event-stream' } }))
    const result = callImageApi(options({ apiMode, streamImages: true })).catch((err) => err)
    await vi.advanceTimersByTimeAsync(1000)
    const error = await result
    expect(error.message).toContain('超时')
    expect(isFailoverableError(error)).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('普通图片响应同时有成功图片和顶层失败时保留成品', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }], error: { message: '第二张生成失败' } })))
    const result = await callImageApi(options())
    expect(result.images).toEqual(['data:image/png;base64,AAAA'])
    expect(result.failedRequests?.[0].error).toContain('第二张生成失败')
  })

  it.each(['images', 'responses'] as const)('同步 %s 意外返回受理任务时不重新提交', async (apiMode) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ task_id: 'accepted-elsewhere', error: { message: '查询暂时不可用' } })))
    const error = await callImageApi(options({ apiMode })).catch((err) => err)
    expect(error.message).toContain('查询暂时不可用')
    expect(isFailoverableError(error)).toBe(false)
    expect(error.rawResponsePayload).toContain('accepted-elsewhere')
  })

  it('并发请求全部失败但已有结果链接时，不因另一项网络错误重投整单', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://images.example.com/result.png' }] })))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const opts = options({ codexCli: true })
    const error = await callImageApi({ ...opts, params: { ...opts.params, n: 2 } }).catch((err) => err)
    expect(error.message).toContain('图片链接下载失败')
    expect(isFailoverableError(error)).toBe(false)
  })
})

describe('异步任务只查询原任务', () => {
  const provider = getCustomProviderDefinition(DEFAULT_SETTINGS, 'sb2api-async')!
  const pollingProvider: CustomProviderDefinition = { ...provider, poll: { ...provider.poll!, intervalSeconds: 1 } }

  it('查询长时间不返回时中止本次连接，继续取同一个任务', async () => {
    vi.useFakeTimers()
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce((_, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', result: { data: [{ b64_json: 'AAAA' }] } })))
    const result = getCustomQueuedImageResult(options().settings.profiles[0], pollingProvider, 'task-1', DEFAULT_PARAMS)
    await vi.advanceTimersByTimeAsync(11_000)
    expect((await result).images).toEqual(['data:image/png;base64,AAAA'])
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).toContain('/images/tasks/task-1')
      expect(init?.method).toBe('GET')
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('连续查询故障有退避且交给持久化恢复，不永久卡在一次调用', async () => {
    vi.useFakeTimers()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'busy' }), { status: 503 }))
    const result = getCustomQueuedImageResult(options().settings.profiles[0], pollingProvider, 'task-2', DEFAULT_PARAMS).catch((err) => err)
    await vi.advanceTimersByTimeAsync(3000)
    expect((await result).message).toContain('异步任务查询暂时失败：HTTP 503')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('查询被本站明确停止时不在内部重试', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: '需要登录' }), { status: 401, headers: { 'X-GIP-Failover': 'stop' } }))
    await expect(getCustomQueuedImageResult(options().settings.profiles[0], pollingProvider, 'task-2', DEFAULT_PARAMS)).rejects.toMatchObject({ retryable: false })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('提交响应有任务 ID 和失败说明时先记录受理事实', async () => {
    const onCustomTaskEnqueued = vi.fn()
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ task_id: 'accepted', error: { message: '服务繁忙' } })))
    await expect(callImageApi({ ...options({ provider: 'sb2api-async' }), onCustomTaskEnqueued })).rejects.toThrow('服务繁忙')
    expect(onCustomTaskEnqueued).toHaveBeenCalledWith({ taskId: 'accepted' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('提交成功但无法提取任务 ID 时不盲目重新生图', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ request_id: 'unmapped' })))
    const error = await callImageApi(options({ provider: 'sb2api-async' })).catch((err) => err)
    expect(error.message).toContain('无法从响应中提取异步任务 ID')
    expect(isFailoverableError(error)).toBe(false)
  })
})

describe('取图和保存失败不丢成品、不再次生成', () => {
  it('自定义同步渠道保留已成功的图片和失败项索引', async () => {
    const opts = options({ provider: 'custom-sync' })
    opts.settings.customProviders = [{ id: 'custom-sync', name: '自定义', template: 'http-image', submit: { path: 'images', result: { b64JsonPaths: ['data.*.b64_json'], imageUrlPaths: ['data.*.url'] } } }]
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }, { url: 'https://images.example.com/expired.png' }, { url: 'data:image/png;base64,BBBB' }] })))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const result = await callImageApi(opts)
    expect(result.images).toEqual(['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'])
    expect(result.failedRequests).toEqual([{ requestIndex: 1, error: expect.stringContaining('图片链接下载失败') }])
    expect(result.rawImageUrls).toEqual(['https://images.example.com/expired.png'])
  })

  it('自定义同步响应带整体失败时不丢掉映射路径中的成品', async () => {
    const opts = options({ provider: 'custom-sync' })
    opts.settings.customProviders = [{ id: 'custom-sync', name: '自定义', template: 'http-image', submit: { path: 'images', result: { b64JsonPaths: ['result.*.b64_json'] } } }]
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ result: [{ b64_json: 'AAAA' }], error: { message: '其余图片失败' } })))
    const result = await callImageApi(opts)
    expect(result.images).toEqual(['data:image/png;base64,AAAA'])
    expect(result.failedRequests).toEqual([{ requestIndex: 1, error: '其余图片失败' }])
  })

  it('下载响应头已到但正文挂住也会超时，并且不能触发重新生成', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true })
      },
    }), { headers: { 'Content-Type': 'image/png' } }))
    const result = fetchImageUrlAsDataUrl('https://images.example.com/image.png', 'image/png').catch((err) => err)
    await vi.advanceTimersByTimeAsync(60_000)
    const error = await result
    expect(error.message).toContain('图片结果下载失败')
    expect(isFailoverableError(error)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('保存失败向用户解释存储问题和停止重投原因', () => {
    const hint = getTaskFailureHint('图片已生成，但保存到浏览器失败：QuotaExceededError')
    expect(hint).toContain('剩余空间')
    expect(hint).toContain('避免重复生图')
  })
})
