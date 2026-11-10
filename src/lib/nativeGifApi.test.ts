import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type ApiProfile } from '../types'
import { callImageApi } from './api'
import { DEFAULT_SETTINGS } from './apiProfiles'
import { isFailoverableError } from './failover'
import { getTaskFailureHint } from './taskFailure'
import type { CallApiOptions } from './imageApiShared'

const header = [71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]
const frame = [0x21, 0xf9, 4, 0, 20, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0]
const gif = btoa(String.fromCharCode(...header, ...frame, ...frame, 0x3b))

function options(patch: Partial<ApiProfile> = {}): CallApiOptions {
  const profile = { ...DEFAULT_SETTINGS.profiles[0], id: 'gif', apiKey: 'test', baseUrl: 'https://api.example.com/v1', model: 'gpt-image-2.6-flare', apiMode: 'images' as const, ...patch }
  return {
    settings: { ...DEFAULT_SETTINGS, ...profile, profiles: [profile], activeProfileId: profile.id },
    params: { ...DEFAULT_PARAMS, output_format: 'gif', frame_count: 4, frame_duration_ms: 200 },
    prompt: '蝴蝶扇动翅膀', inputImageDataUrls: [],
  }
}

afterEach(() => vi.restoreAllMocks())

describe('原生 GIF API', () => {
  it('只提交一次 GIF 请求，忽略静态图不兼容设置并保留真实动画', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: gif }] })))
    const opts = options({ codexCli: true, streamImages: true, responseFormatB64Json: true })
    const result = await callImageApi({ ...opts, params: { ...opts.params, n: 8, transparent_output: true, output_compression: 75 }, nativeTransparentBackground: true })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0][0]).toContain('images/generations')
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      model: 'gpt-image-2.6-flare', prompt: opts.prompt, output_format: 'gif', moderation: 'auto', size: 'auto', quality: 'auto', n: 1, frame_count: 4, frame_duration_ms: 200,
    })
    expect(result.images).toEqual([`data:image/gif;base64,${gif}`])
    expect(result.actualParams).toMatchObject({ output_format: 'gif', size: '1x1', frame_count: 2 })
  })

  it('参考图走 multipart edits，发送帧设置且不传流式和压缩字段', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Blob(['reference'], { type: 'image/png' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: gif }] })))
    const opts = options({ streamImages: true, responseFormatB64Json: true })
    await callImageApi({ ...opts, inputImageDataUrls: ['data:image/png;base64,AAAA'] })
    expect(fetch.mock.calls[1][0]).toContain('images/edits')
    const body = fetch.mock.calls[1][1]?.body as FormData
    expect(body.get('output_format')).toBe('gif')
    expect(body.get('frame_count')).toBe('4')
    expect(body.get('frame_duration_ms')).toBe('200')
    expect(body.get('n')).toBe('1')
    expect(body.getAll('image[]')).toHaveLength(1)
    for (const key of ['mask', 'stream', 'partial_images', 'output_compression', 'response_format', 'background']) expect(body.has(key)).toBe(false)
  })

  it.each([{ model: 'gpt-image-2' }, { apiMode: 'responses' as const }, { supportsNativeGif: false }, { provider: 'fal', supportsNativeGif: true }])('不支持动图时请求前拒绝：%o', async (patch) => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(callImageApi(options(patch))).rejects.toMatchObject({ retryable: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    { maskDataUrl: 'data:image/png;base64,AAAA' },
    { inputImageDataUrls: [`data:image/gif;base64,${gif}`] },
    { inputImageDataUrls: ['data:image/png;base64,AAAA', 'data:image/png;base64,AAAA'] },
  ])('无效参考或遮罩不产生生成请求', async (patch) => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(callImageApi({ ...options(), ...patch })).rejects.toMatchObject({ retryable: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['iVBORw0KGgo=', btoa(String.fromCharCode(...header, ...frame, 0x3b))])('返回静态图不误报成功，也不重投其他付费请求', async (b64) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: b64 }] })))
    const err = await callImageApi(options()).catch((error) => error)
    expect(err.message).toContain('原生 GIF 结果无效')
    expect(isFailoverableError(err)).toBe(false)
    expect(getTaskFailureHint(err)).toContain('未返回有效的多帧 GIF')
  })

  it('兼容误标 MIME，只修正前缀而不改动文件字节', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: `data:application/octet-stream;base64,${gif}` }] })))
    expect((await callImageApi(options())).images).toEqual([`data:image/gif;base64,${gif}`])
  })

  it('上游模型没有可用路由时可回退，内容审核仍终止', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'model not found: dynamic channel binding resolved no channels' } }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'content_policy_violation', message: 'request rejected' } }), { status: 400 }))
    expect(isFailoverableError(await callImageApi(options()).catch((err) => err))).toBe(true)
    expect(isFailoverableError(await callImageApi(options()).catch((err) => err))).toBe(false)
  })
})
