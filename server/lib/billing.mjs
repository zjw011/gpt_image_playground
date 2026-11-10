// 出图计费：完整校验提交张数，最终按成功图片数结算。
import { imageCountFromFields, parseRelayFields } from './relayContract.mjs'

function normalizeCount(value) {
  return Math.min(16, Math.max(1, Math.trunc(Number(value) || 1)))
}

export function parseImageCount(body, contentType = '') {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || '')
  return imageCountFromFields(parseRelayFields(buffer, contentType).fields)
}

/** 中继传进来的是 `images/generations` 这种相对路径，所以首斜杠可有可无。 */
const AGENT_PATH = /(^|\/)responses$/
const IMAGE_PATH = /(^|\/)images\/(generations|edits)(?:\/async)?$/

/** 这个请求该不该计费。轮询、查任务状态这些 GET 永远不计。 */
export function isBillableRequest(method, channel, endpointPath) {
  if (String(method ?? '').toUpperCase() !== 'POST') return false
  // fal 没有固定的路径约定，POST 到 fal.run 端点就是一次出图。
  if (channel?.provider === 'fal') return true

  const path = String(endpointPath ?? '').split('?')[0].replace(/\/+$/, '')
  // Responses 只在 Agent 模式被用到，一次调用算一张——用户看不到内部有几轮工具调用，
  // 按次计费对他是可预期的。
  return AGENT_PATH.test(path) || IMAGE_PATH.test(path)
}

/** Agent 模式走 SSE，请求体里没有张数字段，固定按 1 张算。 */
export function isAgentEndpoint(endpointPath) {
  return AGENT_PATH.test(String(endpointPath ?? '').split('?')[0].replace(/\/+$/, ''))
}

/**
 * 单个渠道的每张单价。
 *
 * 支持按渠道设倍率（`channelRates` 存的是百分比，100 表示原价）：
 * 不同上游成本可能差好几倍，统一标价会亏在贵的那条上。
 * 取整向上，并且至少 1 分——0 分的单价等于免费，多半是配置写错了。
 */
export function unitCost(site, channelId) {
  const credits = site?.credits
  if (!credits?.enabled) return 0

  const base = Number(credits.costPerImage)
  if (!Number.isFinite(base) || base <= 0) return 0

  const rawRate = credits.channelRates?.[channelId]
  const rate = Number.isFinite(Number(rawRate)) && Number(rawRate) > 0 ? Number(rawRate) : 100
  return Math.max(1, Math.ceil((base * rate) / 100))
}

/** 本次请求实际该扣多少（已知最终落在哪个渠道）。 */
export function actualCost(site, channelId, count) {
  return count === 0 ? 0 : unitCost(site, channelId) * normalizeCount(count)
}

/**
 * 预扣多少。
 *
 * 按**候选渠道里最贵的那个**预扣：故障转移是后台自动做的，用户看不到也控制不了，
 * 所以不能出现"先按便宜渠道预扣、切到贵渠道后余额不够"的情况。
 * 真落在便宜渠道上时，差额会在结算阶段退回去。
 */
export function estimateCost(site, channelIds, count) {
  const ids = Array.isArray(channelIds) ? channelIds : [channelIds]
  return Math.max(0, ...ids.map((id) => unitCost(site, id))) * normalizeCount(count)
}

/** 积分是否已经低到不该再开工。用于前端提前给出提示，不参与服务端拦截。 */
export function isLowBalance(site, balance) {
  if (!site?.credits?.enabled) return false
  const cheapest = Number(site.credits.costPerImage)
  if (!Number.isFinite(cheapest) || cheapest <= 0) return false
  return balance < cheapest
}
