// 在真实隔离文件目录中注入提交失败，验证跨文件交易能补偿且不重复入账。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import * as durable from './durableJson.mjs'
import { generateCards, initCards, listCards, redeemCardCredits, recoverCardCredits } from './cards.mjs'
import { addCredits, getAccount, getBalance, getReserved, hasCreditOperation, initCredits, listLedger, recordLuckyFree, refundCredits, reserveCredits, resetCreditStats, resetReservations, setBalance, settleCredits, spendCredits } from './credits.mjs'
import { getImagePath, initGallery, listWorks, publishWork, removeWork } from './gallery.mjs'
import { initGalleryComments } from './galleryComments.mjs'
import { maybeRewardInviter, recoverReferralRewards } from './referral.mjs'
import { getConfig, hashPassword, hashPasswordAsync, initStore, updateConfig, verifyPassword, verifyPasswordAsync } from './store.mjs'

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'gip-financial-'))
  initStore(dir)
  initCredits(dir)
  initCards(dir)
  resetReservations()
  return dir
}

function failWrite(name, count = 1) {
  const write = durable.writeDurableJson
  let matched = 0
  return vi.spyOn(durable, 'writeDurableJson').mockImplementation((file, ...args) => {
    if (file.endsWith(name) && ++matched === count) throw new Error('模拟磁盘写入失败')
    return write(file, ...args)
  })
}

function seedReferral() {
  updateConfig((config) => {
    config.site.referralEnabled = true
    config.site.referralReward = 30
    config.site.referralMaxInvites = 1
    config.users = [
      { id: 'inviter', username: 'inviter', enabled: true },
      { id: 'invitee', username: 'invitee', invitedBy: 'inviter' },
      { id: 'other', username: 'other', invitedBy: 'inviter' },
    ]
    return config
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  resetReservations()
})

describe('积分提交与去重', () => {
  it.each(['add', 'spend', 'set', 'lucky'])('%s 写盘失败时余额、累计和流水都不改变', (kind) => {
    const dir = fresh()
    addCredits('u1', 100)
    const before = getAccount('u1')
    const file = join(dir, 'credits.json')
    const saved = readFileSync(file, 'utf8')
    failWrite('credits.json')
    const mutate = {
      add: () => addCredits('u1', 20),
      spend: () => spendCredits('u1', 20),
      set: () => setBalance('u1', 20),
      lucky: () => recordLuckyFree('u1'),
    }[kind]
    expect(mutate).toThrow('模拟磁盘')
    expect(getAccount('u1')).toEqual(before)
    expect(listLedger('u1')).toHaveLength(1)
    expect(readFileSync(file, 'utf8')).toBe(saved)
  })

  it('主文件已提交后报错仍识别成功，不重放相同扣费', () => {
    fresh()
    addCredits('u1', 100)
    const write = durable.writeDurableJson
    vi.spyOn(durable, 'writeDurableJson').mockImplementationOnce((...args) => {
      write(...args)
      throw new Error('模拟提交后备份失败')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(spendCredits('u1', 10, { operationId: 'task:1' }).ok).toBe(true)
    expect(spendCredits('u1', 10, { operationId: 'task:1' }).duplicated).toBe(true)
    expect(getBalance('u1')).toBe(90)
  })

  it('扣费、退款和免单收据在重启及清统计后仍保留，冲突编号拒绝执行', () => {
    const dir = fresh()
    addCredits('u1', 100)
    spendCredits('u1', 20, { operationId: 'task:1', images: 2 })
    refundCredits('u1', 5, { operationId: 'refund:1' })
    recordLuckyFree('u1', { operationId: 'lucky:1', images: 1 })
    resetCreditStats()
    initCredits(dir)
    expect(hasCreditOperation('task:1')).toBe(true)
    expect(spendCredits('u1', 20, { operationId: 'task:1', images: 2 }).duplicated).toBe(true)
    expect(refundCredits('u1', 5, { operationId: 'refund:1' }).duplicated).toBe(true)
    expect(recordLuckyFree('u1', { operationId: 'lucky:1', images: 1 }).duplicated).toBe(true)
    expect(() => spendCredits('u1', 21, { operationId: 'task:1', images: 2 })).toThrow('其他交易')
    expect(() => spendCredits('u2', 20, { operationId: 'task:1', images: 2 })).toThrow('其他交易')
    expect(getBalance('u1')).toBe(85)
    expect(listLedger('u1')).toHaveLength(0)
  })

  it('重复结算不释放另一任务的占位，余额不足的恢复任务保留占位', () => {
    fresh()
    addCredits('u1', 100)
    reserveCredits('u1', 20)
    reserveCredits('u1', 20)
    settleCredits('u1', 20, { reserved: 20, operationId: 'task:1' })
    settleCredits('u1', 20, { reserved: 20, operationId: 'task:1' })
    expect(getReserved('u1')).toBe(20)
    setBalance('u1', 0)
    reserveCredits('u1', 10, { restore: true })
    expect(settleCredits('u1', 10, { reserved: 10, operationId: 'task:2' }).ok).toBe(false)
    expect(getReserved('u1')).toBe(30)
  })

  it('多次合法充值的累计余额不会在重启时被单笔上限截断', () => {
    const dir = fresh()
    addCredits('u1', 100_000_000)
    addCredits('u1', 20)
    initCredits(dir)
    expect(getBalance('u1')).toBe(100_000_020)
  })
})

describe('卡密补偿', () => {
  it('核销记录写入失败不消耗卡密，也不增加积分', () => {
    fresh()
    const code = generateCards({ credits: 20, count: 1 }).codes[0]
    failWrite('cards.json')
    expect(() => redeemCardCredits(code, 'u1')).toThrow('模拟磁盘')
    expect(listCards().cards[0].status).toBe('unused')
    expect(getBalance('u1')).toBe(0)
    expect(redeemCardCredits(code, 'u2').ok).toBe(true)
    expect(getBalance('u2')).toBe(20)
  })

  it.each(['credits', 'finalize'])('%s 写盘失败后重启自动补偿，重试只到账一次', (stage) => {
    const dir = fresh()
    const code = generateCards({ credits: 20, count: 1 }).codes[0]
    failWrite(stage === 'credits' ? 'credits.json' : 'cards.json', stage === 'credits' ? 1 : 2)
    expect(() => redeemCardCredits(code, 'u1')).toThrow('模拟磁盘')
    expect(listCards().cards[0].creditPending).toBe(true)
    expect(redeemCardCredits(code, 'u2').ok).toBe(false)
    vi.restoreAllMocks()
    initCredits(dir)
    initCards(dir)
    recoverCardCredits()
    recoverCardCredits()
    expect(getBalance('u1')).toBe(20)
    expect(listLedger('u1')).toHaveLength(1)
    expect(listCards().cards[0].creditPending).toBe(false)
    expect(redeemCardCredits(code, 'u1').duplicated).toBe(true)
    expect(getBalance('u1')).toBe(20)
  })
})

describe('邀请奖励补偿', () => {
  it.each(['credits', 'finalize'])('%s 写盘失败不丢奖励，重启按原金额补发一次', (stage) => {
    const dir = fresh()
    seedReferral()
    failWrite(stage === 'credits' ? 'credits.json' : 'config.json', stage === 'credits' ? 1 : 2)
    expect(() => maybeRewardInviter('invitee')).toThrow('模拟磁盘')
    expect(getConfig().users.find((user) => user.id === 'invitee').inviteRewarded).toBe(false)
    expect(maybeRewardInviter('other').reason).toBe('cap-reached')
    vi.restoreAllMocks()
    updateConfig((config) => { config.site.referralReward = 99; config.site.referralEnabled = false; return config })
    initStore(dir)
    initCredits(dir)
    recoverReferralRewards()
    recoverReferralRewards()
    expect(getBalance('inviter')).toBe(30)
    expect(listLedger('inviter')).toHaveLength(1)
    expect(getConfig().users.find((user) => user.id === 'invitee').inviteRewarded).toBe(true)
  })
})

describe('业务结构损坏保护', () => {
  it.each([
    ['config.json', { users: null }, initStore],
    ['config.json', { site: { credits: null } }, initStore],
    ['config.json', { users: [{}] }, initStore],
    ['config.json', { users: [{ username: 'alice' }, { username: 'ALICE' }] }, initStore],
    ['credits.json', { users: null }, initCredits],
    ['cards.json', { cards: null }, initCards],
    ['gallery.json', { items: null }, initGallery],
    ['gallery-comments.json', { comments: null }, initGalleryComments],
  ])('%s 能解析但结构损坏时恢复备份；两份都坏则保留原文件并停止', (name, broken, init) => {
    const dir = fresh()
    addCredits('u1', 100)
    generateCards({ credits: 20, count: 1 })
    initGalleryComments(dir)
    initGallery(dir)
    const file = join(dir, name)
    const valid = readFileSync(file, 'utf8')
    writeFileSync(file, JSON.stringify(broken))
    expect(() => init(dir)).not.toThrow()
    expect(readFileSync(file, 'utf8')).toBe(valid)
    writeFileSync(file, JSON.stringify(broken))
    writeFileSync(`${file}.bak`, JSON.stringify(broken))
    expect(() => init(dir)).toThrow('均损坏')
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(broken))
  })

  it('主文件缺失时仍恢复备份，不创建空账本', () => {
    const dir = fresh()
    addCredits('u1', 100)
    unlinkSync(join(dir, 'credits.json'))
    initCredits(dir)
    expect(getBalance('u1')).toBe(100)
  })

  it('索引损坏和删除提交失败都保留原图，重启也不清理未引用文件', () => {
    const dir = fresh()
    initGalleryComments(dir)
    initGallery(dir)
    const result = publishWork({ ownerId: 'u1', imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' })
    const path = getImagePath(result.item.id).path
    failWrite('gallery.json')
    expect(() => removeWork(result.item.id, { userId: 'u1', isAdmin: false })).toThrow('模拟磁盘')
    expect(existsSync(path)).toBe(true)
    expect(listWorks('u1').some((item) => item.id === result.item.id)).toBe(true)
    vi.restoreAllMocks()
    writeFileSync(join(dir, 'gallery.json'), '{"items":null}')
    const orphan = join(dir, 'gallery', 'w-recoverable.png')
    writeFileSync(orphan, 'recoverable-image')
    initGallery(dir)
    initGallery(dir)
    expect(existsSync(path)).toBe(true)
    expect(existsSync(orphan)).toBe(true)
  })
})

describe('异步密码兼容', () => {
  it('同步与异步哈希相互兼容，拒绝空摘要伪造', async () => {
    const encoded = await hashPasswordAsync('test-password')
    expect(verifyPassword('test-password', encoded)).toBe(true)
    expect(await verifyPasswordAsync('test-password', hashPassword('test-password'))).toBe(true)
    expect(await verifyPasswordAsync('wrong', encoded)).toBe(false)
    expect(verifyPassword('anything', 'scrypt$$')).toBe(false)
    expect(await verifyPasswordAsync('anything', 'scrypt$$')).toBe(false)
  })
})
