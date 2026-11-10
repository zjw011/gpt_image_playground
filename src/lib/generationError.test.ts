import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { callImageApi } from './api'
import { DEFAULT_SETTINGS, getCustomProviderDefinition } from './apiProfiles'
import { classifyGenerationError, formatGenerationError, getGenerationResponseError } from './generationError.mjs'
import { fetchImageUrlAsDataUrl, getApiErrorMessage, maybeAppendStreamingHint } from './imageApiShared'
import { getCustomQueuedImageResult } from './openaiCompatibleImageApi'

afterEach(() => vi.restoreAllMocks())

describe('生成失败只依据明确的上游诊断', () => {
  it.each([
    { error: { code: 'content_policy_violation', message: 'Request rejected' } },
    { status: 'cancelled', error: { code: 'moderation_blocked' } },
    { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot comply' }] }] },
    { incomplete_details: { reason: 'content_filter' } },
    { detail: [{ type: 'content_policy_violation', msg: 'Rejected' }] },
    'Your request was rejected as a result of our safety system',
    '内容安全审核未通过',
  ])('保留审核依据：%j', (payload) => {
    expect(classifyGenerationError(payload)).toBe('content_policy')
    expect(classifyGenerationError(formatGenerationError(payload))).toBe('content_policy')
  })

  it.each([
    { status: 'completed', prompt: 'nsfw', revised_prompt: 'content_policy_violation', data: [{ url: 'https://example.com/cancelled.png' }] },
    { error: null, errors: [], data: [{ b64_json: 'content_policy_violation' }] },
    { error: {}, status: 'completed' },
    { data: ['https://example.com/cancelled.png'] },
    { status: 'completed', message: 'Safety checker passed', data: [{ b64_json: 'AAAA' }] },
    'HTTP 403: Access denied',
    'Failed to fetch',
    '图片已生成，但因服务商未允许跨域，图片链接下载失败',
    'HTTP 500: {"error":{"message":"internal error"},"prompt":"content_policy_violation"}',
    new Error('HTTP 500: {"error":{"message":"internal error"},"prompt":"content_policy_violation"}'),
    'HTTP 500: {"error":{"message":"internal error"},"prompt":"content_policy_violation',
  ])('成功字段和普通故障不能猜成审核或取消：%j', (payload) => {
    expect(classifyGenerationError(payload)).toBeNull()
    if (typeof payload === 'object' && !(payload instanceof Error)) expect(getGenerationResponseError(payload)).toBeNull()
  })

  it('取消不推断为成人内容，超时中止优先保留超时原因', () => {
    expect(classifyGenerationError({ status: 'cancelled' })).toBe('cancelled')
    expect(classifyGenerationError('Request cancelled after timeout')).toBe('timeout')
    expect(getGenerationResponseError({ status: 'cancelled', data: [{ url: 'https://example.com/a.png' }] })).toContain('已取消')
  })

  it.each([400, 403, 500])('HTTP %s 的审核码不被泛化 message 覆盖，也不建议关闭流式', async (status) => {
    const message = await getApiErrorMessage(new Response(JSON.stringify({ error: { code: 'content_policy_violation', message: 'Rejected' } }), { status }))
    expect(classifyGenerationError(message)).toBe('content_policy')
    expect(message).toContain('Rejected')
    expect(maybeAppendStreamingHint(message, status, true)).toBe(message)
  })
})

describe('图片 API 的同步、流式和异步失败', () => {
  it.each([
    { apiMode: 'images' as const, payload: { error: { code: 'content_policy_violation' }, data: [] } },
    { apiMode: 'responses' as const, payload: { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot comply' }] }] } },
    { apiMode: 'images' as const, payload: { data: [{ error: { code: 'moderation_blocked' }, url: 'https://example.com/no-image' }] } },
  ])('HTTP 200 错误被识别且不会去下载：$apiMode', async ({ apiMode, payload }) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload)))
    await expect(callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test', apiMode, streamImages: false },
      prompt: 'test', params: { ...DEFAULT_PARAMS }, inputImageDataUrls: [],
    })).rejects.toThrow('内容安全审核未通过')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(['images', 'responses'] as const)('流式嵌套错误不变成无图片：%s', async (apiMode) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: 'content_policy_violation', message: 'Rejected' } } })}\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    await expect(callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test', apiMode, streamImages: true },
      prompt: 'test', params: { ...DEFAULT_PARAMS }, inputImageDataUrls: [],
    })).rejects.toThrow('内容安全审核未通过')
  })

  it.each([
    { status: 200, body: { status: 'cancelled' }, message: '已取消' },
    { status: 200, body: { status: 'failed', error: { code: 'content_policy_violation' } }, message: '内容安全审核未通过' },
    { status: 500, body: { error: { code: 'content_policy_violation' } }, message: '内容安全审核未通过' },
  ])('异步终态或明确拒绝不无限轮询：$status $message', async ({ status, body, message }) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }))
    const provider = getCustomProviderDefinition(DEFAULT_SETTINGS, 'sb2api-async')!
    await expect(getCustomQueuedImageResult(DEFAULT_SETTINGS.profiles[0], provider, 'task-test', DEFAULT_PARAMS)).rejects.toThrow(message)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('多图全部失败时优先保留内容拒绝，不用首张网络错误掩盖它', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'content_policy_violation' } })))
    await expect(callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test', apiMode: 'responses', streamImages: false },
      prompt: 'test', params: { ...DEFAULT_PARAMS, n: 2 }, inputImageDataUrls: [],
    })).rejects.toThrow('内容安全审核未通过')
  })
})

describe('图片链接取回失败', () => {
  it('网络失败不再用不透明探测响应断言图片已生成或已确认跨域', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(fetchImageUrlAsDataUrl('https://example.com/image', 'image/png')).rejects.toThrow('图片链接下载失败')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([200, 403])('图片链接 HTTP %s 返回审核 JSON 时保留实际拒绝原因', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'content_policy_violation', message: 'Rejected' } }), {
      status, headers: { 'Content-Type': 'application/json' },
    }))
    await expect(fetchImageUrlAsDataUrl('https://example.com/image', 'image/png')).rejects.toThrow('内容安全审核未通过')
  })

  it.each([
    new Response('<html>Expired</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('', { headers: { 'Content-Type': 'image/png' } }),
  ])('HTML 或空文件不当作生成图片存入作品', async (response) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    await expect(fetchImageUrlAsDataUrl('https://example.com/image', 'image/png')).rejects.toThrow('图片结果下载失败')
  })
})
