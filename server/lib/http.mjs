// HTTP 基础工具：响应封装、请求体读取、Cookie 解析。

const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024

export function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders) {
  const body = Buffer.from(text, 'utf-8')
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

/** 回一段二进制（二维码 PNG 之类）。cacheSeconds > 0 时允许浏览器缓存。 */
export function sendBinary(res, status, buffer, contentType, cacheSeconds = 0) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Cache-Control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store',
  })
  res.end(buffer)
}

export function sendError(res, status, message, extra) {
  sendJson(res, status, { error: message, ...extra })
}

/** 读取并解析 JSON 请求体。超过上限直接拒绝，避免管理接口被大包打爆。 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new HttpError(413, '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim()
      if (!raw) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'))
      }
    })
  })
}

export class HttpError extends Error {
  /**
   * extra 会原样合并进错误响应体，让前端能按 code 区分错误种类、按字段做定制提示。
   * 例：积分不足时带 { code: 'insufficient-credits', required, available }。
   */
  constructor(status, message, extra) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

/**
 * 读取原始请求体。
 * 微信服务器推送的是 XML 而不是 JSON，走不了 readJsonBody，
 * 所以单独开一条只做"收字节"的路径，解析交给调用方。
 */
export function readRawBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
  })
}

export function parseCookies(header) {
  const cookies = {}
  if (!header) return cookies
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const name = part.slice(0, idx).trim()
    if (!name) continue
    cookies[name] = decodeURIComponent(part.slice(idx + 1).trim())
  }
  return cookies
}

function isSecureRequest(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
  if (forwarded) return forwarded === 'https'
  return Boolean(req.socket?.encrypted)
}

export function setCookie(req, res, name, value, maxAgeSeconds) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (maxAgeSeconds > 0) parts.push(`Max-Age=${Math.floor(maxAgeSeconds)}`)
  else parts.push('Max-Age=0')
  if (isSecureRequest(req)) parts.push('Secure')
  appendHeader(res, 'Set-Cookie', parts.join('; '))
}

export function clearCookie(req, res, name) {
  setCookie(req, res, name, '', 0)
}

function appendHeader(res, name, value) {
  const existing = res.getHeader(name)
  if (existing == null) {
    res.setHeader(name, value)
    return
  }
  res.setHeader(name, Array.isArray(existing) ? [...existing, value] : [existing, value])
}

export function getClientIp(req, trustProxy = process.env.GIP_TRUST_PROXY === '1') {
  const remote = req.socket?.remoteAddress || 'unknown'
  if (!trustProxy) return remote

  // 只在管理员明确声明前置代理可信时读取代理头。优先使用反代覆盖写入的 X-Real-IP；
  // X-Forwarded-For 取最右一跳，避免客户端在最左侧塞入伪造地址绕过限流。
  const real = String(req.headers['x-real-ip'] ?? '').trim()
  if (real) return real
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return forwarded.at(-1) || remote
}
