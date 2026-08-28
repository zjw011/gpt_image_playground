// 用量统计回归测试：这是唯一一处服务端持久化的"运行时数据"，
// 一旦健康度判定或滚动裁剪出错，后台就会指着好渠道说它挂了，或者让文件无限膨胀。

import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { channelHealth, flushUsage, initUsage, recordChannelCall, resetUsage, usageSummary } from './usage.mjs'

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'gip-usage-'))
  initUsage(dir)
  return dir
}

/** 连续记 n 次同样结果，用来把健康度推到某个状态。 */
function record(channelId, ok, count = 1, patch = {}) {
  for (let i = 0; i < count; i += 1) {
    recordChannelCall({ channelId, ok, status: ok ? 200 : 500, latencyMs: 1000, ...patch })
  }
}

describe('recordChannelCall', () => {
  it('分别累计成败与耗时，平均耗时按总数算', () => {
    freshDir()
    recordChannelCall({ channelId: 'ch-1', ok: true, status: 200, latencyMs: 1000 })
    recordChannelCall({ channelId: 'ch-1', ok: true, status: 200, latencyMs: 3000 })
    recordChannelCall({ channelId: 'ch-1', ok: false, status: 500, latencyMs: 2000, error: '上游 500' })

    const summary = usageSummary(new Map([['ch-1', '主渠道']]))
    expect(summary.channels[0]).toMatchObject({ id: 'ch-1', name: '主渠道', total: 3, ok: 2, fail: 1, avgLatencyMs: 2000 })
    expect(summary.totals).toEqual({ total: 3, ok: 2, fail: 1 })
  })

  it('没有 channelId 的调用直接忽略，不会造出一条空统计', () => {
    freshDir()
    recordChannelCall({ channelId: '', ok: true })
    recordChannelCall(null)
    expect(usageSummary().channels).toEqual([])
  })

  it('只在传了 userId 时才记用户维度——open/passcode 模式下本就没有用户身份', () => {
    freshDir()
    record('ch-1', true, 2, { userId: 'u-1' })
    record('ch-1', true, 1)

    const summary = usageSummary(new Map([['ch-1', '主渠道']]), new Map([['u-1', '张三']]))
    expect(summary.users).toHaveLength(1)
    expect(summary.users[0]).toMatchObject({ id: 'u-1', name: '张三', total: 2, ok: 2 })
  })

  it('绝不记录提示词或图片：落盘内容里只有渠道、成败、耗时和时间', () => {
    const dir = freshDir()
    recordChannelCall({ channelId: 'ch-1', ok: false, status: 500, latencyMs: 10, error: '上游 500' })
    flushUsage()

    const raw = readFileSync(join(dir, 'usage.json'), 'utf-8')
    expect(existsSync(join(dir, 'usage.json'))).toBe(true)
    expect(Object.keys(JSON.parse(raw))).toEqual(['version', 'channels', 'users', 'days', 'events', 'updatedAt'])
    expect(Object.keys(JSON.parse(raw).events[0]).sort()).toEqual(['at', 'channelId', 'error', 'latencyMs', 'ok', 'status', 'userId'])
  })

  it('明细条数有上限，不会让文件无限膨胀', () => {
    freshDir()
    record('ch-1', true, 450)
    // 上限是 400，取回时只展示最近 60 条。
    expect(usageSummary(new Map([['ch-1', 'A']])).events).toHaveLength(60)
    expect(usageSummary(new Map([['ch-1', 'A']])).channels[0].total).toBe(450)
  })

  it('按天聚合只保留最近 14 天', () => {
    freshDir()
    const day = 86_400_000
    for (let i = 0; i < 20; i += 1) {
      recordChannelCall({ channelId: 'ch-1', ok: true, status: 200, latencyMs: 1, at: Date.now() - (19 - i) * day })
    }
    expect(usageSummary().days).toHaveLength(14)
  })

  it('明细倒序返回：后台想看的是"最近发生了什么"', () => {
    freshDir()
    recordChannelCall({ channelId: 'ch-1', ok: true, status: 200, latencyMs: 1, at: 1000 })
    recordChannelCall({ channelId: 'ch-2', ok: true, status: 200, latencyMs: 1, at: 2000 })
    expect(usageSummary(new Map([['ch-1', 'A'], ['ch-2', 'B']])).events.map((item) => item.channelId)).toEqual(['ch-2', 'ch-1'])
  })
})

describe('channelHealth', () => {
  it('没被调用过时是 unknown，无从判断', () => {
    freshDir()
    expect(channelHealth('ch-nope').state).toBe('unknown')
  })

  it('最近一次成功就算 healthy', () => {
    freshDir()
    record('ch-1', false, 2)
    record('ch-1', true, 1)
    expect(channelHealth('ch-1')).toMatchObject({ state: 'healthy', consecutiveFailures: 0 })
  })

  it('连续失败 3 次判定 down——1 次可能是偶发', () => {
    freshDir()
    record('ch-1', false, 2)
    expect(channelHealth('ch-1').state).not.toBe('down')
    record('ch-1', false, 1)
    expect(channelHealth('ch-1')).toMatchObject({ state: 'down', consecutiveFailures: 3 })
  })

  it('成功一次就把连续失败计数清零，故障渠道恢复后立刻反映出来', () => {
    freshDir()
    record('ch-1', false, 5)
    expect(channelHealth('ch-1').state).toBe('down')
    record('ch-1', true, 1)
    expect(channelHealth('ch-1').consecutiveFailures).toBe(0)
  })

  it('近期失败率偏高判定 flaky，但调用次数太少时不下这个结论', () => {
    freshDir()
    // 1 成 1 败：失败率 50%，但样本太小，不该被标成不稳。
    record('ch-1', false, 1)
    record('ch-1', true, 1)
    expect(channelHealth('ch-1').state).toBe('healthy')

    freshDir()
    // 交替成败凑够 5 次以上，且连续失败数不到 3。
    for (let i = 0; i < 4; i += 1) {
      record('ch-2', false, 1)
      record('ch-2', true, 1)
    }
    expect(channelHealth('ch-2').state).toBe('flaky')
  })

  it('健康度只看指定渠道，不被别的渠道的失败带偏', () => {
    freshDir()
    record('ch-bad', false, 5)
    record('ch-good', true, 3)
    expect(channelHealth('ch-good').state).toBe('healthy')
    expect(channelHealth('ch-bad').state).toBe('down')
  })
})

describe('usageSummary', () => {
  it('已删除的渠道保留统计但标注出来，账单还是花掉了', () => {
    freshDir()
    record('ch-gone', true, 2)
    const summary = usageSummary(new Map())
    expect(summary.channels[0]).toMatchObject({ name: '（已删除的渠道）', exists: false, total: 2 })
  })

  it('按调用次数倒序排，用得最多的排在最前', () => {
    freshDir()
    record('ch-a', true, 1)
    record('ch-b', true, 5)
    record('ch-c', true, 3)
    expect(usageSummary(new Map([['ch-a', 'A'], ['ch-b', 'B'], ['ch-c', 'C']])).channels.map((item) => item.id))
      .toEqual(['ch-b', 'ch-c', 'ch-a'])
  })

  it('resetUsage 归零后健康度退回 unknown', () => {
    freshDir()
    record('ch-1', false, 5)
    expect(channelHealth('ch-1').state).toBe('down')
    resetUsage()
    expect(channelHealth('ch-1').state).toBe('unknown')
    expect(usageSummary().totals).toEqual({ total: 0, ok: 0, fail: 0 })
  })
})
