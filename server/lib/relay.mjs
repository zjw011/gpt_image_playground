// 中继编排：校验接口/模型/数量、有界上传、渠道切换及按最终成品结算。

import { randomUUID } from 'node:crypto'
import {
  actualCost,
  unitCost,
} from './billing.mjs'
import { getAccount, getAvailableBalance, getBalance, getReserved, releaseReservation, reserveCredits } from './credits.mjs'
import { maybeRewardInviter } from './referral.mjs'
import { getClientIp, HttpError } from './http.mjs'
import { generationGate } from './generationGate.mjs'
import { findChannel, getConfig } from './store.mjs'
import { attemptUpstream, buildUpstreamUrl, forwardableHeaders } from './upstream.mjs'
import { isChannelFault, recordChannelCall } from './usage.mjs'
import { classifyGenerationError, formatGenerationError, getGenerationResponseError } from '../../src/lib/generationError.mjs'
import { imageCountFromFields, parseRelayFields, resolveRelayContract, validateRelayModel } from './relayContract.mjs'
import { createResultObserver, readGenerationResult } from './generationResult.mjs'
import { assertGenerationCapacity, assertGenerationOrder, createGenerationOrder, findGenerationPoll, settleGenerationOrder } from './generationOrders.mjs'

const FAL_TARGET_URL_HEADER = 'x-fal-target-url'
const FAL_ALLOWED_HOSTS = /(^|\.)(fal\.run|fal\.ai)$/

/** 单次上传最多 64MB，同时在途上传总计最多 256MB。 */
const MAX_BUFFERED_BODY_BYTES = 64 * 1024 * 1024
let bufferedRequestBytes = 0

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
function inspectSuccessfulPayload(upstreamRes, provider, contract) {
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
          const parsed = JSON.parse(data)
          const mapped = readGenerationResult(parsed, contract, provider)
          const result = { ...inspectImagePayload(parsed, provider), image: mapped.images.length > 0 || streaming && inspectImagePayload(parsed, provider).image, task: Boolean(mapped.taskId), response: contract.responses && (Array.isArray(parsed.output) || /^response\.(?:completed|output_text\.|output_item\.|function_call_arguments\.)/.test(String(parsed.type || ''))) }
          // SSE 按事件顺序处理：开始传图之后，后续失败继续交给客户端处理部分结果。
          if (result.error || result.image || result.task || result.response) return result
        } catch {
          // 未完成的 JSON 留给后续字节；未知格式保持原来的转发行为。
        }
      }
      return { image: false, error: null }
    }
    const onData = (chunk) => {
      chunks.push(chunk)
      size += chunk.length
      if (streaming) {
        const result = inspectBody(text())
        if (result.error && !result.task) return finish(false, result.error.slice(0, ERROR_SNIPPET_BYTES))
        if (result.image || result.response || size >= SUCCESS_PEEK_BYTES) return finish(true)
      }
      if (size > 128 * 1024 * 1024) {
        finish(false, '上游响应超过 128MB 限制')
        upstreamRes.destroy()
      }
    }
    const onEnd = () => {
      const body = text()
      const result = inspectBody(body, true)
      finish(Boolean(result.image || result.task || result.response), result.error || body.trim().slice(0, ERROR_SNIPPET_BYTES), true, Boolean(result.error && !result.image))
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

/** 上传有独立截止时间和全局预算；完整校验后才能把管理员密钥发给上游。 */
function drainBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, '生成请求超过 64MB 上传限制')
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const timer = setTimeout(() => fail(new HttpError(408, '上传超过 120 秒，请缩小参考图后重试')), 120_000)
    timer.unref?.()
    const cleanup = () => {
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', fail)
      req.off('aborted', aborted)
    }
    const fail = (err) => {
      if (settled) return
      settled = true
      cleanup()
      bufferedRequestBytes -= size
      req.pause()
      reject(err)
    }
    const aborted = () => fail(new HttpError(400, '上传已中断'))
    const onData = (chunk) => {
      size += chunk.length
      bufferedRequestBytes += chunk.length
      if (size > limit || bufferedRequestBytes > 256 * 1024 * 1024) return fail(new HttpError(413, '上传体积或服务器缓冲已达上限，请稍后重试'))
      chunks.push(chunk)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      let released = false
      resolve({ body: Buffer.concat(chunks), release: () => {
        if (released) return
        released = true
        bufferedRequestBytes -= size
      } })
    }
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', fail)
    req.once('aborted', aborted)
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
async function adoptResponse(res, upstreamRes, extraHeaders, headChunks = [], complete = false, observer, finish) {
  for (const chunk of headChunks) observer?.write(chunk)
  if (complete || upstreamRes.readableEnded) {
    Object.assign(extraHeaders, finish?.(observer?.finish()) || {})
    if (!res.destroyed) {
      if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 502, { ...forwardableHeaders(upstreamRes), ...extraHeaders })
      for (const chunk of headChunks) res.write(chunk)
      res.end()
    }
    return { status: upstreamRes.statusCode ?? 0 }
  }
  if (!res.destroyed && !res.headersSent) res.writeHead(upstreamRes.statusCode ?? 502, { ...forwardableHeaders(upstreamRes), ...extraHeaders })
  for (const chunk of headChunks) if (!res.destroyed) res.write(chunk)
  let readError
  try {
    for await (const chunk of upstreamRes) {
      observer?.write(chunk)
      if (!res.destroyed && !res.writableEnded) {
        if (!res.write(chunk)) await new Promise((resolve) => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve() }
          res.once('drain', done)
          res.once('close', done)
        })
      }
    }
  } catch (err) { readError = err }
  finish?.(observer?.finish())
  if (readError) throw readError
  if (!res.destroyed && !res.writableEnded) res.end()
  return { status: upstreamRes.statusCode ?? 0 }
}

async function handleRelayRequest(req, res, ctx, drained) {
  const config = getConfig()
  const { channelId, endpointPath } = parseRelayPath(ctx.path)

  const existingOrder = findGenerationPoll(req, ctx.user?.id ?? '', channelId, endpointPath)
  const configured = findChannel(channelId)
  const requested = existingOrder ? {
    ...configured, id: channelId, name: configured?.name || '原任务渠道', provider: existingOrder.provider,
    apiKey: existingOrder.auth.replace(/^(?:Bearer|Key) /, ''), baseUrl: new URL(existingOrder.url).origin,
    enabled: true, model: configured?.model || '', timeout: configured?.timeout || 600,
  } : configured
  if (!requested) throw new HttpError(404, '渠道不存在或已下线')
  if (!requested.enabled) throw new HttpError(503, `渠道「${requested.name}」已停用`)
  if (!requested.apiKey) throw new HttpError(503, `渠道「${requested.name}」未配置 API Key`)

  const contract = existingOrder ? { submit: false, taskId: existingOrder.taskId, definition: { poll: existingOrder.poll } } : resolveRelayContract(req, requested, endpointPath, config)
  if (contract.submit) assertGenerationCapacity(ctx.user?.id || getClientIp(req))
  let bufferedBody = drained.body
  if (contract.submit && req.method === 'POST' && !bufferedBody.length) throw new HttpError(400, '生成请求不能为空')
  const parsed = parseRelayFields(bufferedBody, req.headers['content-type'])
  const fields = req.method === 'GET' ? Object.fromEntries(new URLSearchParams(ctx.search)) : parsed.fields
  const requestedCount = validateRelayModel(fields, requested, req.method === 'GET' ? { body: contract.mapping?.query } : contract.mapping)
  const query = Object.fromEntries(new URLSearchParams(ctx.search))
  validateRelayModel(query, requested, contract.mapping?.query ? { body: contract.mapping.query } : undefined)
  if (['n', 'num_images', 'batch_size'].some((key) => query[key] != null) && imageCountFromFields(query) !== requestedCount) throw new HttpError(400, '查询参数中的生成张数与请求体不一致')
  if (contract.submit && ['openai', 'sb2api-async'].includes(requested.provider) && parsed.json && parsed.json.model == null) {
    parsed.json.model = requested.model
    bufferedBody = Buffer.from(JSON.stringify(parsed.json))
  }
  if (contract.submit && ['openai', 'sb2api-async'].includes(requested.provider) && !parsed.json && fields.model == null && bufferedBody.length) {
    const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(req.headers['content-type'])
    const value = boundary?.[1] || boundary?.[2]
    const marker = Buffer.from(`--${value}--`)
    const end = bufferedBody.lastIndexOf(marker)
    bufferedBody = Buffer.concat([bufferedBody.subarray(0, end), Buffer.from(`--${value}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${requested.model}\r\n`), bufferedBody.subarray(end)])
  }
  const rewindable = true
  const nativeGif = contract.submit && fields.output_format === 'gif'
  if (nativeGif && !requested.supportsNativeGif) {
    throw new HttpError(400, '当前渠道未开启原生 GIF 动图，请选择支持原生 GIF 的渠道', { code: 'native-gif-unsupported' })
  }
  const candidates = buildCandidates(config, requested, nativeGif)

  const userId = ctx.user?.id ?? ''
  const billable = contract.submit
  const pollingOrder = existingOrder || (contract.submit ? null : assertGenerationOrder(userId, requested.id, contract.taskId))
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
  const creditCount = billable ? requestedCount : 0
  const costOf = (id) => actualCost(config.site, id, creditCount)
  const creditConfig = config.site.credits
  const chargeable = Boolean(creditConfig.enabled) && Boolean(userId) && billable && creditCount > 0
  const wantsHeartbeat = req.headers['x-gip-keepalive'] === '1'
  const streamingRequest = fields.stream === true

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
  // 上游已经受理后继续读完并结算；浏览器断开不能释放别人的在途额度。

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
          const target = resolveTarget(req, channel, endpointPath, ctx.search)
          if (pollingOrder?.url) {
            const suffix = requested.provider === 'fal' ? new URL(String(req.headers[FAL_TARGET_URL_HEADER])).pathname.endsWith('/status') ? '/status' : new URL(String(req.headers[FAL_TARGET_URL_HEADER])).pathname.endsWith('/cancel') ? '/cancel' : '' : ''
            target.upstreamUrl = new URL(pollingOrder.url + suffix)
            target.authHeader = pollingOrder.auth || target.authHeader
          }
          return target
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
          headChunks: [],
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
        if (clientFailover) throw Object.assign(new HttpError(attempt.status, message), { upstream: true })
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
      const inspected = success && billable
        ? await inspectSuccessfulPayload(attempt.upstreamRes, channel.provider, contract)
        : { valid: true, chunks: [], complete: false }
      if (!inspected.valid) {
        attempt.upstream.destroy()
        if (inspected.message.includes('128MB')) throw new HttpError(413, inspected.message)
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
      let generated = false
      const observer = success ? createResultObserver(pollingOrder ? { poll: pollingOrder.poll, result: pollingOrder.poll?.result } : contract, channel.provider, String(attempt.upstreamRes.headers['content-type'] || '').includes('text/event-stream')) : null
      const extraHeaders = { 'x-credits-pending': success ? '1' : '0' }
      const finish = (result) => {
        if (pollingOrder && result?.payload) settleGenerationOrder(pollingOrder, result.payload)
        const count = Math.min(creditCount, result?.count || 0)
        generated = success && count > 0
        if (billable && success && result?.taskId && !count) {
          const order = createGenerationOrder({ userId, channel, taskId: result.taskId, contract, upstreamUrl: target.upstreamUrl, reserved, count: creditCount, unitCost: chargeable ? unitCost(config.site, channel.id) : 0, lucky: luckyFree })
          settled = true
          settleGenerationOrder(order, result.payload)
          return { 'x-credits-pending': order.state === 'pending' ? '1' : '0', ...(order.state === 'unresolved' ? { 'x-gip-failover': 'stop' } : {}), 'x-credits-reserved': String(getReserved(userId)), 'x-credits-available': String(getAvailableBalance(userId)), 'x-credits-balance': String(getBalance(userId)), 'x-credits-total-out': String(getAccount(userId).totalOut) }
        }
        const charged = !luckyFree && chargeable && generated ? actualCost(config.site, channel.id, count) : 0
        if (generated && chargeable) {
          const order = createGenerationOrder({ userId, channel, taskId: `sync-${randomUUID()}`, contract: {}, upstreamUrl: target.upstreamUrl, reserved, count: creditCount, finalCount: count, unitCost: unitCost(config.site, channel.id), lucky: luckyFree })
          settled = true
          settleGenerationOrder(order, null, count)
        } else {
          release()
          if (generated && userId) {
            try { maybeRewardInviter(userId) } catch (err) { console.warn('图片已生成，推荐奖励等待补偿', err) }
          }
        }
        return { 'x-credits-pending': '0', 'x-credits-charged': String(charged), 'x-credits-balance': String(getBalance(userId)), 'x-credits-reserved': String(getReserved(userId)), 'x-credits-available': String(getAvailableBalance(userId)), 'x-credits-total-out': String(getAccount(userId).totalOut), ...(luckyFree && generated ? { 'x-credits-lucky': '1' } : {}) }
      }

      try {
        heartbeat.stop()
        const result = await adoptResponse(res, attempt.upstreamRes, extraHeaders, inspected.chunks, inspected.complete, observer, (result) => {
          try { return finish(result) } catch (err) {
            // 本站账本/奖励出错不能伪装成渠道失败，让客户端重投收费任务。
            console.error('生成结果已取得，但本地结算等待恢复', err)
            if (!settled) release()
            return { 'x-gip-failover': 'stop', 'x-credits-pending': '1' }
          }
        })
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

export async function handleRelay(req, res, ctx) {
  let slot
  let drained
  try {
    const route = parseRelayPath(ctx.path)
    const channel = findChannel(route.channelId)
    const existingOrder = findGenerationPoll(req, ctx.user?.id ?? '', route.channelId, route.endpointPath)
    const contract = existingOrder ? { submit: false } : channel ? resolveRelayContract(req, channel, route.endpointPath, getConfig()) : null
    if (contract?.submit) {
      slot = generationGate.acquire(ctx.user?.id || getClientIp(req))
      if (!slot.ok) {
        res.setHeader('X-GIP-Failover', 'stop')
        const message = slot.reason === 'rate' ? '生成请求过于频繁，请稍后再试'
          : slot.reason === 'global' ? '当前生成任务较多，请稍后再试' : '你已有生成任务正在处理，请等待完成后再试'
        throw new HttpError(429, message, { code: slot.reason === 'rate' ? 'generation-rate-limited' : 'generation-busy', retryAfterSeconds: slot.retryAfterSeconds })
      }
    }
    drained = await drainBody(req, MAX_BUFFERED_BODY_BYTES)
    return await handleRelayRequest(req, res, ctx, drained)
  } catch (err) {
    if (!res.headersSent && err instanceof HttpError && !err.upstream && [400, 403, 408, 413].includes(err.status)) res.setHeader('X-GIP-Failover', 'stop')
    throw err
  } finally {
    drained?.release()
    slot?.release?.()
  }
}
