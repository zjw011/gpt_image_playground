// 异步任务的持久化结算收据：关页/重启不能丢预留，也不能凭重复轮询扣第二次。
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hasCreditOperation, recordLuckyFree, releaseReservation, reserveCredits, settleCredits } from './credits.mjs'
import { readDurableJson, writeDurableJson } from './durableJson.mjs'
import { HttpError } from './http.mjs'
import { readGenerationResult } from './generationResult.mjs'
import { maybeRewardInviter } from './referral.mjs'
import { buildUpstreamUrl } from './upstream.mjs'

let file = ''
let orders = []
let timer = null
let running = false

function validOrders(value) {
  return Array.isArray(value) && value.every((item) => item && typeof item.id === 'string' && typeof item.userId === 'string'
    && typeof item.taskId === 'string' && typeof item.channelId === 'string' && ['pending', 'settled', 'failed', 'unresolved'].includes(item.state)
    && Number.isSafeInteger(item.reserved) && item.reserved >= 0 && Number.isSafeInteger(item.count) && item.count >= 1 && item.count <= 16
    && Number.isFinite(item.createdAt) && Number.isSafeInteger(item.unitCost) && item.unitCost >= 0
    && typeof item.url === 'string' && typeof item.auth === 'string' && typeof item.provider === 'string'
    && (item.finalCount == null || Number.isInteger(item.finalCount) && item.finalCount >= 0 && item.finalCount <= item.count)
    && typeof item.lucky === 'boolean' && (item.poll === null || item.poll && typeof item.poll === 'object'
      && typeof item.poll.path === 'string' && typeof item.poll.statusPath === 'string'
      && Array.isArray(item.poll.successValues) && Array.isArray(item.poll.failureValues)
      && (!item.poll.method || ['GET', 'POST'].includes(item.poll.method))
      && (!item.poll.query || Object.values(item.poll.query).every((entry) => typeof entry === 'string'))))
}

function commit(next) {
  if (file) writeDurableJson(file, next, true)
  orders = next
}

export function initGenerationOrders(dataDir, options = {}) {
  if (timer) clearInterval(timer)
  file = join(dataDir, 'generation-orders.json')
  orders = existsSync(file) || existsSync(`${file}.bak`) ? readDurableJson(file, '异步生成结算记录', validOrders).value : []
  for (const order of orders.filter((item) => item.state === 'pending')) {
    if (hasCreditOperation(`generation:${order.id}`)) {
      order.state = 'settled'
      try { maybeRewardInviter(order.userId) } catch (err) { order.referralPending = true; console.warn('推荐奖励等待后台补偿', err) }
      continue
    }
    if (order.reserved) reserveCredits(order.userId, order.reserved, { restore: true })
  }
  if (options.startWorker !== false) {
    timer = setInterval(() => { pollGenerationOrders().catch((err) => console.error('异步任务结算失败', err)) }, 3_000)
    timer.unref?.()
  }
}

export function assertGenerationCapacity(userId) {
  const pending = orders.filter((order) => order.state === 'pending')
  if (pending.length >= 256 || pending.filter((order) => order.userId === userId).length >= 8) throw new HttpError(429, '尚有生成任务等待上游确认，请完成后再提交')
}

export function createGenerationOrder(input) {
  if (!input.taskId || input.taskId.length > 2048) throw new HttpError(502, '上游任务编号无效')
  const existing = orders.find((item) => item.channelId === input.channel.id && item.taskId === input.taskId)
  if (existing) {
    if (existing.userId !== input.userId) throw new HttpError(409, '上游返回了重复的任务编号')
    releaseReservation(input.userId, input.reserved)
    return existing
  }
  const poll = input.contract.definition?.poll
  let url = ''
  if (input.channel.provider === 'fal') {
    const submitted = new URL(input.upstreamUrl)
    const model = input.channel.model.replace(/^\/+|\/+$/g, '').split('/').slice(0, 2).join('/')
    url = new URL(`/${model}/requests/${encodeURIComponent(input.taskId)}`, submitted.origin).href
  } else if (poll) {
    url = buildUpstreamUrl(input.channel.baseUrl, poll.path.replace(/\{task_id\}|\{taskId\}/g, encodeURIComponent(input.taskId)), '').href
    const target = new URL(url)
    for (const [key, value] of Object.entries(poll.query || {})) target.searchParams.set(key, ['$task_id', '$taskId'].includes(value) ? input.taskId : value.replace(/\{task_id\}|\{taskId\}/g, input.taskId))
    url = target.href
  }
  const order = {
    id: randomUUID(), userId: input.userId, channelId: input.channel.id, taskId: input.taskId,
    createdAt: Date.now(), state: 'pending', reserved: input.reserved, count: input.count,
    unitCost: input.unitCost, lucky: input.lucky, provider: input.channel.provider,
    // 只保存这个订单需要的固定查询目标和鉴权，后续修改渠道不会查到另一家。
    url, auth: `${input.channel.provider === 'fal' ? 'Key' : 'Bearer'} ${input.channel.apiKey}`,
    poll: poll || null,
    ...(input.finalCount != null ? { finalCount: input.finalCount, url: '', poll: null } : {}),
  }
  if (!order.url && order.finalCount == null) {
    // 同步接口意外返回 ID 时没有合法查询协议，记录待人工核对，不能永久占用用户余额。
    order.state = 'unresolved'
    order.reserved = 0
  }
  commit([...orders.filter((item) => item.state === 'pending' || item.createdAt > Date.now() - 90 * 24 * 60 * 60 * 1000), order])
  if (order.state === 'unresolved') releaseReservation(input.userId, input.reserved)
  return order
}

export function assertGenerationOrder(userId, channelId, taskId) {
  const order = orders.find((item) => item.channelId === channelId && item.taskId === taskId && item.userId === userId)
  if (!order) throw new HttpError(403, '无权查询此生成任务或任务记录不存在')
  return order
}

/** 旧订单查询按提交时的契约鉴权；管理员停用/换模型只阻止新生成。 */
export function findGenerationPoll(req, userId, channelId, endpointPath) {
  for (const order of orders) {
    if (order.userId !== userId || order.channelId !== channelId || !order.url) continue
    if (order.provider === 'fal') {
      let path
      try { path = new URL(String(req.headers['x-fal-target-url'] || '')).pathname } catch { continue }
      const expected = new URL(order.url).pathname
      if (req.method === 'GET' && [expected, `${expected}/status`].includes(path)
        || ['PUT', 'POST'].includes(req.method) && path === `${expected}/cancel`) return order
    } else if (order.poll) {
      const expected = order.poll.path.replace(/^\/+/, '').replace(/^v1\//, '').replace(/\{task_id\}|\{taskId\}/g, encodeURIComponent(order.taskId)).replace(/\/+$/, '')
      if (req.method === (order.poll.method || 'GET') && endpointPath.replace(/\/+$/, '') === expected) return order
    }
  }
  return null
}

export function settleGenerationOrder(order, payload, confirmedCount) {
  const current = orders.find((item) => item.id === order.id)
  if (!current || current.state !== 'pending') return
  const result = confirmedCount == null ? readGenerationResult(payload, { poll: current.poll, result: current.poll?.result }, current.provider)
    : { images: Array.from({ length: confirmedCount }, () => 'confirmed'), terminal: true, error: '' }
  // Fal 的 status 接口先报告 COMPLETED，图片仍需从 result 接口取得。
  if (current.provider === 'fal' && !result.images.length && !result.error && /completed/i.test(String(payload?.status || ''))) return
  if (!result.terminal) return
  const count = Math.min(current.count, result.images.length)
  const operationId = `generation:${current.id}`
  if (count > 0 && current.userId) {
    if (current.lucky) recordLuckyFree(current.userId, { images: count, ref: current.channelId, operationId, note: `幸运免单 · 出图 ${count} 张` })
    else if (current.unitCost > 0) {
      const settled = settleCredits(current.userId, current.unitCost * count, { images: count, reserved: current.reserved, ref: current.channelId, operationId, note: `出图 ${count} 张` })
      if (!settled.ok) throw new Error('生成任务结算失败，保留订单等待重试')
    }
  }
  let referralPending = false
  if (count && current.userId) {
    try { maybeRewardInviter(current.userId) } catch (err) { referralPending = true; console.warn('推荐奖励暂未完成，等待后台补偿', err) }
  }
  commit(orders.map((item) => item.id === current.id ? { ...item, state: count ? 'settled' : 'failed', completedAt: Date.now(), images: count, referralPending } : item))
  if (!count || current.unitCost === 0) releaseReservation(current.userId, current.reserved)
}

export async function pollGenerationOrders() {
  if (running) return
  running = true
  try {
    // 逐单、有界并发；失败保留原订单和预留，不能把未知结果当成失败退款。
    for (const order of orders.filter((item) => item.referralPending).slice(0, 4)) {
      try {
        maybeRewardInviter(order.userId)
        commit(orders.map((item) => item.id === order.id ? { ...item, referralPending: false } : item))
      } catch (err) { console.warn('推荐奖励仍待补偿', err) }
    }
    const pending = orders.filter((order) => order.state === 'pending' && (order.url || order.finalCount != null) && (!order.nextPollAt || order.nextPollAt <= Date.now())).slice(0, 4)
    await Promise.allSettled(pending.map(async (order) => {
      order.nextPollAt = Date.now() + 15_000
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      try {
        if (order.finalCount != null) { settleGenerationOrder(order, null, order.finalCount); return }
        const response = await fetch(order.url, { method: order.poll?.method || 'GET', headers: { authorization: order.auth }, signal: controller.signal, redirect: 'error' })
        if (!response.ok) { await response.body?.cancel(); return }
        let size = 0
        const chunks = []
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > 128 * 1024 * 1024) throw new Error('异步结果过大')
          chunks.push(Buffer.from(chunk))
        }
        settleGenerationOrder(order, JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch (err) {
        console.warn(`异步任务 ${order.id} 查询未完成：${err instanceof Error ? err.message : '请求失败'}`)
      } finally { clearTimeout(timeout) }
    }))
  } finally { running = false }
}

export function generationOrdersForTests() {
  return orders.map((order) => ({ ...order, auth: undefined }))
}
