// 积分账本回归测试。
// 这是整个服务端唯一一处"用户资产"，写盘、扣费、退还任何一处出错都是真实的钱账问题，
// 所以这里重点盯三件事：余额算得对、余额不足时绝不扣、以及重启后数据不丢。

import { describe, expect, it, vi } from 'vitest'
import * as durable from './durableJson.mjs'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  addCredits,
  creditsOverview,
  creditsSummary,
  ensureAccount,
  getAccount,
  getBalance,
  grantSignupBonus,
  grantAllCredits,
  initCredits,
  listLedger,
  recordLuckyFree,
  refundCredits,
  removeAccount,
  resetCreditStats,
  setBalance,
  spendCredits,
  userCreditsView,
} from './credits.mjs'

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'gip-credits-'))
}

describe('grantAllCredits', () => {
  const options = { requestId: 'campaign-test-000001', actorId: 'admin', note: '国庆活动赠送' }

  it('主文件提交失败时内存余额和收据均不改变，可安全重试', () => {
    initCredits(freshDir())
    addCredits('u1', 20)
    const spy = vi.spyOn(durable, 'writeDurableJson').mockImplementationOnce(() => { throw new Error('模拟磁盘写入失败') })
    try {
      expect(() => grantAllCredits(['u1', 'u2'], 100, options)).toThrow('模拟磁盘')
      expect(getBalance('u1')).toBe(20)
      expect(getBalance('u2')).toBe(0)
    } finally { spy.mockRestore() }
    expect(grantAllCredits(['u1', 'u2'], 100, options).duplicated).toBe(false)
    expect(getBalance('u1')).toBe(120)
  })

  it('主文件已提交但备份失败时仍同步内存，不重复发放', () => {
    initCredits(freshDir())
    const write = durable.writeDurableJson
    const spy = vi.spyOn(durable, 'writeDurableJson').mockImplementationOnce((...args) => { write(...args); throw new Error('模拟备份失败') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(grantAllCredits(['u1'], 100, options).ok).toBe(true)
      expect(getBalance('u1')).toBe(100)
      expect(grantAllCredits(['u1'], 100, options).duplicated).toBe(true)
    } finally { spy.mockRestore(); warn.mockRestore() }
  })

  it('增加而非覆盖所有账号余额，写入说明、收入和流水', () => {
    const dir = freshDir()
    initCredits(dir)
    addCredits('old', 20)
    const result = grantAllCredits(['old', 'new'], 100, options)
    expect(result).toMatchObject({ ok: true, count: 2, total: 200, duplicated: false })
    expect(getBalance('old')).toBe(120)
    expect(getBalance('new')).toBe(100)
    expect(getAccount('old').totalIn).toBe(120)
    expect(listLedger('old')[0]).toMatchObject({ type: 'admin', amount: 100, note: '活动赠送：国庆活动赠送', ref: options.requestId })
    expect(JSON.parse(readFileSync(join(dir, 'credits.json'), 'utf-8')).users.old.balance).toBe(120)
  })

  it('并发顺序调用、重启及清空统计后同一收据仍防重复', () => {
    const dir = freshDir()
    initCredits(dir)
    grantAllCredits(['u1', 'u2'], 100, options)
    expect(grantAllCredits(['u2', 'u1'], 100, options).duplicated).toBe(true)
    resetCreditStats()
    initCredits(dir)
    expect(grantAllCredits(['u1', 'u2'], 100, { ...options, validateRoster: ['u1', 'u2', 'later'] }).duplicated).toBe(true)
    expect(getBalance('u1')).toBe(100)
  })

  it.each([0, -1, 1.5, '100', Infinity, 100000001])('拒绝非法金额 %s 且不写账', (amount) => {
    initCredits(freshDir())
    expect(() => grantAllCredits(['u1'], amount, options)).toThrow()
    expect(getBalance('u1')).toBe(0)
    expect(listLedger('u1')).toEqual([])
  })

  it('余额超限整批拒绝，没有先给前面的账号加分', () => {
    initCredits(freshDir())
    setBalance('z', 100000000)
    expect(() => grantAllCredits(['a', 'z'], 100, options)).toThrow('上限')
    expect(getBalance('a')).toBe(0)
    expect(getBalance('z')).toBe(100000000)
  })

  it('收据不能更改金额、说明或领取人', () => {
    initCredits(freshDir())
    grantAllCredits(['u1'], 100, options)
    expect(() => grantAllCredits(['u1'], 200, options)).toThrow('编号')
    expect(() => grantAllCredits(['u2'], 100, options)).toThrow('编号')
    expect(() => grantAllCredits(['u1'], 100, { ...options, note: '其他活动' })).toThrow('编号')
    expect(getBalance('u1')).toBe(100)
    expect(getBalance('u2')).toBe(0)
  })

  it('名单变化、重复账号、空列表、无说明均不发放', () => {
    initCredits(freshDir())
    expect(() => grantAllCredits(['u1'], 100, { ...options, validateRoster: ['u1', 'u2'] })).toThrow('名单已变化')
    expect(() => grantAllCredits(['u1', 'u1'], 100, options)).toThrow('列表')
    expect(() => grantAllCredits([], 100, options)).toThrow('列表')
    expect(() => grantAllCredits(['u1'], 100, { ...options, note: '' })).toThrow('说明')
    expect(getBalance('u1')).toBe(0)
  })

  it('超过 800 人的活动每人仍有记录，重启后也保留', () => {
    const dir = freshDir()
    initCredits(dir)
    const ids = Array.from({ length: 810 }, (_, idx) => `u${idx}`)
    grantAllCredits(ids, 100, options)
    initCredits(dir)
    expect(ids.every((id) => getBalance(id) === 100 && listLedger(id)[0]?.amount === 100)).toBe(true)
  })

  it('损坏的活动收据不能静默清空后再次发放', () => {
    const dir = freshDir()
    initCredits(dir)
    grantAllCredits(['u1'], 100, options)
    const file = join(dir, 'credits.json')
    const saved = JSON.parse(readFileSync(file, 'utf-8'))
    saved.grants[options.requestId] = {}
    writeFileSync(file, JSON.stringify(saved))
    expect(() => initCredits(dir)).toThrow('发放记录损坏')
  })
})

describe('spendCredits', () => {
  it('正常扣费并同步写盘，不需要 flush', () => {
    const dir = freshDir()
    initCredits(dir)
    addCredits('u-1', 100, { type: 'redeem' })

    const result = spendCredits('u-1', 3, { images: 3, ref: 'task-1' })
    expect(result).toEqual({ ok: true, balance: 97, charged: 3 })

    // 关键：没有防抖，文件里立刻就是 97。进程被 kill 也不会丢这笔。
    const onDisk = JSON.parse(readFileSync(join(dir, 'credits.json'), 'utf-8'))
    expect(onDisk.users['u-1'].balance).toBe(97)
  })

  it('余额不足时拒绝且不留任何痕迹——流水、余额、累计支出都不动', () => {
    initCredits(freshDir())
    addCredits('u-1', 2)

    const result = spendCredits('u-1', 4)
    expect(result.ok).toBe(false)
    expect(result.balance).toBe(2)
    expect(getBalance('u-1')).toBe(2)
    expect(getAccount('u-1').totalOut).toBe(0)
    expect(listLedger('u-1')).toHaveLength(1)
  })

  it('正好扣完是允许的，扣到 0 不算失败', () => {
    initCredits(freshDir())
    addCredits('u-1', 4)
    expect(spendCredits('u-1', 4)).toEqual({ ok: true, balance: 0, charged: 4 })
  })

  it('金额为 0 或负数时视为没扣，不会把余额变成负数', () => {
    initCredits(freshDir())
    addCredits('u-1', 10)
    expect(spendCredits('u-1', 0).charged).toBe(0)
    expect(spendCredits('u-1', -5).charged).toBe(0)
    expect(getBalance('u-1')).toBe(10)
  })

  it('没有 userId 时直接放行（open / passcode 模式下本就没有账号）', () => {
    initCredits(freshDir())
    expect(spendCredits('', 5)).toEqual({ ok: true, balance: 0, charged: 0 })
  })
})

describe('refundCredits', () => {
  it('退回只增加余额，不计入充值——否则失败重试会把充值曲线撑成假的增长', () => {
    initCredits(freshDir())
    addCredits('u-1', 10, { type: 'redeem' })
    spendCredits('u-1', 4, { images: 4 })
    refundCredits('u-1', 4, { ref: 'task-1' })

    expect(getBalance('u-1')).toBe(10)
    const day = creditsSummary().days[0]
    expect(day.recharge).toBe(10)
    expect(day.refund).toBe(4)
    expect(day.spend).toBe(4)
  })
})

describe('recordLuckyFree', () => {
  it('记录 0 积分免单流水，不改余额但计入出图张数', () => {
    initCredits(freshDir())
    addCredits('u-1', 10, { type: 'redeem' })

    expect(recordLuckyFree('u-1', { images: 2, ref: 'ch-1', note: '幸运免单 · 出图 2 张' })).toEqual({ ok: true, balance: 10 })
    expect(getBalance('u-1')).toBe(10)
    expect(listLedger('u-1')[0]).toMatchObject({ type: 'lucky', amount: 0, balanceAfter: 10, ref: 'ch-1' })
    expect(creditsOverview().todayImages).toBe(2)
  })
})

describe('流水与维度的对账', () => {
  it('totalIn / totalOut / 按天聚合三处永远对得上', () => {
    initCredits(freshDir())
    addCredits('u-1', 100, { type: 'redeem' })
    spendCredits('u-1', 30, { images: 30 })
    refundCredits('u-1', 10)
    setBalance('u-1', 85)

    const account = getAccount('u-1')
    // 100 进 + 10 退 + 5 管理员上调 = 115；出 30。
    expect(account.totalIn).toBe(115)
    expect(account.totalOut).toBe(30)
    expect(account.balance).toBe(85)

    const day = creditsSummary().days[0]
    expect(day.spend).toBe(30)
    expect(day.images).toBe(30)
    expect(day.refund).toBe(10)
    expect(day.recharge).toBe(105)
  })

  // 这条要真写 900 次盘才能越过 800 条的上限，单跑约 1.3s，
  // 但整个套件并行跑满时会被磁盘和 CPU 挤到 5s 默认超时之外，所以单独放宽。
  it('流水只留最近若干条，文件不会无限膨胀', () => {
    const dir = freshDir()
    initCredits(dir)
    addCredits('u-1', 5000)
    for (let i = 0; i < 900; i += 1) spendCredits('u-1', 1)

    const raw = JSON.parse(readFileSync(join(dir, 'credits.json'), 'utf-8'))
    expect(raw.ledger).toHaveLength(800)
    expect(getBalance('u-1')).toBe(4100)
  }, 30000)

  it('每个用户只看得到自己的流水', () => {
    initCredits(freshDir())
    addCredits('u-1', 10)
    addCredits('u-2', 20)

    const view = userCreditsView('u-1')
    expect(view.balance).toBe(10)
    expect(view.ledger).toHaveLength(1)
    expect(view.ledger.every((entry) => entry.userId === 'u-1')).toBe(true)
  })

  it('前台查自己的流水时不会把自己标成「已删除的用户」', () => {
    initCredits(freshDir())
    addCredits('u-1', 10)

    // 前台这条路不给 userNames，"不解析名字"被误当成"用户不存在"，
    // 用户就会在自己的账单里看到一串「（已删除的用户）」。
    const view = userCreditsView('u-1')
    expect(view.ledger[0].userName).toBe('')
    expect(view.ledger[0].exists).toBe(true)

    // 后台带了名字映射时，名字和"是否存在"都要照实给出。
    const admin = listLedger('u-1', 50, new Map([['u-1', '阿狸']]))
    expect(admin[0].userName).toBe('阿狸')
    expect(admin[0].exists).toBe(true)

    const deleted = listLedger('u-1', 50, new Map())
    expect(deleted[0].userName).toBe('（已删除的用户）')
    expect(deleted[0].exists).toBe(false)
  })
})

describe('注册赠送', () => {
  it('只在首次建号时送一次，重复登录不会反复领', () => {
    initCredits(freshDir())
    expect(grantSignupBonus('u-1', 20).ok).toBe(true)
    expect(getBalance('u-1')).toBe(20)

    const again = grantSignupBonus('u-1', 20)
    expect(again.ok).toBe(false)
    expect(again.duplicated).toBe(true)
    expect(getBalance('u-1')).toBe(20)
  })

  it('赠送额为 0 时不该凭空建出一个空账户', () => {
    initCredits(freshDir())
    expect(grantSignupBonus('u-1', 0).ok).toBe(false)
    expect(ensureAccount('u-1').balance).toBe(0)
  })
})

describe('持久化', () => {
  it('重启后余额与流水完整恢复', () => {
    const dir = freshDir()
    initCredits(dir)
    addCredits('u-1', 100, { type: 'redeem', ref: 'GIP-AAAA-BBBB-CCCC' })
    spendCredits('u-1', 7, { images: 7 })

    initCredits(dir)
    expect(getBalance('u-1')).toBe(93)
    expect(listLedger('u-1')).toHaveLength(2)
    expect(listLedger('u-1')[1].ref).toBe('GIP-AAAA-BBBB-CCCC')
  })

  it('账本文件损坏时自动恢复最近备份，不清零用户资产', () => {
    const dir = freshDir()
    initCredits(dir)
    addCredits('u-1', 100)
    writeFileSync(join(dir, 'credits.json'), '{ 这不是合法 JSON', 'utf-8')

    initCredits(dir)
    expect(existsSync(join(dir, 'credits.json.corrupt'))).toBe(true)
    expect(getBalance('u-1')).toBe(100)
  })

  it('清洗非法数值：负数、小数、字符串都收敛成合法积分', () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'credits.json'), JSON.stringify({
      version: 1,
      users: { 'u-1': { balance: -50, totalIn: '80', totalOut: 3.9 } },
    }), 'utf-8')

    initCredits(dir)
    expect(getAccount('u-1')).toMatchObject({ balance: 0, totalIn: 80, totalOut: 3 })
  })
})

describe('后台视图', () => {
  it('已删除用户的空壳不再占一行，但余额不为零的仍保留', () => {
    initCredits(freshDir())
    addCredits('u-gone', 30)
    addCredits('u-left', 10)
    spendCredits('u-left', 10)

    const summary = creditsSummary(new Map([['u-left', '留下的']]))
    expect(summary.users.map((item) => item.id)).toEqual(['u-gone', 'u-left'])
    expect(summary.users[0].name).toBe('（已删除的用户）')
    expect(summary.totals).toMatchObject({ balance: 30, totalIn: 40, totalOut: 10, paused: 1 })
  })

  it('清空统计不动余额', () => {
    initCredits(freshDir())
    addCredits('u-1', 100)
    spendCredits('u-1', 40)

    resetCreditStats()
    expect(getBalance('u-1')).toBe(60)
    expect(creditsSummary().ledger).toEqual([])
    expect(creditsSummary().days).toEqual([])
  })

  it('概览给出今日消耗、充值、出图张数与有余额人数', () => {
    initCredits(freshDir())
    addCredits('u-1', 100, { type: 'redeem' })
    spendCredits('u-1', 6, { images: 6 })
    addCredits('u-2', 50, { type: 'redeem' })

    expect(creditsOverview()).toMatchObject({
      todaySpend: 6,
      todayRecharge: 150,
      todayImages: 6,
      todayRedeemCount: 2,
      balances: 144,
      holders: 2,
      accounts: 2,
    })
  })

  it('删除用户时连账户一起清掉', () => {
    initCredits(freshDir())
    addCredits('u-1', 100)
    expect(removeAccount('u-1')).toBe(true)
    expect(getBalance('u-1')).toBe(0)
    expect(creditsSummary().users).toEqual([])
  })
})
