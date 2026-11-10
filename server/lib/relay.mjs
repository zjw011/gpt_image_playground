// 中继编排：选渠道、扣积分、静默故障转移。
//
// 这条链路是整个后端最"重"的一段，因为它同时要满足四个互相拉扯的要求：
//
//   1. 用户无感。一条渠道失败就自动换下一条重试，前端的报错弹窗和"正在切换到 X"提示
//      都不该出现——用户只应该看到图，或者一个最终失败。
//   2. 成功才扣积分。失败的尝试一分不扣，用户不该为渠道的故障买单。
//   3. 不透支。余额只剩 1 分时并发发 10 个请求，不能全部放行。
//   4. 保持流式。参考图上传可能是几百 MB，出图响应可能是 SSE，都不能整包读进内存。
//
// 前三条靠「内存预留 + 成功后结算」解决，第 4 条靠「按需缓冲」解决：
// 请求体在 32MB 以内就整个读进内存（这样才能重放给下一条渠道），
// 超过就退回单渠道流式转发——大请求没有故障转移，但也不至于把服务打爆。

import {
  BILLING_PEEK_BYTES,
  actualCost,
  estimateCost,
  isBillableRequest,
  parseImageCount,
} from './billing.mjs'
import { getBalance, recordLuckyFree, releaseReservation, reserveCredits, settleCredits } from './credits.mjs'
import { maybeRewardInviter } from './referral.mjs'
import { getClientIp, HttpError } from './http.mjs'
import { generationGate } from './generationGate.mjs'
import { findChannel, getConfig } from './store.mjs'
import { attemptUpstream, buildUpstreamUrl, forwardableHeaders } from './upstream.mjs'
import { isChannelFault, recordChannelCall } from './usage.mjs'
import { classifyGenerationError, formatGenerationError, getGenerationResponseError } from '../../src/lib/generationError.mjs'

const FAL_TARGET_URL_HEADER = 'x-fal-target-url'
const FAL_ALLOWED_HOSTS = /(^|\.)(fal\.run|fal\.ai)$/

/** 超过这个体积就不缓冲了：能重放的请求体一律在内存里，换来静默故障转移。 */
const MAX_BUFFERED_BODY_BYTES = 32 * 1024 * 1024

/** 失败响应只留这么多字节用于排查，多了会把错误信息淹没。 */
const ERROR_SNIPPET_BYTES = 2_048
// 成功响应通常很大（Base64 图片），这里只检查开头；错误网关伪装成 200 的 JSON 一般很小。
const SUCCESS_PEEK_BYTES = 256 * 1024
/** 同步生图可能长时间没有任何响应字节，至少等 5 分钟再判定渠道超时。 */
const MIN_GENERATION_TIMEOUT_MS = 300_000
/** 边缘代理常在 15～60 秒无响应时断开；在它之前开始发送 JSON 空白心跳。 */
const RESPONSE_HEARTBEAT_DELAY_MS = process.env.NODE_ENV === 'test' ? 20 : 5_000
const RESPONSE_HEARTBEAT_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 20 : 10_000
const RESPONSE_HEARTBEAT_CHUNK = `${' '.repeat(4 * 1024)}\n`

export function getUpstreamTimeoutMs(channel, billable) {
  return Math.max(billable ? MIN_GENERATION_TIMEOUT_MS : 10_000, channel.timeout * 1000)
}

/**
 * 同步生图在上游返回响应头之前可能安静几十秒。前置 CDN/Nginx 会把这种连接误判为空闲，
 * 所以新客户端明确请求保活时，先返回 200，再定期写合法的 JSON 前导空白。
 * response.json() 会忽略这些空白，业务响应格式不变；流式 SSE 不走这里。
 */
function createJsonHeartbeat(res, enabled) {
  let started = false
  let interval = null
  const write = () => {
    if (res.destroyed || res.writableEnded) return
    if (!started) {
      started = true
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
        'X-GIP-Heartbeat': '1',
      })
    }
    res.write(RESPONSE_HEARTBEAT_CHUNK)
  }
  const delay = enabled ? setTimeout(() => {
    write()
    interval = setInterval(write, RESPONSE_HEARTBEAT_INTERVAL_MS)
    interval.unref?.()
  }, RESPONSE_HEARTBEAT_DELAY_MS) : null
  delay?.unref?.()

  const stop = () => {
    if (delay) clearTimeout(delay)
    if (interval) clearInterval(interval)
  }
  res.once('close', stop)

  return {
    get started() { return started },
    stop,
    finishError(message) {
      stop()
      if (!started || res.destroyed || res.writableEnded) return false
      res.end(JSON.stringify({ error: { message } }))
      return true
    },
  }
}

/**
 * 旧版前端会把默认尺寸发成 auto，但部分 OpenAI 兼容网关只接受 1024x1024 这类显式值。
 * 兼容逻辑放在服务端再兜一层，避免浏览器缓存旧脚本时把同一个参数错误扩散到所有备用渠道。
 */
function normalizeImageRequestBody(body, contentType, channel, endpointPath) {
  if (!body || !['openai', 'sb2api-async'].includes(channel.provider)) return body
  if (!String(contentType ?? '').toLowerCase().includes('application/json')) return body

  try {
    const payload = JSON.parse(body.toString('utf-8'))
    let changed = false

    if (/^images\/(?:generations|edits)$/.test(endpointPath) && payload.size === 'auto' && payload.output_format !== 'gif') {
      payload.size = '1024x1024'
      changed = true
    }

    if (endpointPath === 'responses' && Array.isArray(payload.tools)) {
      payload.tools = payload.tools.map((tool) => {
        if (tool?.type !== 'image_generation' || tool.size !== 'auto') return tool
        changed = true
        return { ...tool, size: '1024x1024' }
      })
    }

    return changed ? Buffer.from(JSON.stringify(payload)) : body
  } catch {
    // 非法 JSON 交给上游返回原本的参数错误，中继不擅自改写。
    return body
  }
}

/** 已完成图片和已受理任务不能因同一响应里的错误再次提交。 */
function inspectImagePayload(payload, provider) {
  if (!payload || typeof payload !== 'object') return { image: false, error: null }
  const { data, output, response, item } = payload
  if (response && typeof response === 'object') return inspectImagePayload(response, provider)

  const entries = provider === 'fal'
    ? Array.isArray(payload.images) ? payload.images : payload.image ? [payload.image] : [payload]
    : Array.isArray(payload) ? payload : Array.isArray(data) ? data : Array.isArray(output) ? output : item ? [item] : [payload]
  const image = entries.some((entry) => {
    if (provider === 'fal' && typeof entry === 'string') return /^(?:https?:|data:image\/)/i.test(entry)
    if (!entry || typeof entry !== 'object' || getGenerationResponseError(entry)) return false
    if (typeof entry.b64_json === 'string' && entry.b64_json.trim()) return true
    if (typeof entry.partial_image_b64 === 'string' && entry.partial_image_b64.trim()) return true
    if (typeof entry.url === 'string' && /^(?:https?:|data:image\/)/i.test(entry.url)) return true
    if (entry.type !== 'image_generation_call') return false
    const result = entry.result
    return typeof result === 'string' ? Boolean(result.trim()) : result && typeof result === 'object'
      && ['b64_json', 'base64', 'image', 'data'].some((key) => typeof result[key] === 'string' && result[key].trim())
  })
  const task = typeof payload.task_id === 'string' && Boolean(payload.task_id.trim())
    || data && !Array.isArray(data) && typeof data.task_id === 'string' && Boolean(data.task_id.trim())
    || provider === 'fal' && typeof payload.request_id === 'string' && Boolean(payload.request_id.trim())
  return { image, task, error: image ? null : getGenerationResponseError(payload) }
}

/**
 * 兼容网关偶尔会用 HTTP 200 包一段错误 JSON。过去这里只看状态码就扣积分，
 * 前端随后解析不到图片，用户看到失败却已经被扣费。先窥视响应开头：小响应直到结束
 * 都没有图片/异步任务字段就判为失败；内容审核或取消由调用处单独处理。
 * SSE 也检查首批完整事件；超过检查窗口或开始传图后继续流式转发。
 */
function inspectSuccessfulPayload(upstreamRes, provider) {
  const contentType = String(upstreamRes.headers['content-type'] ?? '').toLowerCase()
  const streaming = contentType.includes('text/event-stream')
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false

    const cleanup = () => {
      upstreamRes.off('data', onData)
      upstreamRes.off('end', onEnd)
      upstreamRes.off('close', onClose)
      upstreamRes.off('error', onError)
    }
    const finish = (valid, message = '', complete = false, failed = false) => {
      if (done) return
      done = true
      cleanup()
      upstreamRes.pause()
      resolve({ valid, chunks, message, complete, failed })
    }
    const text = () => Buffer.concat(chunks).toString('utf-8')
    const inspectBody = (body, complete = false) => {
      const frames = streaming ? body.split(/\r?\n\r?\n/).slice(0, complete ? undefined : -1) : [body]
      for (const frame of frames) {
        const data = streaming ? frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n') : frame
        if (!data || data === '[DONE]') continue
        try {
          const result = inspectImagePayload(JSON.parse(data), provider)
          // SSE 按事件顺序处理：开始传图之后，后续失败继续交给客户端处理部分结果。
          if (result.error || result.image || result.task) return result
        } catch {
          // 未完成的 JSON 留给后续字节；未知格式保持原来的转发行为。
        }
      }
      return { image: false, error: null }
    }
    const onData = (chunk) => {
      chunks.push(chunk)
      size += chunk.length
      const body = text()
      const result = inspectBody(body)
      if (result.error && !result.task) return finish(false, result.error.slice(0, ERROR_SNIPPET_BYTES))
      if (streaming && result.image) return finish(true)
      if (size >= SUCCESS_PEEK_BYTES) finish(true)
    }
    const onEnd = () => {
      const body = text()
      const result = inspectBody(body, true)
      finish(Boolean(result.image || result.task), result.error || body.trim().slice(0, ERROR_SNIPPET_BYTES), true, Boolean(result.error && !result.image))
    }
    const onError = () => finish(false, '上游成功响应读取失败')
    const onClose = () => finish(false, '上游响应在完成前中断')

    upstreamRes.on('data', onData)
    upstreamRes.on('end', onEnd)
    upstreamRes.on('close', onClose)
    upstreamRes.on('error', onError)
  })
}

export function parseRelayPath(path) {
  const rest = String(path).slice('/api/relay/'.length)
  const slash = rest.indexOf('/')
  return {
    channelId: decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash)),
    endpointPath: slash < 0 ? '' : rest.slice(slash + 1),
  }
}

/**
 * 候选渠道顺序：**用户点的那条排第一**，其余按后台列表顺序补齐。
 * 后台列表顺序本身就是管理员排好的故障转移顺序，这里沿用同一套语义，不另起一套。
 */
export function buildCandidates(config, requested, nativeGif = false) {
  // 旧客户端只能原样重放协议；不同供应商、模型和异步任务由新客户端按各自协议切换。
  const usable = (channel) => Boolean(channel.enabled && channel.apiKey)
    && channel.provider === requested.provider && channel.apiMode === requested.apiMode
    && channel.model === requested.model && channel.codexCli === requested.codexCli
    && (!nativeGif || channel.supportsNativeGif)
  return [requested, ...config.channels.filter((channel) => channel.id !== requested.id)].filter(usable)
}

/** 本次最多试几条。failoverEnabled 关掉或候选只有一条时，就是"不重试"。 */
function attemptBudget(site, candidateCount) {
  if (!site.failoverEnabled) return 1
  const configured = Number(site.failoverMaxAttempts)
  if (Number.isFinite(configured) && configured > 0) return Math.min(configured, candidateCount)
  return candidateCount
}

/**
 * 把请求体读进内存。
 *
 * 超过上限时**不继续读**，而是把已经读到的那部分交出去做流式转发——
 * 这样大请求走不了故障转移，但也不会因为"读不下就报错"而彻底失败。
 */
function drainBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false

    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
    }
    const finish = (complete) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ chunks, size, complete })
    }

    const onData = (chunk) => {
      chunks.push(chunk)
      size += chunk.length
      if (size > limit) {
        // 暂停而不是销毁：剩下的字节原封不动留在 req 里，交给流式转发继续读。
        req.pause()
        finish(false)
      }
    }
    const onEnd = () => finish(true)
    const onError = (err) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

/** 上游失败时把响应体前几 KB 读出来，用于"所有渠道都失败"时的汇总报错。 */
function readErrorSnippet(upstreamRes) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf-8').slice(0, ERROR_SNIPPET_BYTES))
    }
    upstreamRes.on('data', (chunk) => {
      if (size < ERROR_SNIPPET_BYTES) {
        chunks.push(chunk)
        size += chunk.length
      } else {
        // 读够了就丢掉剩余部分，让连接尽快回到连接池。
        upstreamRes.resume()
        finish()
      }
    })
    upstreamRes.on('end', finish)
    upstreamRes.on('close', finish)
    upstreamRes.on('error', finish)
  })
}

/** 浏览器断开后把已经发出的上游响应读完，不能反向取消仍在生成的付费任务。 */
function discardResponse(upstreamRes) {
  if (upstreamRes.readableEnded || upstreamRes.destroyed) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    upstreamRes.once('end', finish)
    upstreamRes.once('close', finish)
    upstreamRes.once('error', finish)
    upstreamRes.resume()
  })
}

function resolveFalTargetUrl(req, channel) {
  const raw = req.headers[FAL_TARGET_URL_HEADER]
  const target = Array.isArray(raw) ? raw[0] : raw
  if (!target) throw new HttpError(400, `缺少 ${FAL_TARGET_URL_HEADER} 头`)

  const url = (() => {
    try {
      return new URL(String(target))
    } catch {
      throw new HttpError(400, 'fal 目标地址无效')
    }
  })()

  const base = String(channel.baseUrl ?? '').trim().replace(/\/+$/, '')
  // 管理员配置了自定义 fal 兼容网关时，把目标的 origin 换成该网关。
  if (base && base !== 'https://fal.run') {
    const gateway = (() => {
      try {
        return new URL(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(base) ? base : `https://${base}`)
      } catch {
        throw new HttpError(500, '渠道的 fal 网关地址无效')
      }
    })()
    return new URL(`${url.pathname}${url.search}`, gateway.origin)
  }

  if (!FAL_ALLOWED_HOSTS.test(url.hostname)) throw new HttpError(400, `不允许转发到 ${url.hostname}`)
  return url
}

/** 每条渠道的上游地址与鉴权头。fal 走它自己的目标头机制，其余走 baseUrl 拼接。 */
function resolveTarget(req, channel, endpointPath, search) {
  if (channel.provider === 'fal') {
    return {
      upstreamUrl: resolveFalTargetUrl(req, channel),
      authHeader: `Key ${channel.apiKey}`,
      dropHeaders: [FAL_TARGET_URL_HEADER],
    }
  }
  if (!endpointPath) throw new HttpError(400, '缺少上游接口路径')
  return {
    upstreamUrl: buildUpstreamUrl(channel.baseUrl, endpointPath, search ?? ''),
    authHeader: `Bearer ${channel.apiKey}`,
    dropHeaders: [],
  }
}

/**
 * 把已经决定采用的上游响应写回客户端，并等它结束。
 * 走到这里说明响应头已经发出去了，之后再出错也无法换渠道。
 *
 * extraHeaders 用来附加我们自己的回执头（本次扣了多少、扣完还剩多少）。
 * 同源请求下 JS 读得到这些头，前端据此即时刷新余额，省掉一次额外的查询。
 */
function adoptResponse(res, upstreamRes, extraHeaders, headChunks = [], complete = false) {
  return new Promise((resolve, reject) => {
    if (!res.headersSent) {
      res.writeHead(upstreamRes.statusCode ?? 502, { ...forwardableHeaders(upstreamRes), ...extraHeaders })
    }
    for (const chunk of headChunks) res.write(chunk)
    if (complete || upstreamRes.readableEnded) {
      res.end()
      resolve({ status: upstreamRes.statusCode ?? 0 })
      return
    }
    upstreamRes.pipe(res)
    upstreamRes.on('end', () => resolve({ status: upstreamRes.statusCode ?? 0 }))
    upstreamRes.on('error', reject)
  })
}

export async function handleRelay(req, res, ctx) {
  const config = getConfig()
  const { channelId, endpointPath } = parseRelayPath(ctx.path)

  if (req.method === 'POST') {
    const identity = ctx.user?.id || getClientIp(req)
    const slot = generationGate.acquire(identity)
    if (!slot.ok) {
      res.setHeader('X-GIP-Failover', 'stop')
      const message = slot.reason === 'rate'
        ? '生成请求过于频繁，请稍后再试'
        : slot.reason === 'global'
          ? '当前生成任务较多，请稍后再试'
          : '你已有生成任务正在处理，请等待完成后再试'
      throw new HttpError(429, message, {
        code: slot.reason === 'rate' ? 'generation-rate-limited' : 'generation-busy',
        retryAfterSeconds: slot.retryAfterSeconds,
      })
    }
    res.once('finish', slot.release)
    res.once('close', slot.release)
  }

  const requested = findChannel(channelId)
  if (!requested) throw new HttpError(404, '渠道不存在或已下线')
  if (!requested.enabled) throw new HttpError(503, `渠道「${requested.name}」已停用`)
  if (!requested.apiKey) throw new HttpError(503, `渠道「${requested.name}」未配置 API Key`)

  // 请求体读进来才能重放给下一条渠道；读不下就退回流式单渠道。
  const drained = await drainBody(req, MAX_BUFFERED_BODY_BYTES)
  const bufferedBody = drained.complete ? Buffer.concat(drained.chunks) : null
  const head = (bufferedBody ?? Buffer.concat(drained.chunks)).subarray(0, BILLING_PEEK_BYTES)
  const rewindable = drained.complete
  let nativeGif = false
  if (req.method === 'POST' && /^images\/(generations|edits)\/?$/.test(endpointPath)) {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
    const body = bufferedBody ?? head
    if (contentType.includes('multipart/form-data')) {
      // 只识别独立表单字段，不能把提示词里提到的 GIF 当作输出格式。
      nativeGif = /(?:^|\r?\n)--[^\r\n]+\r?\nContent-Disposition: form-data;[ \t]*name="output_format"[ \t]*\r?\n(?:[^\r\n]+\r?\n)*\r?\ngif[ \t]*\r?\n--/i.test(body.toString('utf-8'))
    } else if (bufferedBody) {
      try {
        nativeGif = JSON.parse(bufferedBody.toString('utf-8')).output_format === 'gif'
      } catch {
        // 无法解析的请求仍交给原有接口校验，不猜测提示词内容。
      }
    }
  }
  if (nativeGif && !requested.supportsNativeGif) {
    throw new HttpError(400, '当前渠道未开启原生 GIF 动图，请选择支持原生 GIF 的渠道', { code: 'native-gif-unsupported' })
  }
  const candidates = buildCandidates(config, requested, nativeGif)

  const userId = ctx.user?.id ?? ''
  const billable = isBillableRequest(req.method, requested, endpointPath)
  let statefulResponse = false
  if (endpointPath === 'responses' && bufferedBody) {
    try {
      const payload = JSON.parse(bufferedBody.toString('utf-8'))
      // 这些标识属于原渠道的会话，换同模型也无法在另一上游继续。
      statefulResponse = Boolean(payload.previous_response_id || payload.conversation)
        || Array.isArray(payload.input) && payload.input.some((item) => /(?:_call_output$|^item_reference$)/.test(String(item?.type ?? '')))
    } catch {
      statefulResponse = true
    }
  }
  // 新客户端统一编排，防止前后端各自循环导致重复调用；轮询不能向其他渠道查询同一个任务。
  const clientFailover = req.headers['x-gip-failover'] === 'client'
  const canReplay = !clientFailover && !statefulResponse && rewindable && billable && requested.provider === 'openai'
  const budget = canReplay ? attemptBudget(config.site, candidates.length) : 1
  const creditCount = billable ? parseImageCount(head, req.headers['content-type']) : 0
  const costOf = (id) => actualCost(config.site, id, creditCount)
  const creditConfig = config.site.credits
  const chargeable = Boolean(creditConfig.enabled) && Boolean(userId) && billable && creditCount > 0
  const wantsHeartbeat = req.headers['x-gip-keepalive'] === '1'
  const streamingRequest = /["']stream["']\s*:\s*true/i.test(head.toString('utf-8'))

  // 幸运免单：出门前掷骰子，命中就这次不占积分、不扣积分（营销活动，概率后台可调）。
  // 在占位之前决定，命中走的是"无占位 → 成功后不结算"的通路，不会产生退款流水。
  const luckyFree = chargeable
    && creditConfig.luckyEnabled === true
    && creditConfig.luckyRate > 0
    && Math.random() * 100 < creditConfig.luckyRate

  // 出门前先占住"最贵候选渠道"的价，避免并发把余额刷穿；失败了一分不扣。
  const reserved = chargeable && !luckyFree
    ? Math.max(0, ...candidates.slice(0, budget).map((channel) => costOf(channel.id)))
    : 0
  if (reserved > 0) {
    const hold = reserveCredits(userId, reserved)
    if (!hold.ok) {
      res.setHeader('X-GIP-Failover', 'stop')
      // 请求体已经读完，但客户端拿到的是一条明确的 402，前端据此引导去充值。
      // code / available / required 走结构化字段，前端不用去解析人话文案。
      throw new HttpError(402, '积分不足，请充值后再试', {
        code: 'insufficient-credits',
        required: reserved,
        available: hold.available,
      })
    }
  }

  const heartbeat = createJsonHeartbeat(res, billable && wantsHeartbeat && !streamingRequest)

  let settled = false
  const release = () => {
    if (settled) return
    settled = true
    if (reserved > 0) releaseReservation(userId, reserved)
  }
  // 客户端提前断开也要把占位还回去，否则额度会被一直占着。
  res.on('close', release)

  const failures = []
  const counted = req.method === 'POST'
  let clientGone = res.destroyed
  const onClientClose = () => {
    if (!res.writableEnded) clientGone = true
  }
  res.once('close', onClientClose)

  try {
    for (let i = 0; i < budget; i += 1) {
      if (clientGone || res.destroyed || res.writableEnded) {
        release()
        return { status: 0 }
      }
      const channel = candidates[i]
      const started = Date.now()

      const track = (ok, status, error) => {
        if (!counted) return
        recordChannelCall({
          channelId: channel.id,
          userId,
          ok,
          status,
          latencyMs: Date.now() - started,
          at: started,
          error,
          aborted: !ok && clientGone,
        })
      }

      const target = (() => {
        try {
          return resolveTarget(req, channel, endpointPath, ctx.search)
        } catch (err) {
          // 地址都拼不出来，等同于这条渠道不可用，换下一条。
          return { error: err instanceof Error ? err.message : '渠道地址无效' }
        }
      })()

      if (target.error) {
        failures.push(`${channel.name}：${target.error}`)
        track(false, 0, target.error)
        if (clientFailover) throw new HttpError(502, target.error)
        continue
      }

      let attempt
      try {
        const requestBody = rewindable
          ? normalizeImageRequestBody(bufferedBody, req.headers['content-type'], channel, endpointPath)
          : null
        attempt = await attemptUpstream(req, target.upstreamUrl, {
          authHeader: target.authHeader,
          dropHeaders: target.dropHeaders,
          timeoutMs: getUpstreamTimeoutMs(channel, billable),
          body: requestBody,
          headChunks: rewindable ? [] : drained.chunks,
          extraHeaders: requestBody ? { 'content-length': String(requestBody.length) } : undefined,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : '转发失败'
        failures.push(`${channel.name}：${message}`)
        track(false, 0, message)
        // 客户端自己跑了就不要再往下试了，用户已经不在乎结果。
        if (clientGone || res.writableEnded) {
          release()
          return { status: 0 }
        }
        if (!isChannelFault(0, message)) {
          throw new HttpError(classifyGenerationError(message) === 'content_policy' ? 400 : 409, formatGenerationError(message))
        }
        if (clientFailover) throw new HttpError(502, message)
        continue
      }

      // 限流不代表渠道损坏，但可尝试其他容量；健康统计与是否重试不能共用一个判断。
      if (isChannelFault(attempt.status) || attempt.status === 429) {
        const snippet = await readErrorSnippet(attempt.upstreamRes).catch(() => '')
        attempt.upstream.destroy()
        const message = `HTTP ${attempt.status}${snippet ? `：${formatGenerationError(snippet).slice(0, ERROR_SNIPPET_BYTES)}` : ''}`
        track(false, attempt.status, message)
        if (clientGone || res.writableEnded) {
          release()
          return { status: attempt.status }
        }
        const kind = classifyGenerationError(message)
        if (kind === 'content_policy' || kind === 'cancelled') {
          if (!res.headersSent) res.setHeader('X-GIP-Failover', 'stop')
          throw new HttpError(attempt.status, message)
        }
        if (clientFailover) throw new HttpError(attempt.status, message)
        failures.push(`${channel.name}：${message}`)
        continue
      }

      // 采用这条渠道。从这里开始就不再有重试的机会了。
      //
      // 结算前检查小型响应里的实际失败。传图开始后的断流仍由现有流式结算处理，
      // 不能仅凭浏览器断开就认定上游取消或审核失败。
      // 顺带把扣费结果塞进响应头，前端不用再打一次接口就知道新余额。
      const success = attempt.status >= 200 && attempt.status < 300
      if (!success && heartbeat.started) {
        const snippet = await readErrorSnippet(attempt.upstreamRes).catch(() => '')
        attempt.upstream.destroy()
        const message = `HTTP ${attempt.status}${snippet ? `：${formatGenerationError(snippet).slice(0, ERROR_SNIPPET_BYTES)}` : ''}`
        track(false, attempt.status, message)
        release()
        heartbeat.finishError(message)
        return { status: attempt.status }
      }
      const inspected = success && billable && ['openai', 'sb2api-async', 'fal'].includes(channel.provider)
        ? await inspectSuccessfulPayload(attempt.upstreamRes, channel.provider)
        : { valid: true, chunks: [], complete: false }
      if (!inspected.valid) {
        attempt.upstream.destroy()
        const kind = classifyGenerationError(inspected.message)
        if (kind === 'content_policy' || kind === 'cancelled') {
          const status = kind === 'content_policy' ? 400 : 409
          track(false, status, inspected.message)
          if (!res.headersSent) res.setHeader('X-GIP-Failover', 'stop')
          throw new HttpError(status, inspected.message)
        }
        const message = `HTTP 502：上游返回成功状态，但没有可识别的图片或任务数据${inspected.message ? `：${inspected.message}` : ''}`
        failures.push(`${channel.name}：${message}`)
        track(false, 502, message)
        if (clientFailover) throw new HttpError(502, message)
        continue
      }
      if (clientGone || res.destroyed) {
        if (!inspected.complete) await discardResponse(attempt.upstreamRes)
        track(false, attempt.status, '浏览器或前置反向代理提前断开，上游任务未取消')
        release()
        return { status: attempt.status }
      }
      const generated = success && !inspected.failed
      const charged = !luckyFree && chargeable && generated ? costOf(channel.id) : 0
      const extraHeaders = {}
      if (charged > 0) {
        settleCredits(userId, charged, {
          images: creditCount,
          ref: channel.id,
          // 用户流水只说明做了什么，渠道信息留在 ref 里供后台排查，不向用户文案暴露。
          note: `出图 ${creditCount || 1} 张`,
          reserved,
        })
        settled = true
        extraHeaders['x-credits-charged'] = String(charged)
        extraHeaders['x-credits-balance'] = String(getBalance(userId))
      } else {
        release()
        // 幸运免单命中：告诉前端这次没扣分，界面好放庆祝提示
        if (luckyFree && generated) {
          recordLuckyFree(userId, {
            images: creditCount || 1,
            ref: channel.id,
            note: `幸运免单 · 出图 ${creditCount || 1} 张`,
          })
          extraHeaders['x-credits-lucky'] = '1'
          extraHeaders['x-credits-balance'] = String(getBalance(userId))
        }
      }

      // 邀请奖励：这是"被邀请人第一次成功出图"，到这一步才给邀请人发积分。
      // 幂等，重复调用不会重复发；配置关掉、超上限都会自己跳过。
      if (generated && userId) {
        const referral = maybeRewardInviter(userId)
        if (referral.rewarded) console.log(`[referral] ${userId} 首图成功，奖励邀请人 ${referral.inviterId} ${referral.reward} 积分`)
      }

      try {
        heartbeat.stop()
        const result = await adoptResponse(res, attempt.upstreamRes, extraHeaders, inspected.chunks, inspected.complete)
        track(generated, inspected.failed ? 502 : result.status, inspected.failed ? inspected.message : generated ? '' : `上游返回 HTTP ${result.status}`)
        return result
      } catch (err) {
        // 响应头已经发出去了，这时候出错只能如实告诉客户端。
        const message = err instanceof Error ? err.message : '转发中断'
        track(false, attempt.status, message)
        release()
        throw new HttpError(502, message)
      }
    }

    release()
    throw new HttpError(502, `所有渠道均失败：${failures.join('；') || '没有可用渠道'}`)
  } catch (err) {
    release()
    const message = err instanceof Error ? err.message : '服务器内部错误'
    if (heartbeat.finishError(message)) return { status: err instanceof HttpError ? err.status : 502 }
    throw err
  } finally {
    heartbeat.stop()
    res.off('close', onClientClose)
  }
}
