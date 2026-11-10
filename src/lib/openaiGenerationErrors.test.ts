import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type CustomProviderDefinition } from '../types'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS } from './apiProfiles'
import { classifyGenerationError } from './generationError.mjs'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'

const options = { settings: DEFAULT_SETTINGS, prompt: 'test image', params: { ...DEFAULT_PARAMS }, inputImageDataUrls: [] }
const completed = { id: 'image-ok', type: 'image_generation_call', status: 'completed', result: 'ZmluYWw=', size: '1024x1024' }
const rejected = { id: 'image-rejected', type: 'image_generation_call', status: 'failed', error: { code: 'content_policy_violation', message: 'Request rejected' } }
const provider: CustomProviderDefinition = {
  id: 'test-async', name: 'test async', template: 'http-image',
  submit: { path: 'submit', taskIdPath: 'task_id' },
  poll: {
    path: 'tasks/{task_id}', statusPath: 'status', successValues: ['completed'], failureValues: ['failed'],
    errorPath: 'diagnostics.failure', result: { b64JsonPaths: ['result.b64_json'] },
  },
}

afterEach(() => vi.restoreAllMocks())

describe('Images 部分结果保留', () => {
  it('同步结果保留有效图片，审核失败条目的 URL 不下载', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [
      { b64_json: 'b25l', revised_prompt: 'first image', size: '1024x1024' },
      { error: rejected.error, url: 'https://images.example/blocked.png' },
    ] })))
    const result = await callOpenAICompatibleImageApi(options, createDefaultOpenAIProfile({ apiKey: 'test', apiMode: 'images', streamImages: false }))

    expect(result.images).toEqual(['data:image/png;base64,b25l'])
    expect(result.revisedPrompts).toEqual(['first image'])
    expect(result.actualParamsList).toEqual([{ size: '1024x1024' }])
    expect(result.failedRequests).toHaveLength(1)
    expect(classifyGenerationError(result.failedRequests?.[0].error)).toBe('content_policy')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('中间图片下载失败后保留前后成功图片及对应参数顺序', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [
        { b64_json: 'b25l', revised_prompt: 'first', size: '1024x1024' },
        { url: 'https://images.example/unavailable.png', revised_prompt: 'missing', size: '1024x1536' },
        { b64_json: 'dHdv', revised_prompt: 'third', size: '1536x1024' },
      ] })))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const result = await callOpenAICompatibleImageApi(options, createDefaultOpenAIProfile({ apiKey: 'test', apiMode: 'images', streamImages: false }))

    expect(result.images).toEqual(['data:image/png;base64,b25l', 'data:image/png;base64,dHdv'])
    expect(result.revisedPrompts).toEqual(['first', 'third'])
    expect(result.actualParamsList).toEqual([{ size: '1024x1024' }, { size: '1536x1024' }])
    expect(result.failedRequests).toEqual([{ requestIndex: 1, error: expect.stringContaining('图片链接下载失败') }])
  })

  it('流式完成事件保留成功图片和审核错误，并保持逐图参数对应', async () => {
    const events = [
      { type: 'image_generation.completed', b64_json: 'b25l', revised_prompt: 'first', size: '1024x1024' },
      { type: 'image_generation.completed', status: 'failed', error: rejected.error, url: 'https://images.example/blocked.png' },
      { type: 'image_generation.completed', b64_json: 'dHdv', revised_prompt: 'third', size: '1536x1024' },
    ]
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const result = await callOpenAICompatibleImageApi(options, createDefaultOpenAIProfile({ apiKey: 'test', apiMode: 'images', streamImages: true }))

    expect(result.images).toEqual(['data:image/png;base64,b25l', 'data:image/png;base64,dHdv'])
    expect(result.revisedPrompts).toEqual(['first', 'third'])
    expect(result.actualParamsList).toEqual([{ size: '1024x1024' }, { size: '1536x1024' }])
    expect(result.failedRequests).toHaveLength(1)
    expect(result.failedRequests?.[0].requestIndex).toBe(1)
    expect(classifyGenerationError(result.failedRequests?.[0].error)).toBe('content_policy')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('Responses 部分结果保留', () => {
  it('非流式结果保留成功图片及失败工具的审核原因', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ output: [completed, rejected] })))
    const result = await callOpenAICompatibleImageApi(options, createDefaultOpenAIProfile({ apiKey: 'test', apiMode: 'responses', streamImages: false }))

    expect(result.images).toEqual(['data:image/png;base64,ZmluYWw='])
    expect(result.failedRequests).toHaveLength(1)
    expect(classifyGenerationError(result.failedRequests?.[0].error)).toBe('content_policy')
  })

  it.each([false, true])('流式单工具失败不截断后续成功图片，拒绝事件在前=%s', async (failureFirst) => {
    const output = failureFirst ? [rejected, completed] : [completed, rejected]
    const events = [
      ...output.map((item) => ({ type: 'response.output_item.done', item })),
      { type: 'response.completed', response: { output } },
    ]
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const result = await callOpenAICompatibleImageApi(options, createDefaultOpenAIProfile({ apiKey: 'test', apiMode: 'responses', streamImages: true }))

    expect(result.images).toEqual(['data:image/png;base64,ZmluYWw='])
    expect(result.failedRequests).toHaveLength(1)
    expect(classifyGenerationError(result.failedRequests?.[0].error)).toBe('content_policy')
  })

  it('流式顶层失败保留已完成图片并记录失败，不把部分预览当完成图', async () => {
    const events = [
      { type: 'response.image_generation_call.partial_image', partial_image_b64: 'cHJldmlldw==' },
      { type: 'response.output_item.done', item: completed },
      { type: 'response.failed', response: { status: 'failed', error: { code: 'content_policy_violation', message: 'Second image rejected' } } },
    ]
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const result = await callOpenAICompatibleImageApi(options, createDefaultOpenAIProfile({ apiKey: 'test', apiMode: 'responses', streamImages: true }))

    expect(result.images).toEqual(['data:image/png;base64,ZmluYWw='])
    expect(result.failedRequests).toHaveLength(1)
    expect(result.failedRequests?.[0].error).toContain('Second image rejected')
  })

  it('只有预览图且最终拒绝时仍然失败', async () => {
    const events = [
      { type: 'response.image_generation_call.partial_image', partial_image_b64: 'cHJldmlldw==' },
      { type: 'response.completed', response: { output: [rejected] } },
    ]
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const err = await callOpenAICompatibleImageApi(options, createDefaultOpenAIProfile({ apiKey: 'test', apiMode: 'responses', streamImages: true })).catch((error: unknown) => error)

    expect(classifyGenerationError(err)).toBe('content_policy')
  })

  it('最终快照省略工具 ID 并带有文本时不重复已经收到的图片', async () => {
    const events = [
      { type: 'response.output_item.done', item: completed },
      { type: 'response.completed', response: { output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Completed' }] },
        { ...completed, id: undefined },
      ] } },
    ]
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const result = await callOpenAICompatibleImageApi(options, createDefaultOpenAIProfile({ apiKey: 'test', apiMode: 'responses', streamImages: true }))

    expect(result.images).toEqual(['data:image/png;base64,ZmluYWw='])
    expect(result.failedRequests).toBeUndefined()
  })

  it('并发部分成功仍保留每个响应内部的局部失败', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: [completed, rejected] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: [{ ...completed, id: 'image-2', result: 'dHdv' }] })))
    const result = await callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, n: 2 } }, createDefaultOpenAIProfile({ apiKey: 'test', apiMode: 'responses', streamImages: false }))

    expect(result.images).toEqual(['data:image/png;base64,ZmluYWw=', 'data:image/png;base64,dHdv'])
    expect(result.failedRequests).toHaveLength(1)
    expect(result.failedRequests?.[0].requestIndex).toBe(0)
    expect(classifyGenerationError(result.failedRequests?.[0].error)).toBe('content_policy')
  })

  it('并发全失败时明确审核拒绝优先于未知取消', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'cancelled' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: rejected.error })))
    const err = await callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, n: 2 } }, createDefaultOpenAIProfile({ apiKey: 'test', apiMode: 'responses', streamImages: false })).catch((error: unknown) => error)

    expect(classifyGenerationError(err)).toBe('content_policy')
  })
})

describe('自定义轮询错误映射', () => {
  it.each(['failed', 'completed'])('保留映射位置的审核错误，状态为 %s', async (status) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-1' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status, diagnostics: { failure: rejected.error } })))
    const err = await callOpenAICompatibleImageApi(options, createDefaultOpenAIProfile({ apiKey: 'test', apiProxy: false }), provider).catch((error: unknown) => error)

    expect(classifyGenerationError(err)).toBe('content_policy')
    expect((err as Error).message).toContain('Request rejected')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('普通失败保留自定义错误路径中的具体诊断', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-1' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'failed', diagnostics: { failure: 'unsupported image dimensions' } })))
    await expect(callOpenAICompatibleImageApi(options, createDefaultOpenAIProfile({ apiKey: 'test', apiProxy: false }), provider)).rejects.toThrow('unsupported image dimensions')
  })
})
