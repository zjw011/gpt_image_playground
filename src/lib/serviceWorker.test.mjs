import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

function worker() {
  const handlers = {}
  const cache = { put: vi.fn(), match: vi.fn() }
  const caches = { open: vi.fn(async () => cache), keys: vi.fn(async () => []), delete: vi.fn() }
  const fetch = vi.fn()
  runInNewContext(readFileSync('public/sw.js', 'utf8'), {
    self: { location: new URL('https://example.com/app/sw.js?v=2'), registration: { scope: 'https://example.com/app/' },
      addEventListener: (name, handler) => { handlers[name] = handler },
      clients: { claim: vi.fn() }, skipWaiting: vi.fn() },
    caches, fetch, URL, Response,
  })
  return { handlers, cache, caches, fetch }
}

describe('离线应用缓存', () => {
  it('激活只清理本应用同作用域的旧缓存', async () => {
    const w = worker()
    w.caches.keys.mockResolvedValue(['other-site', 'gpt-image-playground:https://example.com/other/:v1',
      'gpt-image-playground:https://example.com/app/:v1', 'gpt-image-playground:https://example.com/app/:v2'])
    let done
    w.handlers.activate({ waitUntil: (value) => { done = value } })
    await done
    expect(w.caches.delete.mock.calls).toEqual([['gpt-image-playground:https://example.com/app/:v1']])
  })

  it.each([503, 404])('HTTP %i 不覆盖正常首页', async (status) => {
    const w = worker()
    w.fetch.mockResolvedValue(new Response('维护中', { status, headers: { 'content-type': 'text/html' } }))
    let response
    w.handlers.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://example.com/app/studio' },
      respondWith: (value) => { response = value }, waitUntil: vi.fn() })
    expect((await response)?.status).toBe(status)
    expect(w.cache.put).not.toHaveBeenCalled()
  })

  it('正常HTML才更新离线入口，离线时只读本作用域', async () => {
    const w = worker()
    const html = new Response('<html>正常</html>', { headers: { 'content-type': 'text/html' } })
    w.fetch.mockResolvedValueOnce(html).mockRejectedValueOnce(new Error('offline'))
    w.cache.match.mockResolvedValue(html)
    let response
    const event = { request: { method: 'GET', mode: 'navigate', url: 'https://example.com/app/studio' },
      respondWith: (value) => { response = value }, waitUntil: vi.fn() }
    w.handlers.fetch(event)
    await response
    expect(w.cache.put).toHaveBeenCalledOnce()
    w.handlers.fetch(event)
    expect(await response).toBe(html)
    expect(w.caches.open).toHaveBeenCalledWith('gpt-image-playground:https://example.com/app/:v2')
  })
})
