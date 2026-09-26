// 卡密库回归测试。
// 卡密是站外收款后在本站兑付的凭证，所以重点盯：码不重复、只能核销一次、
// 已兑换的卡不能被删掉（那是财务凭证）、以及用户手抄进来的各种格式都能认。

import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  cardsOverview,
  deleteBatch,
  deleteCards,
  exportCards,
  generateCards,
  initCards,
  listBatches,
  listCards,
  normalizeCardCode,
  recentRedeems,
  redeemCard,
  restoreCards,
  voidBatch,
  voidCards,
} from './cards.mjs'

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'gip-cards-'))
  initCards(dir)
  return dir
}

describe('generateCards', () => {
  it('批量生成，面额与数量都对，且立刻落盘', () => {
    const dir = freshDir()
    const result = generateCards({ credits: 100, count: 5, note: '双十一' })

    expect(result.codes).toHaveLength(5)
    expect(result.credits).toBe(100)
    expect(new Set(result.codes).size).toBe(5)

    const onDisk = JSON.parse(readFileSync(join(dir, 'cards.json'), 'utf-8'))
    expect(onDisk.cards).toHaveLength(5)
    expect(onDisk.batches).toHaveLength(1)
  })

  it('卡密格式形如 GIP-XXXX-XXXX-XXXX，且不含易混字符', () => {
    freshDir()
    const { codes } = generateCards({ credits: 10, count: 30 })
    for (const code of codes) {
      expect(code).toMatch(/^GIP-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
      // I / O / 0 / 1 全部避开：手抄小票时这四个最容易错。
      expect(code.slice(4)).not.toMatch(/[IO01]/)
    }
  })

  it('面额或数量非法时直接拒绝，不会生成半批垃圾数据', () => {
    freshDir()
    expect(() => generateCards({ credits: 0, count: 5 })).toThrow(/面额/)
    expect(() => generateCards({ credits: 100, count: 0 })).toThrow(/数量/)
    expect(() => generateCards({ credits: 100, count: 99999 })).toThrow(/2000/)
    expect(cardsOverview().total).toBe(0)
  })

  it('多个批次互相独立，各自统计', () => {
    freshDir()
    const first = generateCards({ credits: 100, count: 3, note: '批次一' })
    const second = generateCards({ credits: 500, count: 2, note: '批次二' })
    expect(first.batchId).not.toBe(second.batchId)

    const batches = listBatches()
    expect(batches).toHaveLength(2)
    // 最新的批次排在前面。
    expect(batches[0]).toMatchObject({ id: second.batchId, credits: 500, count: 2, total: 2 })
    expect(batches[1]).toMatchObject({ id: first.batchId, credits: 100, count: 3, total: 3 })
  })
})

describe('redeemCard', () => {
  it('正常核销：返回面额并记录使用人', () => {
    freshDir()
    const { codes } = generateCards({ credits: 300, count: 1 })

    const result = redeemCard(codes[0], 'u-1')
    expect(result).toMatchObject({ ok: true, credits: 300 })

    const row = listCards().cards[0]
    expect(row.status).toBe('used')
    expect(row.usedBy).toBe('u-1')
    expect(row.usedAt).toBeGreaterThan(0)
  })

  it('同一张卡不能兑两次，且提示里带上上次使用时间', () => {
    freshDir()
    const { codes } = generateCards({ credits: 300, count: 1 })
    redeemCard(codes[0], 'u-1')

    const again = redeemCard(codes[0], 'u-2')
    expect(again.ok).toBe(false)
    expect(again.reason).toBe('used')
    expect(again.message).toMatch(/已于/)
  })

  it('容忍用户手抄格式：小写、空格、漏掉连字符都能认', () => {
    freshDir()
    const { codes } = generateCards({ credits: 50, count: 1 })
    const messy = codes[0].toLowerCase().replace(/-/g, ' ')

    expect(redeemCard(messy, 'u-1')).toMatchObject({ ok: true, credits: 50 })
  })

  it('不存在的码、作废的码、空输入各自给不同提示——前台要能把原因说清楚', () => {
    freshDir()
    const { codes } = generateCards({ credits: 50, count: 2 })
    voidCards([codes[0]])

    expect(redeemCard('GIP-ZZZZ-ZZZZ-ZZZZ', 'u-1').reason).toBe('not-found')
    expect(redeemCard(codes[0], 'u-1').reason).toBe('void')
    expect(redeemCard('   ', 'u-1').reason).toBe('empty')
  })

  it('没有登录用户时不核销，卡密保持可用', () => {
    freshDir()
    const { codes } = generateCards({ credits: 50, count: 1 })
    expect(redeemCard(codes[0], '').reason).toBe('no-user')
    expect(listCards().cards[0].status).toBe('unused')
  })

  it('兑换后重启服务，核销状态不丢', () => {
    const dir = freshDir()
    const { codes } = generateCards({ credits: 80, count: 2 })
    redeemCard(codes[0], 'u-1')

    initCards(dir)
    expect(redeemCard(codes[0], 'u-2').reason).toBe('used')
    expect(redeemCard(codes[1], 'u-2')).toMatchObject({ ok: true, credits: 80 })
  })
})

describe('作废与删除', () => {
  it('作废只影响未使用的卡，已兑换的不受影响', () => {
    freshDir()
    const { codes } = generateCards({ credits: 50, count: 3 })
    redeemCard(codes[0], 'u-1')

    expect(voidCards(codes).changed).toBe(2)
    expect(listCards({ status: 'void' }).total).toBe(2)
    expect(listCards({ status: 'used' }).total).toBe(1)
  })

  it('作废可以恢复，恢复只影响已作废的卡', () => {
    freshDir()
    const { codes } = generateCards({ credits: 50, count: 2 })
    redeemCard(codes[0], 'u-1')
    voidCards(codes)

    expect(restoreCards(codes).changed).toBe(1)
    expect(listCards({ status: 'unused' }).total).toBe(1)
    expect(listCards({ status: 'used' }).total).toBe(1)
  })

  it('已兑换的卡不允许删除——它是财务凭证，必须留在库里', () => {
    freshDir()
    const { codes } = generateCards({ credits: 50, count: 2 })
    redeemCard(codes[0], 'u-1')

    const result = deleteCards(codes)
    expect(result).toMatchObject({ removed: 1, skipped: 1 })
    expect(listCards().total).toBe(1)
    expect(listCards().cards[0].status).toBe('used')
  })

  it('整批作废与整批删除', () => {
    freshDir()
    const { batchId, codes } = generateCards({ credits: 50, count: 4 })
    redeemCard(codes[0], 'u-1')

    expect(voidBatch(batchId).changed).toBe(3)
    // 已兑换的那张会留下，其余删掉。
    expect(deleteBatch(batchId).removed).toBe(3)
    expect(listCards().total).toBe(1)
  })
})

describe('查询与导出', () => {
  it('按状态、批次、关键字筛选，并且分页', () => {
    freshDir()
    generateCards({ credits: 100, count: 5, note: 'A' })
    const second = generateCards({ credits: 200, count: 5, note: 'B' })
    voidCards(second.codes.slice(0, 2))

    expect(listCards({ status: 'unused' }).total).toBe(8)
    expect(listCards({ status: 'void' }).total).toBe(2)
    expect(listCards({ batch: second.batchId }).total).toBe(5)
    expect(listCards({ keyword: normalizeCardCode(second.codes[3]) }).total).toBe(1)

    const page = listCards({ limit: 3, offset: 3 })
    expect(page.total).toBe(10)
    expect(page.cards).toHaveLength(3)
    expect(page.limit).toBe(3)
  })

  it('导出只给码、面额和批次，够贴到发卡网就行', () => {
    freshDir()
    const { batchId } = generateCards({ credits: 500, count: 3, note: '贴卡' })
    const rows = exportCards({ batch: batchId })

    expect(rows).toHaveLength(3)
    expect(Object.keys(rows[0]).sort()).toEqual(['batch', 'code', 'credits', 'note', 'status'])
    expect(rows.every((row) => row.credits === 500)).toBe(true)
  })

  it('最近兑换列表带上用户名，已删用户也能看出来', () => {
    freshDir()
    const { codes } = generateCards({ credits: 300, count: 2 })
    redeemCard(codes[0], 'u-1')
    redeemCard(codes[1], 'u-2')

    const rows = recentRedeems(10, new Map([['u-1', '张三']]))
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.usedBy === 'u-1')).toMatchObject({ userName: '张三', exists: true })
    expect(rows.find((row) => row.usedBy === 'u-2')).toMatchObject({ userName: '（已删除的用户）', exists: false })
  })
})

describe('概览与持久化', () => {
  it('概览区分库存与已兑付积分', () => {
    freshDir()
    const { codes } = generateCards({ credits: 100, count: 4 })
    redeemCard(codes[0], 'u-1')
    voidCards([codes[1]])

    expect(cardsOverview()).toMatchObject({
      total: 4,
      used: 1,
      void: 1,
      unused: 2,
      redeemedCredits: 100,
      unusedCredits: 200,
      batches: 1,
    })
  })

  it('重启后卡密与批次完整恢复', () => {
    const dir = freshDir()
    const { batchId } = generateCards({ credits: 100, count: 3, note: '持久化' })

    initCards(dir)
    expect(listCards().total).toBe(3)
    expect(listBatches()[0]).toMatchObject({ id: batchId, note: '持久化' })
  })

  it('库文件损坏时自动恢复最近备份，不清空未兑付卡密', () => {
    const dir = freshDir()
    generateCards({ credits: 100, count: 2 })

    const { writeFileSync } = require('node:fs')
    writeFileSync(join(dir, 'cards.json'), 'not json at all', 'utf-8')

    initCards(dir)
    expect(existsSync(join(dir, 'cards.json.corrupt'))).toBe(true)
    expect(listCards().total).toBe(2)
  })

  it('清洗非法数据：重复码与空码被丢弃，非法状态退回未使用', () => {
    const dir = freshDir()
    const { writeFileSync } = require('node:fs')
    writeFileSync(join(dir, 'cards.json'), JSON.stringify({
      version: 1,
      cards: [
        { code: 'GIP-AAAA-AAAA-AAAA', credits: 100, status: 'unknown-status' },
        { code: 'GIP-AAAA-AAAA-AAAA', credits: 100 },
        { code: '', credits: 100 },
        { code: 'GIP-BBBB-BBBB-BBBB', credits: -5 },
      ],
    }), 'utf-8')

    initCards(dir)
    const cards = listCards().cards
    expect(cards).toHaveLength(2)
    expect(cards.every((card) => card.status === 'unused')).toBe(true)
    expect(cards.find((card) => card.code.endsWith('BBBB')).credits).toBe(0)
  })
})
