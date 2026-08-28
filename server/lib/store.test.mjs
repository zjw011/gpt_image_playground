// 配置清洗回归测试：多用户字段与访问方式迁移都靠 normalizeConfig 兜底，
// 一旦它放过非法用户名或迁错 accessMode，就会出现无法登录或永远登不进去的配置。

import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { generateInviteCode, generatePasscode, getConfig, initStore, inviteStatus, isValidUsername, normalizeInviteCode, toAdminUser, updateConfig } from './store.mjs'

/** 用给定配置内容初始化一个临时数据目录。传 null 表示不写配置文件（首次启动）。 */
function initWith(config) {
  const dir = mkdtempSync(join(tmpdir(), 'gip-store-'))
  if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config), 'utf-8')
  return initStore(dir)
}

describe('generatePasscode', () => {
  it('生成 xxxx-xxxx 形式的口令，且不含容易看错的字符', () => {
    for (let i = 0; i < 200; i += 1) {
      const passcode = generatePasscode()
      expect(passcode).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/)
      // 0/O/1/l/I 这几个是要口头转达时的重灾区，字母表里就不该有它们。
      expect(passcode).not.toMatch(/[01loi]/)
    }
  })

  it('长度满足最小口令要求，且不会重复', () => {
    const samples = new Set(Array.from({ length: 500 }, () => generatePasscode()))
    expect(samples.size).toBe(500)
    expect([...samples][0].length).toBeGreaterThanOrEqual(6)
  })
})

describe('isValidUsername', () => {
  it('接受 2-32 位字母数字与 _ . -，要求首字符是字母或数字', () => {
    expect(isValidUsername('alice')).toBe(true)
    expect(isValidUsername('a1')).toBe(true)
    expect(isValidUsername('team.lead-01_x')).toBe(true)
    expect(isValidUsername('a')).toBe(false)
    expect(isValidUsername('_alice')).toBe(false)
    expect(isValidUsername('张三')).toBe(false)
    expect(isValidUsername('a'.repeat(33))).toBe(false)
    expect(isValidUsername('')).toBe(false)
  })
})

describe('accessMode 迁移', () => {
  it('首次启动默认开放访问', () => {
    expect(initWith(null).site.accessMode).toBe('open')
  })

  it('老配置 guestGateEnabled=true 迁移成 passcode', () => {
    const config = initWith({ version: 1, site: { guestGateEnabled: true }, channels: [] })
    expect(config.site.accessMode).toBe('passcode')
  })

  it('老配置 guestGateEnabled=false 迁移成 open', () => {
    const config = initWith({ version: 1, site: { guestGateEnabled: false }, channels: [] })
    expect(config.site.accessMode).toBe('open')
  })

  it('未知的 accessMode 回落到迁移结果而不是原样保留', () => {
    const config = initWith({ version: 2, site: { accessMode: 'anything', guestGateEnabled: true }, channels: [] })
    expect(config.site.accessMode).toBe('passcode')
  })
})

describe('users 清洗', () => {
  it('丢弃用户名非法与重复的条目，并按 id/用户名去重（大小写不敏感）', () => {
    const config = initWith({
      version: 2,
      users: [
        { id: 'u-1', username: 'alice', passwordHash: 'h1' },
        { id: 'u-2', username: 'ALICE', passwordHash: 'h2' },
        { id: 'u-1', username: 'bob', passwordHash: 'h3' },
        { id: 'u-3', username: '_bad', passwordHash: 'h4' },
        { id: 'u-4', username: 'carol', passwordHash: 'h5' },
      ],
      channels: [],
    })
    expect(config.users.map((user) => user.username)).toEqual(['alice', 'carol'])
  })

  it('补齐缺省字段', () => {
    const config = initWith({ version: 2, users: [{ id: 'u-1', username: 'alice' }], channels: [] })
    expect(config.users[0]).toMatchObject({ displayName: '', note: '', enabled: true, passwordHash: '', lastSeenAt: 0 })
  })
})

describe('agent 设置清洗', () => {
  const responsesChannel = { id: 'ch-t', name: '对话', provider: 'openai', apiMode: 'responses', baseUrl: 'https://x/v1', apiKey: 'k', enabled: true }
  const imagesChannel = { id: 'ch-i', name: '出图', provider: 'openai', apiMode: 'images', baseUrl: 'https://x/v1', apiKey: 'k', enabled: true }

  it('首次启动默认关闭', () => {
    expect(initWith(null).site.agentMode).toBe('off')
  })

  it('没指定文本渠道时自动挑一条可用的 Responses 渠道，但不会顺手打开', () => {
    const config = initWith({ version: 2, site: {}, channels: [imagesChannel, responsesChannel] })
    expect(config.site.agentTextChannelId).toBe('ch-t')
    expect(config.site.agentMode).toBe('off')
  })

  it('指定的文本渠道被停用后回落到 off，避免前端露出点进去就报错的入口', () => {
    const config = initWith({
      version: 2,
      site: { agentMode: 'native', agentTextChannelId: 'ch-t' },
      channels: [{ ...responsesChannel, enabled: false }],
    })
    expect(config.site.agentMode).toBe('off')
    expect(config.site.agentTextChannelId).toBe('')
  })

  it('文本渠道改成 Images API 后同样回落', () => {
    const config = initWith({
      version: 2,
      site: { agentMode: 'native', agentTextChannelId: 'ch-t' },
      channels: [{ ...responsesChannel, apiMode: 'images' }],
    })
    expect(config.site.agentMode).toBe('off')
  })

  it('混合模式缺了图像渠道就回落，文本渠道齐全也不例外', () => {
    const config = initWith({
      version: 2,
      site: { agentMode: 'hybrid', agentTextChannelId: 'ch-t', agentImageChannelId: 'ch-gone' },
      channels: [responsesChannel],
    })
    expect(config.site.agentMode).toBe('off')
  })

  it('渠道齐全时保留 hybrid 与工具轮数、联网开关', () => {
    const config = initWith({
      version: 2,
      site: { agentMode: 'hybrid', agentTextChannelId: 'ch-t', agentImageChannelId: 'ch-i', agentMaxToolRounds: 30, agentWebSearch: true },
      channels: [responsesChannel, imagesChannel],
    })
    expect(config.site).toMatchObject({ agentMode: 'hybrid', agentTextChannelId: 'ch-t', agentImageChannelId: 'ch-i', agentMaxToolRounds: 30, agentWebSearch: true })
  })

  it('未知的 agentMode 与越界的工具轮数被收敛', () => {
    const config = initWith({
      version: 2,
      site: { agentMode: 'magic', agentTextChannelId: 'ch-t', agentMaxToolRounds: 9999 },
      channels: [responsesChannel],
    })
    expect(config.site.agentMode).toBe('off')
    expect(config.site.agentMaxToolRounds).toBe(100)
  })
})

describe('toAdminUser', () => {
  it('只回传是否设置了口令，绝不回传哈希', () => {
    initWith({ version: 2, users: [{ id: 'u-1', username: 'alice', passwordHash: 'scrypt$aa$bb' }], channels: [] })
    const projected = toAdminUser(getConfig().users[0])
    expect(projected.hasPassword).toBe(true)
    expect('passwordHash' in projected).toBe(false)
    expect(JSON.stringify(projected)).not.toContain('scrypt')
  })
})

describe('updateConfig', () => {
  it('写入的用户经过清洗后仍可读回', () => {
    initWith(null)
    updateConfig((config) => {
      config.users.push({ id: 'u-9', username: 'dave', passwordHash: 'h' })
      return config
    })
    expect(getConfig().users.map((user) => user.username)).toEqual(['dave'])
  })
})

describe('邀请码', () => {
  it('生成 xxxxx-xxxxx 形式，且不含容易看错的字符', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateInviteCode()
      expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/)
      expect(code).not.toMatch(/[01loi]/)
    }
  })

  it('比对时忽略大小写和连字符——用户手抄最容易在这两处出错', () => {
    expect(normalizeInviteCode('Q7MKX-3F9DP')).toBe('q7mkx3f9dp')
    expect(normalizeInviteCode('  q7mkx3f9dp  ')).toBe('q7mkx3f9dp')
    expect(normalizeInviteCode('q7mkx-3f9dp')).toBe(normalizeInviteCode('Q7MKX3F9DP'))
  })

  it('自助注册默认关闭', () => {
    expect(initWith(null).site).toMatchObject({ registrationEnabled: false, inviteCode: '', inviteUsedCount: 0 })
  })

  it('不是多用户模式时开关被强制关掉——别的模式下前端没有账号这个概念', () => {
    const config = initWith({
      version: 2,
      site: { accessMode: 'open', registrationEnabled: true, inviteCode: 'abcde-fghij' },
      channels: [],
    })
    expect(config.site.registrationEnabled).toBe(false)
  })

  it('没有邀请码时开关也被强制关掉，避免留一个半开的状态', () => {
    const config = initWith({
      version: 2,
      site: { accessMode: 'accounts', registrationEnabled: true, inviteCode: '' },
      users: [{ id: 'u-1', username: 'alice', passwordHash: 'h' }],
      channels: [],
    })
    expect(config.site.registrationEnabled).toBe(false)
  })

  it('多用户模式且有邀请码时保留开关与名额限制', () => {
    const config = initWith({
      version: 2,
      site: { accessMode: 'accounts', registrationEnabled: true, inviteCode: 'abcde-fghij', inviteMaxUses: 5, inviteUsedCount: 2 },
      users: [{ id: 'u-1', username: 'alice', passwordHash: 'h' }],
      channels: [],
    })
    expect(config.site).toMatchObject({ registrationEnabled: true, inviteMaxUses: 5, inviteUsedCount: 2 })
  })

  it('inviteStatus 区分关闭、过期与名额用完，好让注册页说清具体原因', () => {
    const base = { registrationEnabled: true, inviteCode: 'abcde-fghij', inviteMaxUses: 0, inviteUsedCount: 0, inviteExpiresAt: 0 }
    expect(inviteStatus(base)).toEqual({ ok: true, reason: '' })
    expect(inviteStatus({ ...base, registrationEnabled: false }).reason).toBe('disabled')
    expect(inviteStatus({ ...base, inviteCode: '' }).reason).toBe('disabled')
    expect(inviteStatus({ ...base, inviteExpiresAt: 1000 }, 2000).reason).toBe('expired')
    expect(inviteStatus({ ...base, inviteExpiresAt: 5000 }, 2000).ok).toBe(true)
    expect(inviteStatus({ ...base, inviteMaxUses: 3, inviteUsedCount: 3 }).reason).toBe('exhausted')
    expect(inviteStatus({ ...base, inviteMaxUses: 3, inviteUsedCount: 2 }).ok).toBe(true)
  })

  it('createdVia 只认 invite，其余一律算管理员创建', () => {
    const config = initWith({
      version: 2,
      users: [
        { id: 'u-1', username: 'alice', passwordHash: 'h', createdVia: 'invite' },
        { id: 'u-2', username: 'bob', passwordHash: 'h' },
        { id: 'u-3', username: 'carol', passwordHash: 'h', createdVia: 'hack' },
      ],
      channels: [],
    })
    expect(config.users.map((user) => user.createdVia)).toEqual(['invite', 'admin', 'admin'])
  })
})
