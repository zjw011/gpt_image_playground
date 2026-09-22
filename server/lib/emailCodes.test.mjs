// 邮箱验证码回归测试。
//
// 这个模块是"注册"的唯一关卡，所以测试重点不在"正常路径能过"，而在**异常路径必须挡住**：
// 猜码要有次数上限、一个码只能用一次、注册码不能拿来重置密码、
// 冷却和每日额度要能真正拦住人，同时发信失败时又必须把额度退回。

import { beforeEach, describe, expect, it } from 'vitest'

import {
  cancelEmailCode,
  EMAIL_CODE_COOLDOWN_MS,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_MS,
  issueEmailCode,
  isValidEmail,
  normalizeEmail,
  resetEmailCodes,
  verifyEmailCode,
} from './emailCodes.mjs'

const EMAIL = 'user@example.com'
const T0 = 1_800_000_000_000

beforeEach(() => {
  resetEmailCodes()
})

describe('normalizeEmail', () => {
  it('统一小写并去空白——A@qq.com 和 a@qq.com 必须是同一个账号', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com')
    expect(normalizeEmail('A@B.com')).toBe(normalizeEmail('a@b.com'))
  })

  it('挡掉根本发不出去的地址', () => {
    for (const bad of ['', '   ', 'nope', 'nope@', '@qq.com', 'a b@qq.com', 'a@localhost', 'a@@qq.com', 'a@qq.']) {
      expect(normalizeEmail(bad)).toBe('')
      expect(isValidEmail(bad)).toBe(false)
    }
  })

  it('接受正常地址', () => {
    expect(isValidEmail('a@b.co')).toBe(true)
    expect(isValidEmail('first.last+tag@sub.example.com')).toBe(true)
  })
})

describe('issueEmailCode', () => {
  it('签出 6 位纯数字码，并给出有效期与重发间隔', () => {
    const result = issueEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1', now: T0 })
    expect(result.ok).toBe(true)
    expect(result.code).toMatch(/^\d{6}$/)
    expect(result.ttlSeconds).toBe(EMAIL_CODE_TTL_MS / 1000)
    expect(result.resendAfterSeconds).toBe(EMAIL_CODE_COOLDOWN_MS / 1000)
  })

  it('60 秒内重复要码会被冷却挡住，并告诉前端还要等多久', () => {
    issueEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1', now: T0 })
    const again = issueEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1', now: T0 + 10_000 })
    expect(again.ok).toBe(false)
    expect(again.reason).toBe('cooldown')
    // 已过 10 秒，还差 50 秒。
    expect(again.retryAfterSeconds).toBe(50)
  })

  it('过了冷却就能再要一次，并且旧码立即失效', () => {
    const first = issueEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1', now: T0 })
    const second = issueEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1', now: T0 + EMAIL_CODE_COOLDOWN_MS })
    expect(second.ok).toBe(true)
    // 同一个邮箱同一个用途只留一个码，所以旧码一定失效。
    // （旧码读回来是 mismatch 而不是 missing——坑位里现在是新码。两者都等于"不能用"。）
    expect(verifyEmailCode({ email: EMAIL, purpose: 'register', code: first.code, now: T0 + EMAIL_CODE_COOLDOWN_MS })).toMatchObject({ ok: false })
    expect(verifyEmailCode({ email: EMAIL, purpose: 'register', code: second.code, now: T0 + EMAIL_CODE_COOLDOWN_MS }).ok).toBe(true)
  })

  it('注册和重置密码是两套独立的码，互不干扰', () => {
    const register = issueEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1', now: T0 })
    const reset = issueEmailCode({ email: EMAIL, purpose: 'reset', ip: '1.1.1.1', now: T0 })
    expect(reset.ok).toBe(true)
    // 注册码不能拿来重置密码——否则拿到一个注册码就等于能改任意账号的密码。
    expect(verifyEmailCode({ email: EMAIL, purpose: 'reset', code: register.code, now: T0 })).toMatchObject({ ok: false })
    // 两边的码各自在各自的用途下有效。
    expect(verifyEmailCode({ email: EMAIL, purpose: 'register', code: register.code, now: T0 }).ok).toBe(true)
    expect(verifyEmailCode({ email: EMAIL, purpose: 'reset', code: reset.code, now: T0 }).ok).toBe(true)
  })

  it('邮箱非法时拒绝签发，不浪费一次发信', () => {
    expect(issueEmailCode({ email: 'bad', purpose: 'register', ip: '1.1.1.1', now: T0 })).toEqual({
      ok: false,
      reason: 'invalid-email',
    })
  })

  it('同一邮箱打到每日上限后拒绝，护住收件人不被反复打扰', () => {
    let at = T0
    for (let index = 0; index < 8; index += 1) {
      expect(issueEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1', now: at }).ok).toBe(true)
      at += EMAIL_CODE_COOLDOWN_MS
    }
    expect(issueEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1', now: at })).toEqual({
      ok: false,
      reason: 'daily-limit',
    })
    // 换一天就恢复了。
    expect(issueEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1', now: at + 24 * 60 * 60 * 1000 }).ok).toBe(true)
  })

  it('同一 IP 换着邮箱刷也会被每小时上限挡住，护住发信账号的额度', () => {
    let at = T0
    for (let index = 0; index < 20; index += 1) {
      const result = issueEmailCode({ email: `user${index}@qq.com`, purpose: 'register', ip: '9.9.9.9', now: at })
      expect(result.ok).toBe(true)
      at += 1000
    }
    expect(issueEmailCode({ email: 'another@qq.com', purpose: 'register', ip: '9.9.9.9', now: at })).toEqual({
      ok: false,
      reason: 'ip-limit',
    })
    // 换个 IP 立刻可用。
    expect(issueEmailCode({ email: 'another@qq.com', purpose: 'register', ip: '8.8.8.8', now: at }).ok).toBe(true)
  })

  it('限流值可配，且配置到 1 就是真的只允许一次', () => {
    const options = { email: EMAIL, purpose: 'register', ip: '1.1.1.1', dailyPerEmail: 1 }
    expect(issueEmailCode({ ...options, now: T0 }).ok).toBe(true)
    const at = T0 + EMAIL_CODE_COOLDOWN_MS
    expect(issueEmailCode({ ...options, now: at }).reason).toBe('daily-limit')
  })
})

describe('verifyEmailCode', () => {
  it('验证通过后立即销毁，同一个码不能用第二次', () => {
    const { code } = issueEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1', now: T0 })
    expect(verifyEmailCode({ email: EMAIL, purpose: 'register', code, now: T0 }).ok).toBe(true)
    expect(verifyEmailCode({ email: EMAIL, purpose: 'register', code, now: T0 })).toMatchObject({ ok: false, reason: 'missing' })
  })

  it('用户从邮件里复制带上的空格会被容忍', () => {
    const { code } = issueEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1', now: T0 })
    expect(verifyEmailCode({ email: EMAIL, purpose: 'register', code: ` ${code} `, now: T0 }).ok).toBe(true)
  })

  it('码错时报错并告知还剩几次机会', () => {
    const { code } = issueEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1', now: T0 })
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0')
    const result = verifyEmailCode({ email: EMAIL, purpose: 'register', code: wrong, now: T0 })
    expect(result.reason).toBe('mismatch')
    expect(result.remainingAttempts).toBe(EMAIL_CODE_MAX_ATTEMPTS - 1)
  })

  it('连错 5 次后码作废，正确的码也不再接受——挡住在线爆破', () => {
    const { code } = issueEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1', now: T0 })
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0')
    for (let attempt = 0; attempt < EMAIL_CODE_MAX_ATTEMPTS - 1; attempt += 1) {
      expect(verifyEmailCode({ email: EMAIL, purpose: 'register', code: wrong, now: T0 }).reason).toBe('mismatch')
    }
    expect(verifyEmailCode({ email: EMAIL, purpose: 'register', code: wrong, now: T0 }).reason).toBe('too-many-attempts')
    // 码已经销毁，正确的码也救不回来，用户必须重新发。
    expect(verifyEmailCode({ email: EMAIL, purpose: 'register', code, now: T0 }).reason).toBe('missing')
  })

  it('过期的码直接判过期并清掉', () => {
    const { code } = issueEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1', now: T0 })
    const result = verifyEmailCode({ email: EMAIL, purpose: 'register', code, now: T0 + EMAIL_CODE_TTL_MS + 1 })
    expect(result.reason).toBe('expired')
    expect(verifyEmailCode({ email: EMAIL, purpose: 'register', code, now: T0 }).reason).toBe('missing')
  })

  it('从没发过码就验会被判 missing，而不是放行', () => {
    expect(verifyEmailCode({ email: EMAIL, purpose: 'register', code: '123456', now: T0 }).reason).toBe('missing')
    expect(verifyEmailCode({ email: 'bad', purpose: 'register', code: '123456', now: T0 }).reason).toBe('invalid-email')
  })
})

describe('cancelEmailCode', () => {
  it('发信失败时把码和额度一起退回，别让用户白等一天', () => {
    const first = issueEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1', now: T0 })
    expect(first.ok).toBe(true)
    cancelEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1' })

    // 冷却和每日额度都退了：立刻可以重发。
    const second = issueEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1', now: T0 + 1 })
    expect(second.ok).toBe(true)
    // 旧码已经不复存在（坑位被新码占了）。
    expect(verifyEmailCode({ email: EMAIL, purpose: 'register', code: first.code, now: T0 + 1 })).toMatchObject({ ok: false })
  })

  it('没有待处理的码时调用它也不会炸', () => {
    expect(() => cancelEmailCode({ email: EMAIL, purpose: 'register', ip: '1.1.1.1' })).not.toThrow()
    expect(() => cancelEmailCode({})).not.toThrow()
  })
})
