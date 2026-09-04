// 用量统计回归测试：这是唯一一处服务端持久化的"运行时数据"，
// 一旦健康度判定或滚动裁剪出错，后台就会指着好渠道说它挂了，或者让文件无限膨胀。

import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { channelHealth, clearChannelFault, flushUsage, initUsage, isChannelFault, normalizeRange, recordChannelCall, resetUsage, usageOverview, usageSummary } from './usage.mjs'

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
    expect(Object.keys(JSON.parse(raw).events[0]).sort()).toEqual(['at', 'channelId', 'error', 'fault', 'latencyMs', 'ok', 'status', 'userId'])
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

describe('isChannelFault', () => {
  it('网络不通、鉴权失败、地址错和 5xx 算渠道的锅', () => {
    for (const status of [0, 401, 402, 403, 404, 408, 500, 502, 503, 504]) {
      expect(isChannelFault(status), `status=${status}`).toBe(true)
    }
  })

  it('请求内容问题与限流不算——换渠道也一样会失败', () => {
    for (const status of [400, 422, 429]) {
      expect(isChannelFault(status), `status=${status}`).toBe(false)
    }
  })
})

describe('健康度的误报防线', () => {
  it('提示词被拒（400）重复多次也不会把渠道标成故障', () => {
    freshDir()
    // 故障转移会让同一个坏提示词把每条渠道都试一遍，各吃一次 400。
    for (let i = 0; i < 6; i += 1) {
      recordChannelCall({ channelId: 'ch-1', ok: false, status: 400, latencyMs: 50, error: '内容不合规' })
    }
    expect(channelHealth('ch-1')).toMatchObject({ state: 'healthy', consecutiveFailures: 0 })
    // 但失败次数照样统计，账还是要算的。
    expect(usageSummary(new Map([['ch-1', 'A']])).channels[0]).toMatchObject({ total: 6, fail: 6 })
  })

  it('限流（429）不算渠道故障——那是容量问题，会自己恢复', () => {
    freshDir()
    for (let i = 0; i < 5; i += 1) {
      recordChannelCall({ channelId: 'ch-1', ok: false, status: 429, latencyMs: 20, error: '限流' })
    }
    expect(channelHealth('ch-1').state).toBe('healthy')
  })

  it('访客自己取消的请求完全不记，不该污染成功率', () => {
    freshDir()
    for (let i = 0; i < 4; i += 1) {
      recordChannelCall({ channelId: 'ch-1', ok: false, status: 0, latencyMs: 30, aborted: true, error: 'socket hang up' })
    }
    expect(channelHealth('ch-1').state).toBe('unknown')
    expect(usageSummary(new Map([['ch-1', 'A']])).totals).toEqual({ total: 0, ok: 0, fail: 0 })
  })

  it('400 和真故障混在一起时，只有真故障推进连续计数', () => {
    freshDir()
    recordChannelCall({ channelId: 'ch-1', ok: false, status: 500, latencyMs: 10, error: '上游 500' })
    recordChannelCall({ channelId: 'ch-1', ok: false, status: 400, latencyMs: 10, error: '参数错' })
    recordChannelCall({ channelId: 'ch-1', ok: false, status: 500, latencyMs: 10, error: '上游 500' })
    expect(channelHealth('ch-1').consecutiveFailures).toBe(2)
    expect(channelHealth('ch-1').state).not.toBe('down')
    recordChannelCall({ channelId: 'ch-1', ok: false, status: 503, latencyMs: 10, error: '上游 503' })
    expect(channelHealth('ch-1').state).toBe('down')
  })

  it('陈旧故障自动过期：超过 6 小时没再出错就按恢复处理', () => {
    freshDir()
    const old = Date.now() - 7 * 3_600_000
    for (let i = 0; i < 4; i += 1) {
      recordChannelCall({ channelId: 'ch-1', ok: false, status: 500, latencyMs: 10, at: old, error: '上游 500' })
    }
    // 用当时的时间点看，它确实是挂的。
    expect(channelHealth('ch-1', 20, old + 1000).state).toBe('down')
    // 七小时后再看，不该还挂着——之后一直没人用它，没有新数据来翻案。
    expect(channelHealth('ch-1')).toMatchObject({ state: 'healthy', stale: true, consecutiveFailures: 0 })
  })

  it('最近一次成功晚于最近一次失败时判定恢复，即使连续计数还没被清', () => {
    freshDir()
    recordChannelCall({ channelId: 'ch-1', ok: false, status: 500, latencyMs: 10, at: 1000, error: 'x' })
    recordChannelCall({ channelId: 'ch-1', ok: false, status: 500, latencyMs: 10, at: 2000, error: 'x' })
    recordChannelCall({ channelId: 'ch-1', ok: false, status: 500, latencyMs: 10, at: 3000, error: 'x' })
    expect(channelHealth('ch-1', 20, 4000).state).toBe('down')
    recordChannelCall({ channelId: 'ch-1', ok: true, status: 200, latencyMs: 10, at: 4000 })
    expect(channelHealth('ch-1', 20, 5000).state).toBe('healthy')
  })
})

describe('clearChannelFault', () => {
  it('管理员手动消除后立刻回到正常，且不删掉用量数据', () => {
    freshDir()
    record('ch-1', false, 4)
    expect(channelHealth('ch-1').state).toBe('down')

    expect(clearChannelFault('ch-1')).toBe(true)
    expect(channelHealth('ch-1')).toMatchObject({ state: 'healthy', consecutiveFailures: 0 })
    // 调用次数和失败次数仍在——消除的是判定，不是账。
    expect(usageSummary(new Map([['ch-1', 'A']])).channels[0]).toMatchObject({ total: 4, fail: 4 })
  })

  it('消除后再出现真故障会重新计数，不会永久免疫', () => {
    freshDir()
    record('ch-1', false, 4)
    clearChannelFault('ch-1')
    expect(channelHealth('ch-1').state).toBe('healthy')
    record('ch-1', false, 3)
    expect(channelHealth('ch-1').state).toBe('down')
  })

  it('本来就没有故障时返回 false，好让调用方知道什么都没发生', () => {
    freshDir()
    record('ch-1', true, 2)
    expect(clearChannelFault('ch-1')).toBe(false)
    expect(clearChannelFault('')).toBe(false)
  })

  it('只影响指定渠道', () => {
    freshDir()
    record('ch-1', false, 4)
    record('ch-2', false, 4)
    clearChannelFault('ch-1')
    expect(channelHealth('ch-1').state).toBe('healthy')
    expect(channelHealth('ch-2').state).toBe('down')
  })
})

describe('normalizeRange', () => {
  it('只认识 today / week / all，其他一律退回 today', () => {
    expect(normalizeRange('today')).toBe('today')
    expect(normalizeRange('week')).toBe('week')
    expect(normalizeRange('all')).toBe('all')
    for (const bad of [undefined, null, '', 'month', 'TODAY', 42, {}]) {
      expect(normalizeRange(bad)).toBe('today')
    }
  })
})

describe('usageOverview', () => {
  const CHANNELS = new Map([['ch-a', 'A 渠道'], ['ch-b', 'B 渠道']])
  const USERS = new Map([['u-1', '张三'], ['u-2', '李四']])
  const DAY = 86_400_000

  /** 在指定时刻记一次调用。用来铺跨天的数据。 */
  function at(ts, patch) {
    recordChannelCall({ channelId: 'ch-a', ok: true, status: 200, latencyMs: 1000, at: ts, ...patch })
  }

  it('今日只算今天，昨天的量不混进来', () => {
    freshDir()
    const now = Date.now()
    at(now, { userId: 'u-1' })
    at(now, { userId: 'u-1' })
    at(now - DAY, { userId: 'u-1' })

    const overview = usageOverview(CHANNELS, USERS, { range: 'today', now })
    expect(overview.totals).toEqual({ total: 2, ok: 2, fail: 0 })
    // 昨天那一次成了环比的分母。
    expect(overview.previous).toEqual({ total: 1, ok: 1, fail: 0 })
  })

  it('按用户交叉：谁用了多少、成功率、最近一次', () => {
    freshDir()
    const now = Date.now()
    at(now, { userId: 'u-1' })
    at(now, { userId: 'u-1' })
    at(now, { userId: 'u-1' })
    at(now, { userId: 'u-2', ok: false, status: 500 })
    at(now, { userId: 'u-2' })

    const overview = usageOverview(CHANNELS, USERS, { range: 'today', now })
    // 按调用次数倒序：用得最多的排最前。
    expect(overview.users.map((item) => item.id)).toEqual(['u-1', 'u-2'])
    expect(overview.users[0]).toMatchObject({ name: '张三', total: 3, ok: 3, fail: 0 })
    expect(overview.users[1]).toMatchObject({ name: '李四', total: 2, ok: 1, fail: 1 })
    expect(overview.users[1].lastAt).toBe(now)
    expect(overview.activeUsers).toBe(2)
  })

  it('按渠道交叉：带平均耗时和健康度', () => {
    freshDir()
    const now = Date.now()
    recordChannelCall({ channelId: 'ch-a', ok: true, status: 200, latencyMs: 1000, at: now })
    recordChannelCall({ channelId: 'ch-a', ok: true, status: 200, latencyMs: 3000, at: now })
    recordChannelCall({ channelId: 'ch-b', ok: true, status: 200, latencyMs: 500, at: now })

    const overview = usageOverview(CHANNELS, USERS, { range: 'today', now })
    expect(overview.channels[0]).toMatchObject({ id: 'ch-a', name: 'A 渠道', total: 2, avgLatencyMs: 2000, state: 'healthy' })
    expect(overview.channels[1]).toMatchObject({ id: 'ch-b', total: 1, avgLatencyMs: 500 })
  })

  it('近 7 天把整周合起来，环比对上一个 7 天', () => {
    freshDir()
    const now = Date.now()
    // 本周 3 次。
    for (let i = 0; i < 3; i += 1) at(now - i * DAY, { userId: 'u-1' })
    // 上一周 5 次。
    for (let i = 7; i < 12; i += 1) at(now - i * DAY, { userId: 'u-1' })

    const overview = usageOverview(CHANNELS, USERS, { range: 'week', now })
    expect(overview.totals.total).toBe(3)
    expect(overview.previous.total).toBe(5)
    expect(overview.range).toBe('week')
  })

  it('趋势图固定给满 14 天，没数据的天补 0', () => {
    freshDir()
    const now = Date.now()
    at(now)
    const overview = usageOverview(CHANNELS, USERS, { range: 'today', now })
    expect(overview.days).toHaveLength(14)
    // 最后一格是今天，前面全是 0。
    expect(overview.days[13]).toMatchObject({ total: 1 })
    expect(overview.days.slice(0, 13).every((item) => item.total === 0)).toBe(true)
  })

  it('故障渠道被点名，好让概览直接指路', () => {
    freshDir()
    record('ch-b', false, 3)
    expect(usageOverview(CHANNELS, USERS).brokenChannels).toEqual([{ id: 'ch-b', name: 'B 渠道' }])
  })

  it('没有用户 id 时不造出一个空用户行——共享口令模式不该显示"某个人"', () => {
    freshDir()
    const now = Date.now()
    at(now)
    at(now)
    const overview = usageOverview(CHANNELS, USERS, { range: 'today', now })
    expect(overview.totals.total).toBe(2)
    expect(overview.users).toEqual([])
    expect(overview.activeUsers).toBe(0)
  })

  it('删掉的用户和渠道仍然出现在交叉表里并标注出来', () => {
    freshDir()
    const now = Date.now()
    at(now, { userId: 'u-gone' })
    const overview = usageOverview(new Map(), new Map(), { range: 'today', now })
    expect(overview.users[0]).toMatchObject({ name: '（已删除的用户）', exists: false, total: 1 })
    expect(overview.channels[0]).toMatchObject({ name: '（已删除的渠道）', exists: false, total: 1 })
  })

  it('range 非法时按今日处理', () => {
    freshDir()
    const now = Date.now()
    at(now)
    at(now - DAY)
    expect(usageOverview(CHANNELS, USERS, { range: 'month', now }).totals.total).toBe(1)
  })

  it('访客取消的请求不进概览——它连统计都没进', () => {
    freshDir()
    const now = Date.now()
    at(now)
    recordChannelCall({ channelId: 'ch-a', ok: false, status: 0, latencyMs: 10, at: now, aborted: true })
    expect(usageOverview(CHANNELS, USERS, { range: 'today', now }).totals).toEqual({ total: 1, ok: 1, fail: 0 })
  })

  it('还没有任何数据时返回结构完整的空壳，前端不用做兜底', () => {
    freshDir()
    const overview = usageOverview(CHANNELS, USERS)
    expect(overview.totals).toEqual({ total: 0, ok: 0, fail: 0 })
    expect(overview.users).toEqual([])
    expect(overview.channels).toEqual([])
    expect(overview.days).toHaveLength(14)
    expect(overview.activeUsers).toBe(0)
  })

  it('清空统计后概览也跟着归零', () => {
    freshDir()
    at(Date.now(), { userId: 'u-1' })
    resetUsage()
    expect(usageOverview(CHANNELS, USERS).totals).toEqual({ total: 0, ok: 0, fail: 0 })
  })

  it('按天分桶用本地时区——否则 UTC+8 下"今天"要到早上 8 点才开始', () => {
    freshDir()
    // 本地时间今天的 00:30，用 UTC 切片会被归到昨天。
    const midnight = new Date()
    midnight.setHours(0, 30, 0, 0)
    at(midnight.getTime(), { userId: 'u-1' })
    expect(usageOverview(CHANNELS, USERS, { range: 'today', now: midnight.getTime() + 3600_000 }).totals.total).toBe(1)
  })
})
