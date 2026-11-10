import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleToolsAssets, handleToolsFetch } from './toolsAssets.mjs'

function response() {
  const res = new EventEmitter()
  res.headers = {}
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value }
  res.writeHead = (status, headers) => { res.status = status; for (const [key, value] of Object.entries(headers || {})) res.setHeader(key, value) }
  res.end = (body) => { res.body = body; res.writableEnded = true }
  return res
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('素材代理边界', () => {
  it.each(['text/html', 'image/svg+xml', 'application/javascript'])('拒绝主动内容 %s', async (type) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<script>danger()</script>', { headers: { 'content-type': type } })))
    const res = response()
    await handleToolsFetch({ method: 'GET' }, res, '?url=https://raw.githubusercontent.com/a/test')
    expect(res.status).toBe(415)
    expect(String(res.body)).not.toContain('<script>')
  })

  it('不信任任意 pages.dev 租户，逐跳拒绝白名单外重定向', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/internal' } }))
    vi.stubGlobal('fetch', fetcher)
    const denied = response()
    await handleToolsFetch({ method: 'GET' }, denied, '?url=https://evil.pages.dev/file.png')
    expect(denied.status).toBe(403)
    expect(fetcher).not.toHaveBeenCalled()
    const redirected = response()
    await handleToolsFetch({ method: 'GET' }, redirected, '?url=https://github.com/a/file.png')
    expect(redirected.status).toBe(403)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('安全图片正常返回，HEAD 不下载正文并提供禁止嗅探/CSP', async () => {
    const fetcher = vi.fn(async () => new Response(null, { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetcher)
    const res = response()
    await handleToolsAssets({ method: 'HEAD' }, res, '/tools-assets/img/test.png')
    expect(res.status).toBe(200)
    expect(fetcher.mock.calls[0][1].method).toBe('HEAD')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toContain('sandbox')
    expect(res.body).toBeUndefined()
  })

  it('同时限制声明和实际下载体积', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { headers: { 'content-type': 'image/png', 'content-length': String(33 * 1024 * 1024) } })))
    const res = response()
    await handleToolsAssets({ method: 'GET' }, res, '/tools-assets/a.png')
    expect(res.status).toBe(413)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(33 * 1024 * 1024), { headers: { 'content-type': 'image/png' } })))
    const actual = response()
    await handleToolsAssets({ method: 'GET' }, actual, '/tools-assets/a.png')
    expect(actual.status).toBe(413)
  })

  it('30秒下载截止覆盖正文等待，关闭客户端也取消下载', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn((url, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))))
    vi.stubGlobal('fetch', fetcher)
    const res = response()
    const pending = handleToolsAssets({ method: 'GET' }, res, '/tools-assets/a.png')
    await vi.advanceTimersByTimeAsync(30_001)
    await pending
    expect(res.status).toBe(502)
    const disconnected = response()
    const second = handleToolsAssets({ method: 'GET' }, disconnected, '/tools-assets/a.png')
    disconnected.destroyed = true
    disconnected.emit('close')
    await second
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true)
  })
})
