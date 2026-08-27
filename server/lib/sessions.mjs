// 会话：内存存储的签名令牌。重启即失效，符合"轻量口令门禁"的定位。

import { randomBytes } from 'node:crypto'

const ADMIN_TTL_MS = 12 * 60 * 60 * 1000
const GUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_SESSIONS = 5_000

export const ADMIN_COOKIE = 'gip_admin'
export const GUEST_COOKIE = 'gip_guest'

const sessions = new Map()

function prune() {
  const now = Date.now()
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token)
  }
  // 极端情况下按插入顺序淘汰最旧的，避免无限增长。
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value
    if (oldest == null) break
    sessions.delete(oldest)
  }
}

export function createSession(role) {
  prune()
  const token = randomBytes(32).toString('base64url')
  const ttl = role === 'admin' ? ADMIN_TTL_MS : GUEST_TTL_MS
  sessions.set(token, { role, expiresAt: Date.now() + ttl })
  return { token, maxAgeSeconds: Math.floor(ttl / 1000) }
}

export function getSessionRole(token) {
  if (!token) return null
  const session = sessions.get(token)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token)
    return null
  }
  return session.role
}

export function destroySession(token) {
  if (token) sessions.delete(token)
}

/** 口令被改动后，同角色的旧会话立即失效。 */
export function destroySessionsByRole(role) {
  for (const [token, session] of sessions) {
    if (session.role === role) sessions.delete(token)
  }
}
