// 会话：内存存储的随机令牌。重启即失效，符合"轻量口令门禁"的定位。
// 账号模式下会话还要记住 userId，中继与引导接口据此决定这个人属于哪个工作区。

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

export function createSession(role, userId = null) {
  prune()
  const token = randomBytes(32).toString('base64url')
  const ttl = role === 'admin' ? ADMIN_TTL_MS : GUEST_TTL_MS
  sessions.set(token, { role, userId, expiresAt: Date.now() + ttl })
  return { token, maxAgeSeconds: Math.floor(ttl / 1000) }
}

export function getSession(token) {
  if (!token) return null
  const session = sessions.get(token)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token)
    return null
  }
  return session
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

/**
 * 踢掉同角色的所有会话，但保留指定 token。
 *
 * 后台并入主前端后，管理员用的也是 guest cookie——如果照旧销毁全部 guest 会话，
 * 管理员改完口令会把自己一起踢下线（或者前台用户发现"改个共享口令我自己掉线了"）。
 * 所以"改口令"这类操作要显式保留操作者本人那一个会话。
 */
export function destroySessionsByRoleExcept(role, keepToken) {
  for (const [token, session] of sessions) {
    if (session.role === role && token !== keepToken) sessions.delete(token)
  }
}

/** 某个用户被停用、改密码或删除时，踢掉他所有设备上的会话。 */
export function destroySessionsByUser(userId) {
  if (!userId) return
  for (const [token, session] of sessions) {
    if (session.userId === userId) sessions.delete(token)
  }
}
