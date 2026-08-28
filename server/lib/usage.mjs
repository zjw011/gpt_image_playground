// 渠道用量统计：只记录"哪条渠道、成功还是失败、耗时多久、什么时候"。
// 不记录提示词、不记录图片、不记录参数——图片始终只存在访问者自己的浏览器里，这条底线不能破。
//
// 独立成 usage.json 而不是塞进 config.json：出图请求很频繁，
// 每次都重写整份配置既浪费又会把渠道密钥反复落盘。写入按 5 秒防抖合并。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 明细只留最近这些条，够在后台看一眼"刚才发生了什么"，又不会让文件无限膨胀。 */
const MAX_EVENTS = 400

/** 按天聚合保留两周，足够看出趋势，也够短到不用考虑归档。 */
const MAX_DAYS = 14

/** 连续失败达到这个数就判定为"挂了"。1 次可能是偶发，3 次基本是渠道本身的问题。 */
const DOWN_THRESHOLD = 3

/** 近期失败率超过这个比例判定为"不稳"。 */
const FLAKY_RATE = 0.2

/** 判定不稳至少要有这么多次调用，否则 1 失败 1 成功就会被标成 50% 失败率。 */
const FLAKY_MIN_CALLS = 5

const FLUSH_DELAY_MS = 5_000

let usageFile = ''
let cache = null
let flushTimer = null

function emptyUsage() {
  return { version: 1, channels: {}, users: {}, days: {}, events: [], updatedAt: 0 }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toInt(value, fallback = 0) {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : fallback
}

/** 统计文件是纯派生数据，读坏了就从零开始——不值得为它中断服务。 */
function normalizeUsage(input) {
  const record = isRecord(input) ? input : {}
  const next = emptyUsage()

  if (isRecord(record.channels)) {
    for (const [id, raw] of Object.entries(record.channels)) {
      if (!isRecord(raw)) continue
      next.channels[id] = {
        total: toInt(raw.total),
        ok: toInt(raw.ok),
        fail: toInt(raw.fail),
        latencySum: toInt(raw.latencySum),
        consecutiveFailures: toInt(raw.consecutiveFailures),
        lastOkAt: toInt(raw.lastOkAt),
        lastFailAt: toInt(raw.lastFailAt),
        lastError: typeof raw.lastError === 'string' ? raw.lastError.slice(0, 200) : '',
      }
    }
  }

  if (isRecord(record.users)) {
    for (const [id, raw] of Object.entries(record.users)) {
      if (!isRecord(raw)) continue
      next.users[id] = { total: toInt(raw.total), ok: toInt(raw.ok), fail: toInt(raw.fail), lastAt: toInt(raw.lastAt) }
    }
  }

  if (isRecord(record.days)) {
    for (const [day, raw] of Object.entries(record.days)) {
      if (!isRecord(raw) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      next.days[day] = { total: toInt(raw.total), ok: toInt(raw.ok), fail: toInt(raw.fail) }
    }
  }

  if (Array.isArray(record.events)) {
    next.events = record.events
      .filter(isRecord)
      .slice(-MAX_EVENTS)
      .map((raw) => ({
        channelId: typeof raw.channelId === 'string' ? raw.channelId : '',
        userId: typeof raw.userId === 'string' ? raw.userId : '',
        ok: raw.ok === true,
        status: toInt(raw.status),
        latencyMs: toInt(raw.latencyMs),
        at: toInt(raw.at),
        error: typeof raw.error === 'string' ? raw.error.slice(0, 200) : '',
      }))
  }

  next.updatedAt = toInt(record.updatedAt)
  return next
}

export function initUsage(dataDir) {
  usageFile = join(dataDir, 'usage.json')
  mkdirSync(dirname(usageFile), { recursive: true })
  cache = existsSync(usageFile)
    ? (() => {
        try {
          return normalizeUsage(JSON.parse(readFileSync(usageFile, 'utf-8')))
        } catch (err) {
          console.warn('用量统计文件读取失败，从零开始统计：', err)
          return emptyUsage()
        }
      })()
    : emptyUsage()
  return cache
}

function writeUsageFile() {
  if (!usageFile || !cache) return
  try {
    const tmp = `${usageFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(cache), { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmp, usageFile)
  } catch (err) {
    console.warn('用量统计写入失败：', err)
  }
}

/** 防抖落盘。unref 掉定时器，避免统计写入把进程钉住不退出。 */
function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    writeUsageFile()
  }, FLUSH_DELAY_MS)
  flushTimer.unref?.()
}

export function flushUsage() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  writeUsageFile()
}

function dayKey(at) {
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * 记一次渠道调用。
 * @param entry.channelId 渠道 id
 * @param entry.ok        上游是否返回 2xx
 * @param entry.status    HTTP 状态码，网络层失败时为 0
 * @param entry.latencyMs 从发起到结束的耗时
 * @param entry.userId    多用户模式下的用户 id，其他模式为空串
 * @param entry.error     失败原因，只留前 200 字
 */
export function recordChannelCall(entry) {
  if (!cache || !entry?.channelId) return

  const at = toInt(entry.at, Date.now()) || Date.now()
  const ok = entry.ok === true
  const latencyMs = toInt(entry.latencyMs)

  const channel = cache.channels[entry.channelId] ?? {
    total: 0, ok: 0, fail: 0, latencySum: 0, consecutiveFailures: 0, lastOkAt: 0, lastFailAt: 0, lastError: '',
  }
  channel.total += 1
  channel.latencySum += latencyMs
  if (ok) {
    channel.ok += 1
    channel.consecutiveFailures = 0
    channel.lastOkAt = at
  } else {
    channel.fail += 1
    channel.consecutiveFailures += 1
    channel.lastFailAt = at
    channel.lastError = String(entry.error ?? '').slice(0, 200)
  }
  cache.channels[entry.channelId] = channel

  if (entry.userId) {
    const user = cache.users[entry.userId] ?? { total: 0, ok: 0, fail: 0, lastAt: 0 }
    user.total += 1
    if (ok) user.ok += 1
    else user.fail += 1
    user.lastAt = at
    cache.users[entry.userId] = user
  }

  const key = dayKey(at)
  const day = cache.days[key] ?? { total: 0, ok: 0, fail: 0 }
  day.total += 1
  if (ok) day.ok += 1
  else day.fail += 1
  cache.days[key] = day

  // 只保留最近 MAX_DAYS 天：按字符串排序对 YYYY-MM-DD 就是按时间排序。
  const keys = Object.keys(cache.days).sort()
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_DAYS))) delete cache.days[stale]

  cache.events.push({
    channelId: entry.channelId,
    userId: entry.userId ?? '',
    ok,
    status: toInt(entry.status),
    latencyMs,
    at,
    error: ok ? '' : String(entry.error ?? '').slice(0, 200),
  })
  if (cache.events.length > MAX_EVENTS) cache.events.splice(0, cache.events.length - MAX_EVENTS)

  cache.updatedAt = at
  scheduleFlush()
}

/**
 * 渠道健康度。
 * - `unknown` 还没被调用过，无从判断
 * - `down`    连续失败达到阈值，故障转移正在绕过它
 * - `flaky`   近期失败率偏高，能用但会拖慢出图
 * - `healthy` 最近一次调用是成功的
 */
export function channelHealth(channelId, recentWindow = 20) {
  if (!cache) return { state: 'unknown', consecutiveFailures: 0, recentFailRate: 0, recentCalls: 0 }

  const stat = cache.channels[channelId]
  if (!stat || stat.total === 0) return { state: 'unknown', consecutiveFailures: 0, recentFailRate: 0, recentCalls: 0 }

  const recent = cache.events.filter((item) => item.channelId === channelId).slice(-recentWindow)
  const recentFails = recent.filter((item) => !item.ok).length
  const recentFailRate = recent.length ? recentFails / recent.length : 0
  const state = stat.consecutiveFailures >= DOWN_THRESHOLD
    ? 'down'
    : recent.length >= FLAKY_MIN_CALLS && recentFailRate > FLAKY_RATE
      ? 'flaky'
      : 'healthy'

  return { state, consecutiveFailures: stat.consecutiveFailures, recentFailRate, recentCalls: recent.length }
}

/** 后台用量视图。channelNames 用来把 id 翻成人能读的名字，删掉的渠道仍保留统计但标注"已删除"。 */
export function usageSummary(channelNames = new Map(), userNames = new Map()) {
  if (!cache) return { channels: [], users: [], days: [], events: [], totals: { total: 0, ok: 0, fail: 0 }, updatedAt: 0 }

  const channels = Object.entries(cache.channels)
    .map(([id, stat]) => ({
      id,
      name: channelNames.get(id) ?? '（已删除的渠道）',
      exists: channelNames.has(id),
      total: stat.total,
      ok: stat.ok,
      fail: stat.fail,
      avgLatencyMs: stat.total ? Math.round(stat.latencySum / stat.total) : 0,
      lastOkAt: stat.lastOkAt,
      lastFailAt: stat.lastFailAt,
      lastError: stat.lastError,
      ...channelHealth(id),
    }))
    .sort((a, b) => b.total - a.total)

  const users = Object.entries(cache.users)
    .map(([id, stat]) => ({
      id,
      name: userNames.get(id) ?? '（已删除的用户）',
      exists: userNames.has(id),
      total: stat.total,
      ok: stat.ok,
      fail: stat.fail,
      lastAt: stat.lastAt,
    }))
    .sort((a, b) => b.total - a.total)

  const days = Object.entries(cache.days)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, stat]) => ({ day, ...stat }))

  const totals = days.reduce(
    (acc, item) => ({ total: acc.total + item.total, ok: acc.ok + item.ok, fail: acc.fail + item.fail }),
    { total: 0, ok: 0, fail: 0 },
  )

  return {
    channels,
    users,
    days,
    // 明细倒序：后台想看的是"最近发生了什么"。
    events: [...cache.events].reverse().slice(0, 60).map((item) => ({
      ...item,
      channelName: channelNames.get(item.channelId) ?? '（已删除的渠道）',
      userName: item.userId ? userNames.get(item.userId) ?? '（已删除的用户）' : '',
    })),
    totals,
    updatedAt: cache.updatedAt,
  }
}

export function resetUsage() {
  cache = emptyUsage()
  flushUsage()
  return cache
}
