import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '../types'

describe('IndexedDB transaction durability', () => {
  let req: { result: string; error: Error | null; onsuccess?: () => void }
  let tx: { error: Error | null; objectStore: ReturnType<typeof vi.fn>; oncomplete?: () => void; onabort?: () => void; onerror?: () => void }
  let db: { transaction: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; onversionchange?: () => void }
  let opening: { result: typeof db; onsuccess?: () => void; onblocked?: () => void }
  let open: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    req = { result: 'task', error: null }
    tx = { error: null, objectStore: vi.fn(() => ({ put: () => req, getAll: () => req })) }
    db = { transaction: vi.fn(() => tx), close: vi.fn() }
    opening = { result: db }
    open = vi.fn(() => opening)
    vi.stubGlobal('indexedDB', { open })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('请求成功后事务 abort 仍拒绝保存，不提前报告成功', async () => {
    const { putTask } = await import('./db')
    let settled = false
    const saving = putTask({ id: 'task' } as TaskRecord)
    const checked = expect(saving).rejects.toThrow('事务已取消')
    void saving.then(() => { settled = true }, () => {})
    opening.onsuccess?.()
    await Promise.resolve()
    req.onsuccess?.()
    await Promise.resolve()
    expect(settled).toBe(false)
    tx.onabort?.()
    await checked
  })

  it('复用连接，事务提交后才返回结果，版本改变关闭旧连接', async () => {
    const { putTask } = await import('./db')
    const saving = putTask({ id: 'task' } as TaskRecord)
    opening.onsuccess?.()
    await Promise.resolve()
    tx.oncomplete?.()
    await expect(saving).resolves.toBe('task')
    const second = putTask({ id: 'task' } as TaskRecord)
    await Promise.resolve()
    tx.oncomplete?.()
    await second
    expect(open).toHaveBeenCalledOnce()
    db.onversionchange?.()
    expect(db.close).toHaveBeenCalledOnce()
    const third = putTask({ id: 'task' } as TaskRecord)
    expect(open).toHaveBeenCalledTimes(2)
    opening.onsuccess?.()
    await Promise.resolve()
    tx.oncomplete?.()
    await third
  })

  it('被旧页面阻止升级时给出明确错误，迟到连接会关闭', async () => {
    const { putTask } = await import('./db')
    const saving = putTask({ id: 'task' } as TaskRecord)
    const checked = expect(saving).rejects.toThrow('关闭旧版本页面')
    opening.onblocked?.()
    await checked
    opening.onsuccess?.()
    expect(db.close).toHaveBeenCalledOnce()
  })
})
