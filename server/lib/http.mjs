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

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf-8')
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
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
  constructor(status, message) {
    super(message)
    this.status = status
  }
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

export function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
  return forwarded || req.socket?.remoteAddress || 'unknown'
}
