import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { addCredits, getBalance, getReserved, initCredits, reserveCredits, resetReservations } from './credits.mjs'
import { assertGenerationOrder, createGenerationOrder, generationOrdersForTests, initGenerationOrders, pollGenerationOrders, settleGenerationOrder } from './generationOrders.mjs'
import { initStore } from './store.mjs'
import { SUB2API_DEFINITION } from './relayContract.mjs'

let dir
function order(taskId = 'task-1') {
  reserveCredits('user', 6)
  return createGenerationOrder({ userId: 'user', taskId, reserved: 6, count: 3, unitCost: 2, lucky: false, channel: { id: 'ch', provider: 'sb2api-async', baseUrl: 'https://api.example.test/v1', apiKey: 'test-key' }, contract: { definition: SUB2API_DEFINITION }, upstreamUrl: 'https://api.example.test/v1/images/generations/async' })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gip-orders-'))
  initStore(dir)
  initCredits(dir)
  resetReservations()
  initGenerationOrders(dir, { startWorker: false })
  addCredits('user', 20)
})

describe('异步订单最终结算', () => {
  it('重启恢复预留，部分成功只收实际张数，重复查询与再次重启均不重复扣款', () => {
    const item = order()
    expect(getBalance('user')).toBe(20)
    expect(getReserved('user')).toBe(6)
    resetReservations()
    initCredits(dir)
    initGenerationOrders(dir, { startWorker: false })
    expect(getReserved('user')).toBe(6)
    const result = { status: 'completed', result: { data: [{ b64_json: 'AAAA' }] } }
    settleGenerationOrder(item, result)
    settleGenerationOrder(item, result)
    expect(getBalance('user')).toBe(18)
    expect(getReserved('user')).toBe(0)
    resetReservations()
    initCredits(dir)
    initGenerationOrders(dir, { startWorker: false })
    expect(getBalance('user')).toBe(18)
    expect(getReserved('user')).toBe(0)
  })

  it.each(['failed', 'cancelled'])('%s 终态释放预留，不动其他任务占位', (status) => {
    const item = order()
    order('task-2')
    settleGenerationOrder(item, { status, error: { message: 'content_policy_violation' } })
    settleGenerationOrder(item, { status })
    expect(getBalance('user')).toBe(20)
    expect(getReserved('user')).toBe(6)
  })

  it('其他用户无权查询相同渠道任务', () => {
    order()
    expect(() => assertGenerationOrder('attacker', 'ch', 'task-1')).toThrow('无权查询')
    expect(assertGenerationOrder('user', 'ch', 'task-1').userId).toBe('user')
  })

  it('扣费后写订单前中断，重启凭账本 operationId 消除重复扣费和占位', () => {
    const item = order()
    const saved = readFileSync(join(dir, 'generation-orders.json'))
    settleGenerationOrder(item, { status: 'completed', result: { data: [{ b64_json: 'AAAA' }] } })
    writeFileSync(join(dir, 'generation-orders.json'), saved)
    resetReservations()
    initCredits(dir)
    initGenerationOrders(dir, { startWorker: false })
    expect(getBalance('user')).toBe(18)
    expect(getReserved('user')).toBe(0)
    expect(generationOrdersForTests()[0].state).toBe('settled')
  })

  it('Fal 完成状态先保留预留，拿到结果才结算', () => {
    reserveCredits('user', 2)
    const item = createGenerationOrder({ userId: 'user', taskId: 'fal-task', reserved: 2, count: 1, unitCost: 2, lucky: false, channel: { id: 'fal', provider: 'fal', model: 'openai/gpt-image-2', apiKey: 'key' }, contract: {}, upstreamUrl: 'https://queue.fal.run/openai/gpt-image-2' })
    settleGenerationOrder(item, { status: 'COMPLETED' })
    expect(getReserved('user')).toBe(2)
    expect(getBalance('user')).toBe(20)
    settleGenerationOrder(item, { images: [{ url: 'https://example.test/image.png' }] })
    expect(getReserved('user')).toBe(0)
    expect(getBalance('user')).toBe(18)
  })

  it('未知同步任务 ID 留待核对，不永久冻结余额或再扣费', () => {
    reserveCredits('user', 2)
    const item = createGenerationOrder({ userId: 'user', taskId: 'unexpected', reserved: 2, count: 1, unitCost: 2, lucky: false, channel: { id: 'openai', provider: 'openai', apiKey: 'key' }, contract: {}, upstreamUrl: 'https://example.test/v1/images/generations' })
    expect(item.state).toBe('unresolved')
    expect(getReserved('user')).toBe(0)
    expect(getBalance('user')).toBe(20)
  })

  it('同步成品收据已落盘但尚未扣费，重启后台恢复实际数量结算', async () => {
    reserveCredits('user', 6)
    createGenerationOrder({ userId: 'user', taskId: 'sync-confirmed', reserved: 6, count: 3, finalCount: 1, unitCost: 2, lucky: false, channel: { id: 'ch', provider: 'openai', apiKey: 'key' }, contract: {}, upstreamUrl: 'https://example.test/v1/images/generations' })
    resetReservations()
    initCredits(dir)
    initGenerationOrders(dir, { startWorker: false })
    await pollGenerationOrders()
    await pollGenerationOrders()
    expect(getBalance('user')).toBe(18)
    expect(getReserved('user')).toBe(0)
  })
})
