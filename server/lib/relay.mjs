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
import { getBalance, releaseReservation, reserveCredits, settleCredits } from './credits.mjs'
import { HttpError } from './http.mjs'
import { findChannel, getConfig } from './store.mjs'
import { attemptUpstream, buildUpstreamUrl, forwardableHeaders } from './upstream.mjs'
import { isChannelFault, recordChannelCall } from './usage.mjs'

const FAL_TARGET_URL_HEADER = 'x-fal-target-url'
const FAL_ALLOWED_HOSTS = /(^|\.)(fal\.run|fal\.ai)$/

/** 超过这个体积就不缓冲了：能重放的请求体一律在内存里，换来静默故障转移。 */
const MAX_BUFFERED_BODY_BYTES = 32 * 1024 * 1024

/** 失败响应只留这么多字节用于排查，多了会把错误信息淹没。 */
const ERROR_SNIPPET_BYTES = 2_048

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
export function buildCandidates(config, requested) {
  const usable = (channel) => Boolean(channel.enabled && channel.apiKey)
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
function adoptResponse(res, upstreamRes, extraHeaders) {
  return new Promise((resolve, reject) => {
    res.writeHead(upstreamRes.statusCode ?? 502, { ...forwardableHeaders(upstreamRes), ...extraHeaders })
    upstreamRes.pipe(res)
    upstreamRes.on('end', () => resolve({ status: upstreamRes.statusCode ?? 0 }))
    upstreamRes.on('error', reject)
  })
}

export async function handleRelay(req, res, ctx) {
  const config = getConfig()
  const { channelId, endpointPath } = parseRelayPath(ctx.path)

  const requested = findChannel(channelId)
  if (!requested) throw new HttpError(404, '渠道不存在或已下线')
  if (!requested.enabled) throw new HttpError(503, `渠道「${requested.name}」已停用`)
  if (!requested.apiKey) throw new HttpError(503, `渠道「${requested.name}」未配置 API Key`)

  const candidates = buildCandidates(config, requested)
  const budget = attemptBudget(config.site, candidates.length)

  // 请求体读进来才能重放给下一条渠道；读不下就退回流式单渠道。
  const drained = await drainBody(req, MAX_BUFFERED_BODY_BYTES)
  const head = Buffer.concat(drained.chunks).subarray(0, BILLING_PEEK_BYTES)
  const rewindable = drained.complete

  const userId = ctx.user?.id ?? ''
  const billable = isBillableRequest(req.method, requested, endpointPath)
  const creditCount = billable ? parseImageCount(head, req.headers['content-type']) : 0
  const costOf = (id) => actualCost(config.site, id, creditCount)
  const chargeable = Boolean(config.site.credits.enabled) && Boolean(userId) && billable && creditCount > 0

  // 出门前先占住"最贵候选渠道"的价，避免并发把余额刷穿；失败了一分不扣。
  const reserved = chargeable
    ? Math.max(0, ...candidates.slice(0, budget).map((channel) => costOf(channel.id)))
    : 0
  if (reserved > 0) {
    const hold = reserveCredits(userId, reserved)
    if (!hold.ok) {
      // 请求体已经读完，但客户端拿到的是一条明确的 402，前端据此引导去充值。
      // code / available / required 走结构化字段，前端不用去解析人话文案。
      throw new HttpError(402, '积分不足，请充值后再试', {
        code: 'insufficient-credits',
        required: reserved,
        available: hold.available,
      })
    }
  }

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

  try {
    for (let i = 0; i < budget; i += 1) {
      const channel = candidates[i]
      const started = Date.now()
      let clientGone = false
      res.on('close', () => {
        if (!res.writableEnded) clientGone = true
      })

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
        continue
      }

      let attempt
      try {
        attempt = await attemptUpstream(req, target.upstreamUrl, {
          authHeader: target.authHeader,
          dropHeaders: target.dropHeaders,
          timeoutMs: Math.max(10_000, channel.timeout * 1000),
          body: rewindable ? Buffer.concat(drained.chunks) : null,
          headChunks: rewindable ? [] : drained.chunks,
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
        continue
      }

      // 渠道自身故障（密钥失效、欠费、地址错、上游 5xx、超时）才算"该换"，换下一条。
      // 提示词被拒、参数不合法、限流这些换渠道也一样会失败，直接透传给用户。
      if (isChannelFault(attempt.status)) {
        const snippet = await readErrorSnippet(attempt.upstreamRes).catch(() => '')
        attempt.upstream.destroy()
        const message = `HTTP ${attempt.status}${snippet ? `：${snippet.slice(0, 160)}` : ''}`
        failures.push(`${channel.name}：${message}`)
        track(false, attempt.status, message)
        if (clientGone || res.writableEnded) {
          release()
          return { status: attempt.status }
        }
        continue
      }

      // 采用这条渠道。从这里开始就不再有重试的机会了。
      //
      // 结算放在写响应头之前：上游已经给出 2xx，出图这件事就已经发生了，
      // 之后再断流也不该白送——否则"客户端中途关页面"就成了免费的旁路。
      // 顺带把扣费结果塞进响应头，前端不用再打一次接口就知道新余额。
      const charged = chargeable && attempt.status >= 200 && attempt.status < 300 ? costOf(channel.id) : 0
      const extraHeaders = {}
      if (charged > 0) {
        settleCredits(userId, charged, {
          images: creditCount,
          ref: channel.id,
          // 流水说明要能独立看懂："出图 2 张"比一个渠道名直观得多
          note: `出图 ${creditCount || 1} 张 · ${channel.name}`,
          reserved,
        })
        settled = true
        extraHeaders['x-credits-charged'] = String(charged)
        extraHeaders['x-credits-balance'] = String(getBalance(userId))
      } else {
        release()
      }

      try {
        const result = await adoptResponse(res, attempt.upstreamRes, extraHeaders)
        track(result.status >= 200 && result.status < 300, result.status, result.status >= 200 && result.status < 300 ? '' : `上游返回 HTTP ${result.status}`)
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
    throw err
  }
}
