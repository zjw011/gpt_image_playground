// 邀请返积分与同 IP 限制的单元测试。
// 这里是"防刷号"的账本逻辑，算错一处要么白送积分，要么误伤正常用户。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getBalance, initCredits } from './credits.mjs'
import { countAccountsForIp, inviteStats, maybeRewardInviter, normalizeIp, resolveInviter } from './referral.mjs'
import { initStore, normalizeUser, updateConfig } from './store.mjs'

function makeUser(id, patch = {}) {
  return normalizeUser({ id, username: id, passwordHash: 'x', enabled: true, ...patch }, id)
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'gip-referral-'))
  initStore(dir)
  initCredits(dir)
})

afterEach(() => {
  // 每个用例自带临时目录，无需清理
})

describe('normalizeIp', () => {
  it('IPv4 原样返回', () => {
    expect(normalizeIp('1.2.3.4')).toBe('1.2.3.4')
    expect(normalizeIp(' 1.2.3.4 ')).toBe('1.2.3.4')
  })

  it('IPv4-mapped IPv6 按 IPv4 处理（Node 在双栈下常给这种）', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4')
  })

  it('IPv6 归并到 /64：同一网段的不同设备算同一个 IP', () => {
    const a = normalizeIp('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd')
    const b = normalizeIp('2001:db8:1234:5678:1111:2222:3333:4444')
    expect(a).toBe('2001:db8:1234:5678')
    expect(a).toBe(b)
  })

  it('压缩写法（::）也归并到 /64', () => {
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8:0:0')
    expect(normalizeIp('2001:db8::2')).toBe('2001:db8:0:0')
  })

  it('空值返回空串', () => {
    expect(normalizeIp('')).toBe('')
    expect(normalizeIp(undefined)).toBe('')
  })
})

describe('countAccountsForIp', () => {
  it('只统计自助注册的账号，管理员手动建的号不占名额', () => {
    updateConfig((config) => {
      config.users = [
        makeUser('u-1', { registerIp: '9.9.9.9', createdVia: 'email' }),
        makeUser('u-2', { registerIp: '9.9.9.9', createdVia: 'email' }),
        // 管理员手动建的救急账号：不参与统计
        makeUser('u-3', { registerIp: '9.9.9.9', createdVia: 'admin' }),
        makeUser('u-4', { registerIp: '8.8.8.8', createdVia: 'email' }),
      ]
      return config
    })
    expect(countAccountsForIp('9.9.9.9')).toBe(2)
    expect(countAccountsForIp('::ffff:9.9.9.9')).toBe(2)
    expect(countAccountsForIp('8.8.8.8')).toBe(1)
    expect(countAccountsForIp('1.1.1.1')).toBe(0)
  })
})

describe('maybeRewardInviter', () => {
  const seed = (site = {}) => {
    updateConfig((config) => {
      config.site = { ...config.site, referralEnabled: true, referralReward: 30, referralMaxInvites: 20, ...site }
      config.users = [
        makeUser('u-inviter'),
        makeUser('u-invitee', { invitedBy: 'u-inviter' }),
      ]
      return config
    })
  }

  it('被邀请人首图出图后给邀请人加分，并标记已奖励', () => {
    seed()
    expect(getBalance('u-inviter')).toBe(0)
    expect(maybeRewardInviter('u-invitee')).toMatchObject({ rewarded: true, reward: 30, inviterId: 'u-inviter' })
    expect(getBalance('u-inviter')).toBe(30)
  })

  it('同一个人再出图不会重复发奖', () => {
    seed()
    maybeRewardInviter('u-invitee')
    expect(maybeRewardInviter('u-invitee')).toMatchObject({ rewarded: false, reason: 'no-invite' })
    expect(getBalance('u-inviter')).toBe(30)
  })

  it('配置关掉时一分不发', () => {
    seed({ referralEnabled: false })
    expect(maybeRewardInviter('u-invitee')).toMatchObject({ rewarded: false, reason: 'disabled' })
    expect(getBalance('u-inviter')).toBe(0)
  })

  it('没有邀请人的普通用户不触发任何事', () => {
    seed()
    expect(maybeRewardInviter('u-inviter')).toMatchObject({ rewarded: false, reason: 'no-invite' })
    expect(getBalance('u-inviter')).toBe(0)
  })

  it('邀请人被删除后不发奖（钱不能进无主账户）', () => {
    seed()
    updateConfig((config) => {
      config.users = config.users.filter((user) => user.id !== 'u-inviter')
      return config
    })
    expect(maybeRewardInviter('u-invitee')).toMatchObject({ rewarded: false, reason: 'inviter-missing' })
  })

  it('超过单个邀请人的奖励上限后不再发', () => {
    seed({ referralMaxInvites: 1 })
    updateConfig((config) => {
      config.users.push(makeUser('u-invitee-2', { invitedBy: 'u-inviter' }))
      return config
    })
    expect(maybeRewardInviter('u-invitee')).toMatchObject({ rewarded: true })
    expect(maybeRewardInviter('u-invitee-2')).toMatchObject({ rewarded: false, reason: 'cap-reached' })
    expect(getBalance('u-inviter')).toBe(30)
  })

  it('统计口径：已邀请 / 已获奖', () => {
    seed()
    expect(inviteStats('u-inviter')).toEqual({ invited: 1, rewarded: 0 })
    maybeRewardInviter('u-invitee')
    expect(inviteStats('u-inviter')).toEqual({ invited: 1, rewarded: 1 })
  })
})

describe('resolveInviter', () => {
  it('只认存在且启用中的账号', () => {
    updateConfig((config) => {
      config.users = [makeUser('u-ok'), makeUser('u-off', { enabled: false })]
      return config
    })
    expect(resolveInviter('u-ok')?.id).toBe('u-ok')
    expect(resolveInviter('u-off')).toBeNull()
    expect(resolveInviter('u-nobody')).toBeNull()
    expect(resolveInviter('')).toBeNull()
  })
})
