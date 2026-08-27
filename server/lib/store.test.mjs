// 配置清洗回归测试：多用户字段与访问方式迁移都靠 normalizeConfig 兜底，
// 一旦它放过非法用户名或迁错 accessMode，就会出现无法登录或永远登不进去的配置。

import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { generatePasscode, getConfig, initStore, isValidUsername, toAdminUser, updateConfig } from './store.mjs'

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
