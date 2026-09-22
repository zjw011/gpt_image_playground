// 邮箱验证码：注册与找回密码用的一次性凭证。
//
// 只放内存，不落盘。两个原因：
// 1. 验证码 10 分钟就过期，进程重启后全部作废是可接受的行为——用户重新点一次「发送」即可；
// 2. 落盘等于多一份「把别人邮箱和验证码写到磁盘上」的风险面，收益为零。
//
// 三重限流缺一不可，它们护的是不同的东西：
//   · 同邮箱 60 秒内只能要一次    —— 防手抖连点，也防前端的重试逻辑打出一串邮件。
//   · 同邮箱每天上限              —— 防有人拿本站当免费的轰炸工具去打别人的邮箱。
//                                    这条护的是**收件人**。
//   · 同 IP 每小时上限            —— 防有人换着一堆邮箱刷我们的发信额度。
//                                    这条护的是**我们的发信账号**（QQ 个人邮箱有日限额，
//                                    被打爆之后全站都注册不了）。
//
// 另外「同一个码最多试 5 次，试满作废」是硬要求：6 位数字只有 100 万种可能，
// 没有这条限制，等于给所有人一个在线的验证码爆破靶子。

import { randomInt, timingSafeEqual } from 'node:crypto'

/** 验证码有效期。10 分钟够用户切到邮箱、复制、切回来。 */
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000

/** 同一邮箱的重新发送冷却。 */
export const EMAIL_CODE_COOLDOWN_MS = 60 * 1000

/** 同一个码允许试错几次。 */
export const EMAIL_CODE_MAX_ATTEMPTS = 5

/** 验证码位数。 */
export const EMAIL_CODE_DIGITS = 6

const DEFAULT_DAILY_PER_EMAIL = 8
const DEFAULT_HOURLY_PER_IP = 20

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** 各类表的容量上限，防止被刷成内存泄漏。 */
const MAX_ENTRIES = 5000

/**
 * 验证码用途。用途参与存储键，所以「注册验证码」不能被拿去重置密码——
 * 否则拿到一个注册码就等于能改任意账号的密码。
 */
export const EMAIL_CODE_PURPOSES = new Set(['register', 'reset'])

/** `${purpose}:${email}` → { code, expiresAt, attempts, sentAt } */
const codes = new Map()
/** email → 发送时间戳数组（每日上限） */
const emailHistory = new Map()
/** ip → 发送时间戳数组（每小时上限） */
const ipHistory = new Map()

/**
 * 邮箱规整。
 * 存进配置和用作存储键的都是这个形态（小写 + 去空白），
 * 否则 `A@qq.com` 和 `a@qq.com` 会变成两个人。
 */
export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase()
  if (email.length < 6 || email.length > 254) return ''
  // 要求域名里至少有一个点：能挡掉 a@localhost 这类根本发不出去的地址。
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return ''
  if (email.split('@')[0].length > 64) return ''
  return email
}

export function isValidEmail(value) {
  return Boolean(normalizeEmail(value))
}

function countRecent(map, key, now, windowMs) {
  const list = map.get(key)
  if (!list) return 0
  let count = 0
  for (const at of list) if (now - at < windowMs) count += 1
  return count
}

function recordSend(map, key, now, windowMs) {
  const kept = (map.get(key) ?? []).filter((at) => now - at < windowMs)
  kept.push(now)
  map.set(key, kept)
  if (map.size > MAX_ENTRIES) {
    for (const candidate of map.keys()) {
      if (candidate !== key) {
        map.delete(candidate)
        break
      }
    }
  }
  return kept.length
}

/** 发信失败时把刚记下的这一次退回，别让用户因为服务器配错而白等一天。 */
function rollbackSend(map, key) {
  const list = map.get(key)
  if (!list?.length) return
  list.pop()
  if (list.length) map.set(key, list)
  else map.delete(key)
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left), 'utf-8')
  const b = Buffer.from(String(right), 'utf-8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 清掉过期的码，避免长期运行攒下一堆废条目。 */
function evictExpired(now) {
  if (codes.size <= MAX_ENTRIES) return
  for (const [key, entry] of codes) {
    if (now > entry.expiresAt) codes.delete(key)
    if (codes.size <= MAX_ENTRIES) break
  }
  // 还有超量的说明全是没过期的活跃码，按插入顺序丢最老的。
  while (codes.size > MAX_ENTRIES) {
    const oldest = codes.keys().next().value
    if (oldest === undefined) break
    codes.delete(oldest)
  }
}

/**
 * 签发一个验证码。
 *
 * 返回 { ok: true, code, ttlSeconds, resendAfterSeconds } —— code 只交给服务端内部
 * 的发信逻辑，**绝不能进 API 响应**。
 * 失败时返回 { ok: false, reason }，reason 取值：
 *   invalid-email / cooldown / daily-limit / ip-limit
 * cooldown 会额外带 retryAfterSeconds，好让前端倒计时到正确的秒数。
 */
export function issueEmailCode(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const email = normalizeEmail(options.email)
  const purpose = EMAIL_CODE_PURPOSES.has(options.purpose) ? options.purpose : 'register'
  if (!email) return { ok: false, reason: 'invalid-email' }

  const dailyPerEmail = Number.isFinite(options.dailyPerEmail) ? options.dailyPerEmail : DEFAULT_DAILY_PER_EMAIL
  const hourlyPerIp = Number.isFinite(options.hourlyPerIp) ? options.hourlyPerIp : DEFAULT_HOURLY_PER_IP

  const key = `${purpose}:${email}`
  const existing = codes.get(key)

  // 冷却按"上一次真正发出去了"算。发信失败时下面的 cancelEmailCode 会把它退掉，
  // 所以不会出现"第一封没发出去，第二封还要等 60 秒"。
  if (existing && now - existing.sentAt < EMAIL_CODE_COOLDOWN_MS) {
    const remaining = EMAIL_CODE_COOLDOWN_MS - (now - existing.sentAt)
    return { ok: false, reason: 'cooldown', retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)) }
  }

  if (countRecent(emailHistory, email, now, DAY_MS) >= dailyPerEmail) {
    return { ok: false, reason: 'daily-limit' }
  }

  const ip = String(options.ip ?? '').trim() || 'unknown'
  if (countRecent(ipHistory, ip, now, HOUR_MS) >= hourlyPerIp) {
    return { ok: false, reason: 'ip-limit' }
  }

  // 用 randomInt 而不是 randomBytes % 1000000：后者会引入取模偏差，
  // 让前 1/5 的号码出现概率高于其余。
  const code = String(randomInt(0, 10 ** EMAIL_CODE_DIGITS)).padStart(EMAIL_CODE_DIGITS, '0')

  codes.set(key, { code, expiresAt: now + EMAIL_CODE_TTL_MS, attempts: 0, sentAt: now })
  recordSend(emailHistory, email, now, DAY_MS)
  recordSend(ipHistory, ip, now, HOUR_MS)
  evictExpired(now)

  return {
    ok: true,
    code,
    ttlSeconds: Math.floor(EMAIL_CODE_TTL_MS / 1000),
    resendAfterSeconds: Math.floor(EMAIL_CODE_COOLDOWN_MS / 1000),
  }
}

/**
 * 发信失败时的回滚：把这个码删掉，并把配额退回去。
 * 不这么做的话，SMTP 配错的这一天里用户会一次次消耗自己的每日额度，
 * 等管理员配好了也发不出去。
 */
export function cancelEmailCode({ email, purpose, ip } = {}) {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) return
  const normalizedPurpose = EMAIL_CODE_PURPOSES.has(purpose) ? purpose : 'register'
  codes.delete(`${normalizedPurpose}:${normalizedEmail}`)
  rollbackSend(emailHistory, normalizedEmail)
  rollbackSend(ipHistory, String(ip ?? '').trim() || 'unknown')
}

/**
 * 校验并**消费**验证码（一次性，验过即销毁，防重放）。
 *
 * 返回 { ok: true } 或 { ok: false, reason, remainingAttempts? }，reason 取值：
 *   invalid-email / missing / expired / mismatch / too-many-attempts
 */
export function verifyEmailCode({ email, purpose, code, now = Date.now() } = {}) {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) return { ok: false, reason: 'invalid-email' }
  const normalizedPurpose = EMAIL_CODE_PURPOSES.has(purpose) ? purpose : 'register'

  const key = `${normalizedPurpose}:${normalizedEmail}`
  const entry = codes.get(key)
  if (!entry) return { ok: false, reason: 'missing' }

  if (now > entry.expiresAt) {
    codes.delete(key)
    return { ok: false, reason: 'expired' }
  }

  // 用户从邮件里复制时可能带上空格，容忍掉。
  const submitted = String(code ?? '').replace(/\s/g, '')
  if (!safeEqual(submitted, entry.code)) {
    entry.attempts += 1
    if (entry.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
      codes.delete(key)
      return { ok: false, reason: 'too-many-attempts' }
    }
    return { ok: false, reason: 'mismatch', remainingAttempts: EMAIL_CODE_MAX_ATTEMPTS - entry.attempts }
  }

  codes.delete(key)
  return { ok: true }
}

/** 测试用：清空所有状态。 */
export function resetEmailCodes() {
  codes.clear()
  emailHistory.clear()
  ipHistory.clear()
}
