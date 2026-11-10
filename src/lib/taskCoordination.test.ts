// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'

const running: TaskRecord = { id: 'running', prompt: 'test', params: DEFAULT_PARAMS, inputImageIds: [], outputImages: [], status: 'running', error: null, createdAt: 1, finishedAt: null, elapsed: null }

describe('cross-tab task ownership', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    localStorage.clear()
    const held = new Set<string>()
    vi.stubGlobal('navigator', { locks: {
      query: async () => ({ held: [...held].map((name) => ({ name })) }),
      request: async (name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
        if (held.has(name)) return callback(null)
        held.add(name)
        try { await callback({ name }) } finally { held.delete(name) }
      },
    } })
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('另一页面的运行任务不会被标为中断，也无法取得重复执行权', async () => {
    const first = await import('./taskCoordination')
    expect(await first.claimTask(running.id)).toBe(true)
    vi.resetModules()
    const second = await import('./taskCoordination')
    expect(await second.claimTask(running.id)).toBe(false)
    const write = vi.fn()
    expect(await second.reconcileTaskSnapshot([running], async () => [running], write)).toEqual([running])
    expect(write).not.toHaveBeenCalled()
    first.releaseTask(running.id)
  })

  it('获得锁后重读完成结果，旧 running 快照不能覆盖已保存成品', async () => {
    const coordination = await import('./taskCoordination')
    const done = { ...running, status: 'done' as const, outputImages: ['output'], finishedAt: 10 }
    const write = vi.fn()
    expect(await coordination.reconcileTaskSnapshot([running], async () => [done], write)).toEqual([done])
    expect(write).not.toHaveBeenCalled()
    expect(coordination.ownsTask(running.id)).toBe(false)
  })

  it('无人执行的运行任务才标记中断，写入失败也释放锁', async () => {
    const coordination = await import('./taskCoordination')
    const write = vi.fn(async () => { throw new Error('disk full') })
    await expect(coordination.reconcileTaskSnapshot([running], async () => [running], write)).rejects.toThrow('disk full')
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', error: '请求中断' }))
    expect(coordination.ownsTask(running.id)).toBe(false)
  })
})
