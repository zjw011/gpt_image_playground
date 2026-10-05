import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleImageCleanup } from './imageCleanup.mjs'

function request(data = Buffer.from('image'), headers = {}) {
  const req = Readable.from([data])
  req.method = 'POST'
  req.headers = { 'content-type': 'image/png', ...headers }
  req.setTimeout = vi.fn()
  return req
}
function response() {
  const res = new EventEmitter()
  res.writeHead = vi.fn()
  res.end = vi.fn()
  return res
}
let userId = 0
const context = () => ({ user: { id: `cleanup-${userId++}` } })
describe('可见水印下载代理', () => {
  beforeEach(() => vi.stubEnv('GIP_WATERMARK_URL', 'http://127.0.0.1:8090'))
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
  it('未登录不可使用，且不调用处理服务', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(handleImageCleanup(request(), response(), { user: null })).rejects.toMatchObject({ status: 401 })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('探测不泄漏内部地址，无服务时明确不可用', async () => {
    vi.stubEnv('GIP_WATERMARK_URL', '')
    const req = request()
    req.method = 'GET'
    const res = response()
    await handleImageCleanup(req, res, context())
    expect(res.end.mock.calls[0][0].toString()).toContain('"available":false')
    expect(res.end.mock.calls[0][0].toString()).not.toContain('127.0.0.1')
    await expect(handleImageCleanup(request(), response(), context())).rejects.toMatchObject({ status: 503 })
  })
  it('拒绝格式、空图以及超大请求', async () => {
    await expect(handleImageCleanup(request(Buffer.from('a'), { 'content-type': 'image/gif' }), response(), context())).rejects.toMatchObject({ status: 415 })
    await expect(handleImageCleanup(request(Buffer.alloc(0)), response(), context())).rejects.toMatchObject({ status: 400 })
    await expect(handleImageCleanup(request(Buffer.from('a'), { 'content-length': 17 * 1024 * 1024 }), response(), context())).rejects.toMatchObject({ status: 413 })
    await expect(handleImageCleanup(request(Buffer.alloc(16 * 1024 * 1024 + 1)), response(), context())).rejects.toMatchObject({ status: 413 })
  })
  it('只发送字节到固定工作服务，不转发用户凭据，返回状态且不缓存', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(Buffer.from('output'), { headers: { 'content-type': 'image/png', 'X-Cleanup-Status': 'cleaned' } }))
    vi.stubGlobal('fetch', fetch)
    const res = response()
    await handleImageCleanup(request(Buffer.from('input'), { cookie: 'secret' }), res, context())
    expect(String(fetch.mock.calls[0][0])).toBe('http://127.0.0.1:8090/clean')
    expect(fetch.mock.calls[0][1].body.toString()).toBe('input')
    expect(fetch.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'image/png' })
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Cache-Control': 'no-store', 'X-Cleanup-Status': 'cleaned' }))
    expect(res.end.mock.calls[0][0].toString()).toBe('output')
  })
  it.each(['invalid-status', 'invalid-type', 'empty', 'error'])('拒绝无效工作服务结果：%s', async (mode) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(mode === 'empty' ? '' : 'image', { status: mode === 'error' ? 500 : 200, headers: { 'content-type': mode === 'invalid-type' ? 'text/html' : 'image/png', 'X-Cleanup-Status': mode === 'invalid-status' ? 'unknown' : 'cleaned' } })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(handleImageCleanup(request(), response(), context())).rejects.toMatchObject({ status: 503 })
  })
  it('同一用户不可并发，失败后释放占位', async () => {
    let reject
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise((_, fail) => { reject = fail })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = context()
    const first = handleImageCleanup(request(), response(), ctx)
    await vi.waitFor(() => expect(reject).toBeTruthy())
    await expect(handleImageCleanup(request(), response(), ctx)).rejects.toMatchObject({ status: 429 })
    reject(new Error('test'))
    await expect(first).rejects.toMatchObject({ status: 503 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('original', { headers: { 'content-type': 'image/png', 'X-Cleanup-Status': 'no_watermark' } })))
    await expect(handleImageCleanup(request(), response(), ctx)).resolves.toBeUndefined()
  })
})
