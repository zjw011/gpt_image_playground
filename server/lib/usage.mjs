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

/**
 * 故障判定的时效。超过这个时间没再出错，就不该再挂着"疑似故障"——
 * 渠道可能早就恢复了，只是之后一直没人用到它，没有新数据来翻案。
 */
const STALE_FAULT_MS = 6 * 3_600_000

const FLUSH_DELAY_MS = 5_000

/**
 * 这次失败到底能不能算渠道的锅。
 *
 * 关键在于故障转移会把一个请求顺序试完所有渠道：如果是提示词被内容策略拒、
 * 参数不合法这类**请求本身**的问题，每条渠道都会各吃一次失败，
 * 重复几次就把整条链路全标成故障——而渠道一条都没坏。
 *
 * 所以只有指向渠道自身的错误才计入连续失败：
 * - 0     网络层不通、超时
 * - 401/402/403  密钥失效、欠费、无权限
 * - 404   地址填错
 * - 408   上游自己报超时
 * - 5xx   上游故障
 *
 * 排除在外的（仍然计入总失败数，只是不参与健康度判定）：
 * - 400/422  请求内容或参数的问题
 * - 429      限流，是容量问题且会自行恢复
 */
export function isChannelFault(status) {
  const code = toInt(status)
  if (code === 0) return true
  if (code >= 500) return true
  return code === 401 || code === 402 || code === 403 || code === 404 || code === 408
}

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

/** 按天交叉桶：{ [id]: { total, ok, fail, latencySum, lastAt } }。 */
function normalizeBuckets(input) {
  if (!isRecord(input)) return {}
  const next = {}
  for (const [id, raw] of Object.entries(input)) {
    if (!isRecord(raw)) continue
    next[id] = {
      total: toInt(raw.total),
      ok: toInt(raw.ok),
      fail: toInt(raw.fail),
      latencySum: toInt(raw.latencySum),
      lastAt: toInt(raw.lastAt),
    }
  }
  return next
}

/** 往交叉桶里累加一次调用。桶不存在就现建。 */
function bumpBucket(buckets, id, ok, at, latencyMs) {
  if (!id) return
  const bucket = buckets[id] ?? { total: 0, ok: 0, fail: 0, latencySum: 0, lastAt: 0 }
  bucket.total += 1
  if (ok) bucket.ok += 1
  else bucket.fail += 1
  bucket.latencySum += latencyMs
  bucket.lastAt = Math.max(bucket.lastAt, at)
  buckets[id] = bucket
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
      next.days[day] = {
        total: toInt(raw.total),
        ok: toInt(raw.ok),
        fail: toInt(raw.fail),
        // 交叉维度：这一天里各用户、各渠道分别用了多少。
        // 老数据没有这两个字段，就当空的——历史几天缺交叉数据可以接受，不做回填。
        users: normalizeBuckets(raw.users),
        channels: normalizeBuckets(raw.channels),
      }
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
        // 老数据没有 fault 字段，按状态码补判，这样升级后历史记录也能参与健康度。
        fault: raw.ok === true ? false : typeof raw.fault === 'boolean' ? raw.fault : isChannelFault(raw.status),
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

/**
 * 按天聚合的分桶键。
 *
 * 用**本地时区**而不是 UTC：后台要回答的是"今天出了多少图"，
 * 而管理员心里的"今天"是服务器所在时区的今天。用 toISOString 的话，
 * 在 UTC+8 下"今天"会从早上 8 点才开始算，凌晨的请求全归到昨天。
 */
function dayKey(at) {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * 记一次渠道调用。
 * @param entry.channelId 渠道 id
 * @param entry.ok        上游是否返回 2xx
 * @param entry.status    HTTP 状态码，网络层失败时为 0
 * @param entry.latencyMs 从发起到结束的耗时
 * @param entry.userId    多用户模式下的用户 id，其他模式为空串
 * @param entry.error     失败原因，只留前 200 字
 * @param entry.aborted   访客主动断开（点停止、关页面）——完全不该记，见下
 */
export function recordChannelCall(entry) {
  if (!cache || !entry?.channelId) return
  // 用户自己取消的请求不是任何人的错，记进去只会污染成功率。
  if (entry.aborted === true) return

  const at = toInt(entry.at, Date.now()) || Date.now()
  const ok = entry.ok === true
  const latencyMs = toInt(entry.latencyMs)
  // 失败是否算渠道的锅。请求内容被拒、限流这类失败照样统计，但不参与健康度判定。
  const fault = !ok && isChannelFault(entry.status)

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
    channel.lastFailAt = at
    channel.lastError = String(entry.error ?? '').slice(0, 200)
    // 只有渠道自身的故障才推进连续失败计数。
    if (fault) channel.consecutiveFailures += 1
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
  const day = cache.days[key] ?? { total: 0, ok: 0, fail: 0, users: {}, channels: {} }
  day.total += 1
  if (ok) day.ok += 1
  else day.fail += 1
  // 交叉维度：概览页要回答"今天谁用了多少、走的哪条渠道"，
  // 光有按天总数和全期分用户数据是拼不出来的。
  bumpBucket(day.users, entry.userId ?? '', ok, at, latencyMs)
  bumpBucket(day.channels, entry.channelId, ok, at, latencyMs)
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
    fault,
  })
  if (cache.events.length > MAX_EVENTS) cache.events.splice(0, cache.events.length - MAX_EVENTS)

  cache.updatedAt = at
  scheduleFlush()
}

/** 手动把一条渠道的故障标记清掉：连续失败归零，近期失败明细不再参与判定。 */
export function clearChannelFault(channelId, at = Date.now()) {
  if (!cache || !channelId) return false

  const stat = cache.channels[channelId]
  const hadFault = Boolean(stat?.consecutiveFailures) || cache.events.some((item) => item.channelId === channelId && item.fault)
  if (stat) {
    stat.consecutiveFailures = 0
    stat.lastError = ''
  }
  // 明细保留（用量数据不该被悄悄改写），只摘掉"算渠道故障"这个标记。
  for (const item of cache.events) {
    if (item.channelId === channelId) item.fault = false
  }
  cache.updatedAt = at
  flushUsage()
  return hadFault
}

/**
 * 渠道健康度。
 * - `unknown` 还没被调用过，无从判断
 * - `down`    近期连续出现渠道自身故障，故障转移正在绕过它
 * - `flaky`   近期故障率偏高，能用但会拖慢出图
 * - `healthy` 其余情况
 *
 * 只看 `fault` 为真的失败：提示词被拒、参数不合法、限流这些换渠道也一样会失败，
 * 算进去会把整条链路全标成故障。另外故障判定有时效——超过 STALE_FAULT_MS 没再出错，
 * 就当它已经恢复了，否则一次事故会让标记一直挂着，而之后根本没有新数据来翻案。
 */
export function channelHealth(channelId, recentWindow = 20, now = Date.now()) {
  const empty = { state: 'unknown', consecutiveFailures: 0, recentFailRate: 0, recentCalls: 0, stale: false }
  if (!cache) return empty

  const stat = cache.channels[channelId]
  if (!stat || stat.total === 0) return empty

  const recent = cache.events.filter((item) => item.channelId === channelId).slice(-recentWindow)
  const recentFaults = recent.filter((item) => item.fault).length
  const recentFailRate = recent.length ? recentFaults / recent.length : 0
  // 最近一次成功比最近一次故障更晚，说明已经恢复了。
  const recovered = stat.lastOkAt > stat.lastFailAt
  const stale = stat.lastFailAt > 0 && now - stat.lastFailAt > STALE_FAULT_MS
  const faulting = stat.consecutiveFailures > 0 && !recovered && !stale

  const state = faulting && stat.consecutiveFailures >= DOWN_THRESHOLD
    ? 'down'
    : !stale && recent.length >= FLAKY_MIN_CALLS && recentFailRate > FLAKY_RATE
      ? 'flaky'
      : 'healthy'

  return {
    state,
    consecutiveFailures: faulting ? stat.consecutiveFailures : 0,
    recentFailRate,
    recentCalls: recent.length,
    stale,
    // 带上最近错误，后台的故障提示才能直接说"因为什么"，不必再跳到用量页。
    lastError: state === 'healthy' ? '' : stat.lastError,
  }
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
      ...channelHealth(id),
      // 明细表要看历史，即使当前判定已恢复也照样展示最后一次错误。
      lastError: stat.lastError,
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

  // 只给柱状图要的三个数，不把按天的交叉桶整份塞进响应。
  const days = Object.entries(cache.days)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, stat]) => ({ day, total: stat.total, ok: stat.ok, fail: stat.fail }))

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

/** 概览支持的时间范围。今日是默认——后台首屏要回答的第一个问题是"今天怎么样"。 */
const RANGE_DAYS = { today: 1, week: 7, all: MAX_DAYS }

/** 把 range 参数收敛到已知值，非法输入退回今日而不是报错。 */
export function normalizeRange(value) {
  return value === 'week' || value === 'all' ? value : 'today'
}

/** 从今天往前数 n 天的日期键，最近的在前。 */
function recentDayKeys(n, now) {
  return Array.from({ length: n }, (_, i) => dayKey(now - i * 86_400_000))
}

/** 合并若干天的交叉桶，得到该区间内每个 id 的汇总。 */
function mergeBuckets(days, field) {
  const merged = new Map()
  for (const day of days) {
    for (const [id, bucket] of Object.entries(day?.[field] ?? {})) {
      const acc = merged.get(id) ?? { total: 0, ok: 0, fail: 0, latencySum: 0, lastAt: 0 }
      acc.total += bucket.total
      acc.ok += bucket.ok
      acc.fail += bucket.fail
      acc.latencySum += bucket.latencySum
      acc.lastAt = Math.max(acc.lastAt, bucket.lastAt)
      merged.set(id, acc)
    }
  }
  return merged
}

function bucketRows(merged, names, missingLabel) {
  return [...merged.entries()]
    .map(([id, stat]) => ({
      id,
      name: names.get(id) ?? missingLabel,
      exists: names.has(id),
      total: stat.total,
      ok: stat.ok,
      fail: stat.fail,
      avgLatencyMs: stat.total ? Math.round(stat.latencySum / stat.total) : 0,
      lastAt: stat.lastAt,
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

/**
 * 后台概览：一屏回答"今天出了多少图、谁在用、走哪条渠道、有没有渠道坏了"。
 *
 * 计的是**出图请求次数**而不是图片张数：转发层是纯流式透传，不解析请求体，
 * 所以拿不到 n。一次 n=4 的请求在这里算 1 次。要按张数计费得让前端上报，
 * 那是客户端可伪造的数据，目前不值得为它引入一条上报路径。
 */
export function usageOverview(channelNames = new Map(), userNames = new Map(), options = {}) {
  const range = normalizeRange(options.range)
  const now = options.now ?? Date.now()
  const empty = { total: 0, ok: 0, fail: 0 }
  if (!cache) {
    return { range, today: '', totals: empty, previous: empty, users: [], channels: [], days: [], activeUsers: 0, brokenChannels: [], updatedAt: 0 }
  }

  const today = dayKey(now)
  const span = RANGE_DAYS[range]
  const keys = recentDayKeys(span, now)
  const picked = keys.map((key) => cache.days[key]).filter(Boolean)

  const totals = picked.reduce(
    (acc, item) => ({ total: acc.total + item.total, ok: acc.ok + item.ok, fail: acc.fail + item.fail }),
    { ...empty },
  )
  // 环比：跟前面同样长度的区间比。没有上一段数据时前端会自动不显示箭头。
  const previous = recentDayKeys(span * 2, now)
    .slice(span)
    .map((key) => cache.days[key])
    .filter(Boolean)
    .reduce((acc, item) => ({ total: acc.total + item.total, ok: acc.ok + item.ok, fail: acc.fail + item.fail }), { ...empty })

  const userRows = bucketRows(mergeBuckets(picked, 'users'), userNames, '（已删除的用户）')
  const channelRows = bucketRows(mergeBuckets(picked, 'channels'), channelNames, '（已删除的渠道）')

  return {
    range,
    today,
    totals,
    previous,
    users: userRows,
    channels: channelRows.map((item) => ({ ...item, ...channelHealth(item.id) })),
    // 趋势图始终给满 14 天（没有数据的天补 0），不随 range 变——它的作用是提供上下文。
    days: recentDayKeys(MAX_DAYS, now).reverse().map((key) => ({
      day: key,
      total: cache.days[key]?.total ?? 0,
      ok: cache.days[key]?.ok ?? 0,
      fail: cache.days[key]?.fail ?? 0,
    })),
    activeUsers: userRows.length,
    brokenChannels: [...channelNames.entries()]
      .filter(([id]) => channelHealth(id).state === 'down')
      .map(([id, name]) => ({ id, name })),
    updatedAt: cache.updatedAt,
  }
}
