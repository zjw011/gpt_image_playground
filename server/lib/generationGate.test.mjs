import { describe, expect, it } from 'vitest'

import { createGenerationGate } from './generationGate.mjs'

describe('生图资源闸门', () => {
  it('限制单用户并发并在完成后释放', () => {
    const gate = createGenerationGate({ globalLimit: 5, identityLimit: 1, perMinute: 10 })
    const first = gate.acquire('u-1', 1_000)
    expect(first.ok).toBe(true)
    expect(gate.acquire('u-1', 1_001)).toMatchObject({ ok: false, reason: 'identity' })

    first.release()
    expect(gate.acquire('u-1', 1_002).ok).toBe(true)
  })

  it('限制全站并发但不影响已完成的请求', () => {
    const gate = createGenerationGate({ globalLimit: 1, identityLimit: 2, perMinute: 10 })
    const first = gate.acquire('u-1', 1_000)
    expect(gate.acquire('u-2', 1_001)).toMatchObject({ ok: false, reason: 'global' })

    first.release()
    expect(gate.acquire('u-2', 1_002).ok).toBe(true)
  })

  it('一分钟频率按用户隔离并给出重试秒数', () => {
    const gate = createGenerationGate({ globalLimit: 5, identityLimit: 2, perMinute: 2 })
    const first = gate.acquire('u-1', 1_000)
    first.release()
    const second = gate.acquire('u-1', 2_000)
    second.release()

    expect(gate.acquire('u-1', 3_000)).toEqual({ ok: false, reason: 'rate', retryAfterSeconds: 58 })
    expect(gate.acquire('u-2', 3_000).ok).toBe(true)
  })
})
