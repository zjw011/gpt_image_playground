// 出图计费：判断这次请求要不要扣积分、要出几张、该扣多少。
//
// 核心难题是"这次请求到底会出几张图"。前端把张数放在请求体里（OpenAI 兼容接口的 `n`、
// fal 的 `num_images`），而中继层是流式透传、不解析请求体的——要计费就得看一眼。
//
// 做法是**只看首块**（前 64KB），够读出这几个字段。三种请求体形态都覆盖：
//   - application/json        直接 JSON.parse，截断了就退回正则
//   - multipart/form-data     扫 `name="n"` 后面的值
//   - 都不是                   两条路都试一遍
//
// 前端保证把张数字段放在表单的**第一个**，所以它一定落在首块里。取不到时按 1 张算——
// 宁可少扣也不多扣，用户不该为解析器的失误买单。

/** 解析器最多看这么多字节。够装下 JSON 请求体，也够装下 multipart 的第一个字段。 */
export const BILLING_PEEK_BYTES = 64 * 1024

/**
 * 单次请求的张数上限。
 * 前端一次最多出 4 张，这里留到 16 是为了不误伤用 API 直连的用户；
 * 同时它也是个保险丝——畸形请求体里出现 `"n":999999` 时不会把余额直接扣穿。
 */
const MAX_IMAGES_PER_REQUEST = 16

const COUNT_FIELDS = ['n', 'num_images', 'batch_size']

function normalizeCount(value) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return 1
  return Math.min(MAX_IMAGES_PER_REQUEST, Math.max(1, Math.trunc(numeric)))
}

function readCountField(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  for (const field of COUNT_FIELDS) {
    const value = payload[field]
    if (value == null) continue
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
  }
  return null
}

function parseJsonCount(text) {
  const found = []
  // 完整 JSON 直接解析最可靠。
  try {
    const parsed = JSON.parse(text)
    const value = readCountField(parsed)
    if (value != null) found.push(value)
  } catch {
    // 请求体被截断（首块装不下整个 JSON）或根本不是 JSON，退回正则。
  }
  for (const field of COUNT_FIELDS) {
    const match = new RegExp(`"${field}"\\s*:\\s*(\\d{1,6})`).exec(text)
    if (match) found.push(Number(match[1]))
  }
  return found
}

function parseMultipartCount(text) {
  const found = []
  // 形态：Content-Disposition: form-data; name="n"\r\n\r\n4\r\n--
  // 非贪婪地跳过 disposition 行的剩余部分和那个空行，再取数字。
  const pattern = /name="(?:n|num_images|batch_size)"[^\r\n]*\r?\n(?:\r?\n)?[ \t]*(\d{1,6})/g
  let match = pattern.exec(text)
  while (match) {
    found.push(Number(match[1]))
    match = pattern.exec(text)
  }
  return found
}

const EMPTY_BUFFER = Buffer.alloc(0)

/**
 * 从请求体首块里解析本次要出几张图。
 *
 * 多个候选值同时出现时取**最大值**：客户端理论上能在表单里塞两个 `n`，
 * 而上游会读后面那个，取最大值才不会被他用小值蒙混过去。
 */
export function parseImageCount(head, contentType = '') {
  const buffer = Buffer.isBuffer(head) ? head : Buffer.from(head ?? EMPTY_BUFFER)
  if (!buffer.length) return 1

  const text = buffer.toString('utf-8')
  const type = String(contentType).toLowerCase()
  const candidates = type.includes('application/json')
    ? parseJsonCount(text)
    : type.includes('multipart/form-data')
      ? parseMultipartCount(text)
      // 有些网关用 text/plain 或干脆不给 Content-Type，两条路都试一遍。
      : [...parseJsonCount(text), ...parseMultipartCount(text)]

  if (!candidates.length) return 1
  return normalizeCount(Math.max(...candidates))
}

/** 中继传进来的是 `images/generations` 这种相对路径，所以首斜杠可有可无。 */
const AGENT_PATH = /(^|\/)responses$/
const IMAGE_PATH = /(^|\/)images\/(generations|edits)$/

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
  return unitCost(site, channelId) * normalizeCount(count)
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
