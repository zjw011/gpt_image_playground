import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWithDeadline } from './requestDeadline'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('站内请求期限', () => {
  it('响应头到达后仍限制卡住的正文', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (_input, options) => ({
      arrayBuffer: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))),
    })))
    const request = fetchWithDeadline('/api/bootstrap', {}, 50)
    const check = expect(request).rejects.toThrow('请求超时')
    await vi.advanceTimersByTimeAsync(50)
    await check
    expect(vi.getTimerCount()).toBe(0)
  })

  it('保留状态、头与正文并清理计时器', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"失败"}', { status: 503, headers: { 'Content-Type': 'application/json' } })))
    const response = await fetchWithDeadline('/api/bootstrap')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: '失败' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
