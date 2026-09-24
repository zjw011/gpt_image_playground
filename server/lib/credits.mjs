// 积分账本：余额、流水、按天聚合。
//
// 跟 usage.json 最大的不同是**落盘策略**：用量统计丢了只是数字难看，
// 积分丢了是用户真金白银。所以这里不用 5 秒防抖，每一笔都同步原子写。
// 出图是秒级以上的低频操作，一次请求最多写两次（扣费 + 失败退回），完全承受得起。
//
// 另一个约束是**零运行时依赖**：不引入任何三方库，金额一律用整数积分，
// 不做浮点运算，避免 0.1+0.2 那种经典问题。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 流水只留最近这些条。够后台翻"最近发生了什么"，又不会让文件无限膨胀。 */
const MAX_LEDGER = 800

/** 按天聚合保留这么多天。积分台账比用量统计值得留久一点。 */
const MAX_DAYS = 90

/**
 * 单笔积分变动的上限。
 * 卡密面额、管理员调账都会被夹到这个范围内——防止一个手滑的 0 或者天文数字
 * 把某个账号的余额变成 float 精度都不够的巨大值。
 */
const MAX_AMOUNT = 100_000_000

/**
 * 流水类型。
 * - signup  注册赠送
 * - redeem  卡密兑换
 * - spend   出图扣费
 * - refund  出图失败退回
 * - admin   管理员人工调整（可正可负）
 */
export const LEDGER_TYPES = new Set(['signup', 'redeem', 'spend', 'refund', 'admin', 'referral'])

let creditsFile = ''
let cache = null
let ledgerSeq = 0

function emptyCredits() {
  return { version: 1, users: {}, ledger: [], days: {}, updatedAt: 0 }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 积分一律是 >= 0 的整数。非法输入退回 fallback 而不是抛错——账本不该把服务打挂。 */
function toCredits(value, fallback = 0) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(MAX_AMOUNT, Math.max(0, Math.trunc(numeric)))
}

/** 需要保留符号的场景（管理员调账、退回），允许负数。 */
function toSignedCredits(value, fallback = 0) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(MAX_AMOUNT, Math.max(-MAX_AMOUNT, Math.trunc(numeric)))
}

function toInt(value, fallback = 0) {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : fallback
}

/** 按天分桶键用本地时区，理由同 usage.mjs：管理员心里的"今天"是服务器所在时区的今天。 */
function dayKey(at) {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function normalizeAccount(raw) {
  const record = isRecord(raw) ? raw : {}
  return {
    balance: toCredits(record.balance),
    totalIn: toCredits(record.totalIn),
    totalOut: toCredits(record.totalOut),
    updatedAt: toInt(record.updatedAt),
  }
}

function emptyDay() {
  return { spend: 0, recharge: 0, refund: 0, images: 0, redeemCount: 0 }
}

function normalizeDay(raw) {
  const record = isRecord(raw) ? raw : {}
  return {
    spend: toCredits(record.spend),
    recharge: toCredits(record.recharge),
    refund: toCredits(record.refund),
    images: toCredits(record.images),
    redeemCount: toCredits(record.redeemCount),
  }
}

function normalizeCredits(input) {
  const record = isRecord(input) ? input : {}
  const next = emptyCredits()

  if (isRecord(record.users)) {
    for (const [userId, raw] of Object.entries(record.users)) {
      if (!userId) continue
      next.users[userId] = normalizeAccount(raw)
    }
  }

  if (Array.isArray(record.ledger)) {
    next.ledger = record.ledger
      .filter(isRecord)
      .slice(-MAX_LEDGER)
      .map((raw) => ({
        at: toInt(raw.at),
        userId: typeof raw.userId === 'string' ? raw.userId : '',
        type: LEDGER_TYPES.has(raw.type) ? raw.type : 'admin',
        amount: toSignedCredits(raw.amount),
        balanceAfter: toCredits(raw.balanceAfter),
        ref: typeof raw.ref === 'string' ? raw.ref.slice(0, 80) : '',
        note: typeof raw.note === 'string' ? raw.note.slice(0, 120) : '',
      }))
  }

  if (isRecord(record.days)) {
    for (const [day, raw] of Object.entries(record.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      next.days[day] = normalizeDay(raw)
    }
  }

  next.updatedAt = toInt(record.updatedAt)
  return next
}

export function initCredits(dataDir) {
  creditsFile = join(dataDir, 'credits.json')
  mkdirSync(dirname(creditsFile), { recursive: true })
  cache = existsSync(creditsFile)
    ? (() => {
        try {
          return normalizeCredits(JSON.parse(readFileSync(creditsFile, 'utf-8')))
        } catch (err) {
          // 账本读坏了不能从零开始——那等于把所有人的余额清零。
          // 但要保住旧文件：重命名成 .corrupt 再以空账本启动，管理员还能人工抢救。
          console.error('积分账本读取失败，已备份为 credits.json.corrupt：', err)
          try {
            renameSync(creditsFile, `${creditsFile}.corrupt`)
          } catch {
            // 备份失败就继续，至少让服务能起来。
          }
          return emptyCredits()
        }
      })()
    : emptyCredits()
  return cache
}

function writeCreditsFile() {
  if (!creditsFile || !cache) return
  const tmp = `${creditsFile}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(cache, null, 2), { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, creditsFile)
}

/** 只要账本被改过就写盘。所有写操作的最后一步都是它。 */
function commit(at) {
  cache.updatedAt = at
  writeCreditsFile()
}

function touchDay(at) {
  const key = dayKey(at)
  const day = cache.days[key] ?? emptyDay()
  cache.days[key] = day
  // 按字符串排序对 YYYY-MM-DD 就是按时间排序。
  const keys = Object.keys(cache.days).sort()
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_DAYS))) delete cache.days[stale]
  return day
}

function pushLedger(entry) {
  cache.ledger.push(entry)
  if (cache.ledger.length > MAX_LEDGER) cache.ledger.splice(0, cache.ledger.length - MAX_LEDGER)
}

// ===== 账户 =====

export function ensureAccount(userId) {
  if (!userId) return null
  const existing = cache.users[userId]
  if (existing) return existing
  const fresh = { balance: 0, totalIn: 0, totalOut: 0, updatedAt: Date.now() }
  cache.users[userId] = fresh
  return fresh
}

export function getAccount(userId) {
  const account = cache?.users?.[userId]
  return account ? { ...account } : { balance: 0, totalIn: 0, totalOut: 0, updatedAt: 0 }
}

export function getBalance(userId) {
  return cache?.users?.[userId]?.balance ?? 0
}

/**
 * 加积分。唯一的加渠道，所有来源（注册赠送、卡密兑换、失败退回、管理员调账）
 * 都从这里过，保证 totalIn / 流水 / 按天聚合三处永远对得上。
 */
export function addCredits(userId, amount, options = {}) {
  const delta = toCredits(amount)
  if (!userId || delta <= 0) return { ok: false, balance: getBalance(userId) }

  const at = options.at ?? Date.now()
  const account = ensureAccount(userId)
  account.balance += delta
  account.totalIn += delta
  account.updatedAt = at

  const type = LEDGER_TYPES.has(options.type) ? options.type : 'redeem'
  const day = touchDay(at)
  // 退回不计入"充值"，否则充值曲线会被失败重试撑成假的增长。
  if (type === 'refund') day.refund += delta
  else day.recharge += delta
  if (type === 'redeem') day.redeemCount += 1

  pushLedger({
    at,
    userId,
    type,
    amount: delta,
    balanceAfter: account.balance,
    ref: String(options.ref ?? ''),
    note: String(options.note ?? ''),
  })

  commit(at)
  return { ok: true, balance: account.balance }
}

/**
 * 扣积分。余额不足返回 ok:false 且不改动任何状态——调用方据此拒绝这次出图。
 * 整个函数是同步的，Node 单线程下天然原子，不会出现两次并发请求各扣一半的情况。
 */
export function spendCredits(userId, amount, options = {}) {
  const delta = toCredits(amount)
  if (!userId || delta <= 0) return { ok: true, balance: getBalance(userId), charged: 0 }

  const account = ensureAccount(userId)
  if (account.balance < delta) return { ok: false, balance: account.balance, charged: 0 }

  const at = options.at ?? Date.now()
  account.balance -= delta
  account.totalOut += delta
  account.updatedAt = at

  const day = touchDay(at)
  day.spend += delta
  day.images += toInt(options.images, delta)

  pushLedger({
    at,
    userId,
    type: 'spend',
    amount: -delta,
    balanceAfter: account.balance,
    ref: String(options.ref ?? ''),
    note: String(options.note ?? ''),
  })

  commit(at)
  return { ok: true, balance: account.balance, charged: delta }
}

/** 出图失败时把预扣的原路退回。走 addCredits 的 refund 分支。 */
export function refundCredits(userId, amount, options = {}) {
  return addCredits(userId, amount, { ...options, type: 'refund' })
}

/**
 * 管理员直接把余额改成目标值（而不是加减一个数）。
 * 后台表单上填的是"他应该有多少分"，比让他自己算差额不容易出错。
 */
export function setBalance(userId, target, options = {}) {
  const account = ensureAccount(userId)
  if (!account) return { ok: false, balance: 0 }

  const next = toCredits(target)
  const diff = next - account.balance
  if (diff === 0) return { ok: true, balance: account.balance, changed: 0 }

  const at = options.at ?? Date.now()
  account.balance = next
  if (diff > 0) account.totalIn += diff
  else account.totalOut += -diff
  account.updatedAt = at

  const day = touchDay(at)
  if (diff > 0) day.recharge += diff

  pushLedger({
    at,
    userId,
    type: 'admin',
    amount: diff,
    balanceAfter: next,
    ref: '',
    note: String(options.note ?? ''),
  })

  commit(at)
  return { ok: true, balance: next, changed: diff }
}

/** 注册赠送。已经有账户的老用户不会因为重新登录被重复赠送。 */
export function grantSignupBonus(userId, amount, options = {}) {
  if (!userId) return { ok: false, balance: 0 }
  if (cache.users[userId]) return { ok: false, balance: cache.users[userId].balance, duplicated: true }
  return addCredits(userId, amount, { ...options, type: 'signup', note: '注册赠送' })
}

// ===== 在途预留 =====
//
// 「生图成功才扣积分」听起来直接扣就行了，但并发会出事：余额只剩 1 分时同时发 10 个请求，
// 10 个都看到"够扣"就全放行了，最后扣成负数。
//
// 解法是把「占位」和「扣款」分开：
//   - 出门前先在内存里占住一份额度（不落盘），并发请求互相能看见对方的占位；
//   - 出图成功了才真正扣款并释放占位；
//   - 出图失败只释放占位，账本上根本没动过。
//
// 之所以不落盘：占位是**进程内的临时状态**。服务重启时所有在途请求也随之消失，
// 占位自然归零，不会出现"扣了钱但请求没做完"这种真正会丢钱的情况。

/** userId -> 在途占用的积分总额。 */
const reservations = new Map()

/** 只给测试用：清掉所有在途占位。 */
export function resetReservations() {
  reservations.clear()
}

/** 可用余额 = 账本余额 − 在途占位。并发判断必须看这个数，不能看 balance。 */
export function getAvailableBalance(userId) {
  if (!userId) return 0
  return getBalance(userId) - (reservations.get(userId) ?? 0)
}

export function getReserved(userId) {
  return reservations.get(userId) ?? 0
}

/**
 * 出门前占位。额度不够返回 ok:false，调用方据此拒绝这次请求。
 * 这是纯内存操作，同步执行，天然原子。
 */
export function reserveCredits(userId, amount, options = {}) {
  if (!userId) return { ok: true, reserved: 0, available: 0 }
  const delta = toCredits(amount)
  if (delta <= 0) return { ok: true, reserved: 0, available: getAvailableBalance(userId) }

  const available = getAvailableBalance(userId)
  if (available < delta) return { ok: false, available, requested: delta }

  reservations.set(userId, (reservations.get(userId) ?? 0) + delta)
  void options
  return { ok: true, reserved: delta, available: available - delta }
}

/** 请求结束（无论成败）都要释放占位，否则用户的额度会被一直占着。 */
export function releaseReservation(userId, amount) {
  if (!userId) return
  const delta = toCredits(amount)
  if (delta <= 0) return
  const next = (reservations.get(userId) ?? 0) - delta
  if (next > 0) reservations.set(userId, next)
  else reservations.delete(userId)
}

/**
 * 结算：真正扣款并释放占位。
 * 扣款金额是**实际落地渠道**的价格，可能低于出门时占的最贵候选价。
 */
export function settleCredits(userId, actualAmount, options = {}) {
  const result = spendCredits(userId, actualAmount, options)
  releaseReservation(userId, options.reserved ?? 0)
  return result
}

/** 用户被删除时把他的账户一起清掉，避免后台列表里留下永远对不上的"幽灵余额"。 */
export function removeAccount(userId) {
  if (!userId || !cache.users[userId]) return false
  delete cache.users[userId]
  commit(Date.now())
  return true
}

// ===== 查询 =====

function ledgerRow(entry, userNames) {
  // userNames 缺席表示"这次压根不需要解析名字"（前台看自己的流水就是这种），
  // 它不等于"这个用户被删了"。把两者混为一谈，用户就会在自己的积分明细里
  // 看到每一行都标着「（已删除的用户）」——所以缺席时宁可不给名字。
  if (!userNames) return { ...entry, userName: '', exists: true }
  return {
    ...entry,
    userName: userNames.get(entry.userId) ?? (entry.userId ? '（已删除的用户）' : ''),
    exists: userNames.has(entry.userId),
  }
}

/** 某个用户自己的流水，倒序。前台"积分明细"用它。 */
export function listLedger(userId, limit = 50, userNames) {
  if (!cache) return []
  return cache.ledger
    .filter((entry) => entry.userId === userId)
    .slice(-Math.max(1, Math.min(200, limit)))
    .reverse()
    .map((entry) => ledgerRow(entry, userNames))
}

/**
 * 后台视图：所有用户的余额 + 全站流水。
 * 余额为 0 但从没登录过的账号不列出来——那是被删用户留下的空壳，不该占一行。
 */
export function creditsSummary(userNames = new Map(), options = {}) {
  if (!cache) {
    return { users: [], ledger: [], days: [], totals: { balance: 0, totalIn: 0, totalOut: 0, paused: 0 }, updatedAt: 0 }
  }

  const users = Object.entries(cache.users)
    .map(([id, account]) => ({
      id,
      name: userNames.get(id) ?? '（已删除的用户）',
      exists: userNames.has(id),
      balance: account.balance,
      totalIn: account.totalIn,
      totalOut: account.totalOut,
      updatedAt: account.updatedAt,
    }))
    .filter((item) => item.exists || item.balance !== 0 || item.totalIn !== 0 || item.totalOut !== 0)
    .sort((a, b) => b.balance - a.balance || b.totalOut - a.totalOut)

  const totals = users.reduce(
    (acc, item) => ({
      balance: acc.balance + item.balance,
      totalIn: acc.totalIn + item.totalIn,
      totalOut: acc.totalOut + item.totalOut,
      paused: acc.paused + (item.balance > 0 ? 1 : 0),
    }),
    { balance: 0, totalIn: 0, totalOut: 0, paused: 0 },
  )

  const limit = Math.max(1, Math.min(400, toInt(options.ledgerLimit, 100)))

  return {
    users,
    ledger: [...cache.ledger].reverse().slice(0, limit).map((entry) => ledgerRow(entry, userNames)),
    days: Object.entries(cache.days)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, stat]) => ({ day, ...stat })),
    totals,
    updatedAt: cache.updatedAt,
  }
}

/** 前台引导接口用的轻量投影：只回余额和最近几条，不下发整本账。 */
export function userCreditsView(userId, limit = 20) {
  const account = getAccount(userId)
  return {
    balance: account.balance,
    // 在途占位要一起下发：前端拿它做"能不能再来一发"的判断，
    // 否则会出现"看着还有余额，点了却被拒"的困惑。
    reserved: getReserved(userId),
    available: getAvailableBalance(userId),
    totalIn: account.totalIn,
    totalOut: account.totalOut,
    ledger: listLedger(userId, limit),
  }
}

/** 后台概览的积分卡片：今日消耗 / 今日充值 / 有余额的人数。 */
export function creditsOverview(now = Date.now()) {
  const key = dayKey(now)
  const today = cache?.days?.[key] ?? emptyDay()
  const accounts = Object.values(cache?.users ?? {})
  return {
    day: key,
    todaySpend: today.spend,
    todayRecharge: today.recharge,
    todayImages: today.images,
    todayRefund: today.refund,
    todayRedeemCount: today.redeemCount,
    balances: accounts.reduce((sum, item) => sum + item.balance, 0),
    holders: accounts.filter((item) => item.balance > 0).length,
    accounts: accounts.length,
  }
}

/** 清空统计但**不动余额**——余额是用户资产，任何"清空"按钮都不该碰它。 */
export function resetCreditStats() {
  cache.ledger = []
  cache.days = {}
  commit(Date.now())
  return cache
}
