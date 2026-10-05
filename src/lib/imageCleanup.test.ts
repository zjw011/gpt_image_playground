// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanVisibleWatermark, imageCleanupMessage } from './imageCleanup'

describe('可见水印下载副本', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  it('确认清理成功才替换下载副本，原始 Blob 不修改', async () => {
    const input = new Blob(['original'], { type: 'image/png' })
    const fetch = vi.fn().mockResolvedValue(new Response('cleaned', { headers: { 'X-Cleanup-Status': 'cleaned', 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetch)
    const result = await cleanVisibleWatermark(input)
    expect(result.status).toBe('cleaned')
    expect(result.blob).not.toBe(input)
    expect(fetch.mock.calls[0][1].body).toBe(input)
  })
  it.each(['partial', 'unvalidated', 'no_watermark'])('未确认成功时保留原始字节：%s', async (status) => {
    const input = new Blob(['original'], { type: 'image/png' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('changed', { headers: { 'X-Cleanup-Status': status, 'content-type': 'image/png' } })))
    const result = await cleanVisibleWatermark(input)
    expect(result.blob).toBe(input)
    expect(imageCleanupMessage(result.status)).toContain('原图')
  })
  it('格式和大小在发送之前校验', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(cleanVisibleWatermark(new Blob(['gif'], { type: 'image/gif' }))).rejects.toThrow('静态图片')
    await expect(cleanVisibleWatermark(new Blob([new Uint8Array(16 * 1024 * 1024 + 1)], { type: 'image/png' }))).rejects.toThrow('16MB')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('服务错误不冒充成功，用户可取消勾选下载原图', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: '繁忙' }), { status: 429 })))
    await expect(cleanVisibleWatermark(new Blob(['png'], { type: 'image/png' }))).rejects.toThrow('繁忙')
  })
  it('不接受未知状态和伪装的 HTML 图片', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    fetch.mockResolvedValueOnce(new Response('x', { headers: { 'X-Cleanup-Status': 'unknown' } }))
    await expect(cleanVisibleWatermark(new Blob(['png'], { type: 'image/png' }))).rejects.toThrow('状态')
    fetch.mockResolvedValueOnce(new Response('x', { headers: { 'X-Cleanup-Status': 'cleaned', 'content-type': 'text/html' } }))
    await expect(cleanVisibleWatermark(new Blob(['png'], { type: 'image/png' }))).rejects.toThrow('图片无效')
  })
})
