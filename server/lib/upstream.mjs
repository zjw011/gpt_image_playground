// 上游请求：把访客请求原样转发到渠道真实地址，并在服务端注入凭据。
// 用 node:http/https 的 pipe 而不是 fetch，是为了让大体积 multipart 上传和 SSE 响应都保持流式。

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** 与前端 src/lib/devProxy.ts 的 normalizeBaseUrl 保持一致：结尾带 / 表示直接拼接，否则自动补 /v1。 */
export function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim()
  if (!trimmed) return ''

  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`

  try {
    const url = new URL(input)
    if (trimmed.endsWith('/')) return `${url.origin}${url.pathname.replace(/\/+$/, '/')}`

    const segments = url.pathname.split('/').filter(Boolean)
    const v1Index = segments.indexOf('v1')
    const normalized = v1Index >= 0
      ? segments.slice(0, v1Index + 1)
      : segments.length
        ? [...segments, 'v1']
        : []
    return `${url.origin}${normalized.length ? `/${normalized.join('/')}` : ''}`
  } catch {
    return trimmed.replace(/\/+$/, '')
  }
}

/** 把渠道 baseUrl 与访客请求的相对路径拼成上游 URL。 */
export function buildUpstreamUrl(baseUrl, endpointPath, search) {
  const normalized = normalizeBaseUrl(baseUrl)
  if (!normalized) throw new Error('渠道未配置 API 地址')

  const path = String(endpointPath ?? '').replace(/^\/+/, '')
  const base = String(baseUrl).trim().endsWith('/')
    ? `${normalized.replace(/\/+$/, '')}/`
    : normalized.endsWith('/v1')
      ? `${normalized}/`
      : `${normalized}/v1/`

  return new URL(`${base}${path}${search ?? ''}`)
}

// 逐跳头与访客不该决定的头，一律不转发。
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'authorization',
  'cookie',
  'origin',
  'referer',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
])

const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'content-encoding',
  'content-length',
])

function pickRequestHeaders(req, upstreamUrl, options) {
  const dropped = new Set(options.dropHeaders ?? [])
  const headers = { host: upstreamUrl.host }
  for (const [name, value] of Object.entries(req.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || dropped.has(name)) continue
    if (name.startsWith(':')) continue
    if (value != null) headers[name] = value
  }
  headers.authorization = options.authHeader
  // 上游多数网关不接受 br/zstd 之后再由我们解码，直接要求 identity 以便原样透传。
  headers['accept-encoding'] = 'identity'
  Object.assign(headers, options.extraHeaders ?? {})
  return headers
}

/**
 * 把 req 转发到 upstreamUrl 并把响应流回 res。
 * 返回 Promise，在上游响应结束或出错时结算，便于调用方记录渠道健康度。
 */
export function pipeToUpstream(req, res, options) {
  const upstreamUrl = options.upstreamUrl
  const send = upstreamUrl.protocol === 'http:' ? httpRequest : httpsRequest

  return new Promise((resolve, reject) => {
    const upstream = send(
      upstreamUrl,
      {
        method: req.method,
        headers: pickRequestHeaders(req, upstreamUrl, options),
        timeout: options.timeoutMs,
      },
      (upstreamRes) => {
        const headers = {}
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (DROPPED_RESPONSE_HEADERS.has(name)) continue
          if (value != null) headers[name] = value
        }
        headers['cache-control'] = headers['cache-control'] ?? 'no-store'
        // SSE 经过反代时容易被缓冲，显式关闭。
        if (String(upstreamRes.headers['content-type'] ?? '').includes('text/event-stream')) {
          headers['x-accel-buffering'] = 'no'
        }

        res.writeHead(upstreamRes.statusCode ?? 502, headers)
        upstreamRes.pipe(res)
        upstreamRes.on('end', () => resolve({ status: upstreamRes.statusCode ?? 0 }))
        upstreamRes.on('error', reject)
      },
    )

    upstream.on('timeout', () => {
      upstream.destroy(new Error('上游请求超时'))
    })
    upstream.on('error', reject)
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy()
    })

    req.pipe(upstream)
    req.on('error', () => upstream.destroy())
  })
}
