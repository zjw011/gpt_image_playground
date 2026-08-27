#!/usr/bin/env node
// GPT Image Playground 后端服务：
// - /admin        后台管理页（管理员口令）
// - /api/admin/*  渠道与站点管理接口
// - /api/bootstrap /api/session  访客引导与口令门禁
// - /api/relay/:channelId/*      凭据注入中继（访客看不到地址与密钥）
// - 其余路径      托管 dist/ 静态前端

import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { handleAdminRoute } from './lib/adminRoutes.mjs'
import { handleGuestRoute } from './lib/guestRoutes.mjs'
import { clearCookie, getClientIp, HttpError, parseCookies, readJsonBody, sendError, sendJson, sendText, setCookie } from './lib/http.mjs'
import { getLockRemainingSeconds, isLocked, recordFailure, recordSuccess } from './lib/rateLimit.mjs'
import { ADMIN_COOKIE, createSession, destroySession, destroySessionsByRole, getSessionRole, GUEST_COOKIE } from './lib/sessions.mjs'
import { serveStatic } from './lib/staticFiles.mjs'
import { getConfig, hashPassword, initStore, updateConfig, verifyPassword } from './lib/store.mjs'

const serverDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(serverDir, '..')

const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '0.0.0.0'
const DATA_DIR = resolve(process.env.GIP_DATA_DIR ?? join(projectRoot, 'server-data'))
const DIST_DIR = resolve(process.env.GIP_DIST_DIR ?? join(projectRoot, 'dist'))
const ADMIN_DIR = join(serverDir, 'admin')

const config = initStore(DATA_DIR)

// 首次启动可用环境变量直接落初始口令，省掉手动初始化步骤。
if (!config.adminPasswordHash && process.env.GIP_ADMIN_PASSWORD) {
  const initial = process.env.GIP_ADMIN_PASSWORD
  if (initial.length < 8) {
    console.error('GIP_ADMIN_PASSWORD 至少需要 8 个字符，已忽略。')
  } else {
    updateConfig((next) => {
      next.adminPasswordHash = hashPassword(initial)
      return next
    })
    console.log('已使用 GIP_ADMIN_PASSWORD 初始化管理员口令。')
  }
}

if (!getConfig().guestPasswordHash && process.env.GIP_GUEST_PASSWORD) {
  const initial = process.env.GIP_GUEST_PASSWORD
  if (initial.length < 8) {
    console.error('GIP_GUEST_PASSWORD 至少需要 8 个字符，已忽略。')
  } else {
    updateConfig((next) => {
      next.guestPasswordHash = hashPassword(initial)
      next.site.guestGateEnabled = true
      return next
    })
    console.log('已使用 GIP_GUEST_PASSWORD 初始化访客口令并开启门禁。')
  }
}

/** 管理接口与登录一律要求同源，阻断跨站表单/脚本触发的写操作。 */
function assertSameOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return
  const origin = req.headers.origin
  if (!origin) return
  const host = req.headers.host
  try {
    if (new URL(origin).host !== host) throw new HttpError(403, '跨站请求已被拒绝')
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(403, 'Origin 头无效')
  }
}

async function handleAdminLogin(req, res) {
  const ip = getClientIp(req)
  const key = `admin:${ip}`
  if (isLocked(key)) throw new HttpError(429, `尝试次数过多，请 ${getLockRemainingSeconds(key)} 秒后重试`)

  const body = await readJsonBody(req)
  const password = String(body.password ?? '')
  const current = getConfig()

  // 首次初始化：没有管理员口令时，第一个设置口令的人成为管理员。
  if (!current.adminPasswordHash) {
    if (password.length < 8) throw new HttpError(400, '管理员口令至少 8 个字符')
    updateConfig((next) => {
      next.adminPasswordHash = hashPassword(password)
      return next
    })
    const session = createSession('admin')
    setCookie(req, res, ADMIN_COOKIE, session.token, session.maxAgeSeconds)
    recordSuccess(key)
    return sendJson(res, 200, { ok: true, initialized: true })
  }

  if (!verifyPassword(password, current.adminPasswordHash)) {
    recordFailure(key)
    throw new HttpError(401, '管理员口令不正确')
  }

  const session = createSession('admin')
  setCookie(req, res, ADMIN_COOKIE, session.token, session.maxAgeSeconds)
  recordSuccess(key)
  return sendJson(res, 200, { ok: true })
}

async function handleGuestLogin(req, res, password) {
  const ip = getClientIp(req)
  const key = `guest:${ip}`
  if (isLocked(key)) throw new HttpError(429, `尝试次数过多，请 ${getLockRemainingSeconds(key)} 秒后重试`)

  const current = getConfig()
  if (!current.site.guestGateEnabled) return sendJson(res, 200, { ok: true, gateDisabled: true })
  if (!current.guestPasswordHash) throw new HttpError(503, '管理员尚未设置访问口令')

  if (!verifyPassword(password, current.guestPasswordHash)) {
    recordFailure(key)
    throw new HttpError(401, '访问口令不正确')
  }

  const session = createSession('guest')
  setCookie(req, res, GUEST_COOKIE, session.token, session.maxAgeSeconds)
  recordSuccess(key)
  return sendJson(res, 200, { ok: true })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  const cookies = parseCookies(req.headers.cookie)
  const adminRole = getSessionRole(cookies[ADMIN_COOKIE])
  const guestRole = getSessionRole(cookies[GUEST_COOKIE])

  try {
    if (path === '/api/admin/login') {
      assertSameOrigin(req)
      if (req.method !== 'POST') throw new HttpError(405, '方法不允许')
      return await handleAdminLogin(req, res)
    }

    if (path === '/api/admin/logout') {
      assertSameOrigin(req)
      destroySession(cookies[ADMIN_COOKIE])
      clearCookie(req, res, ADMIN_COOKIE)
      return sendJson(res, 200, { ok: true })
    }

    if (path.startsWith('/api/admin/')) {
      assertSameOrigin(req)
      return await handleAdminRoute(req, res, {
        path,
        search: url.search,
        role: adminRole,
        onPasswordChanged: (target) => {
          if (target === 'admin') {
            // 保留当前管理员会话，只踢掉其他会话。
            const token = cookies[ADMIN_COOKIE]
            destroySessionsByRole('admin')
            if (token) {
              const session = createSession('admin')
              setCookie(req, res, ADMIN_COOKIE, session.token, session.maxAgeSeconds)
            }
            return
          }
          destroySessionsByRole('guest')
        },
      })
    }

    if (path.startsWith('/api/')) {
      if (path === '/api/session') assertSameOrigin(req)
      return await handleGuestRoute(req, res, {
        path,
        search: url.search,
        role: adminRole === 'admin' ? 'admin' : guestRole,
        loginGuest: (password) => handleGuestLogin(req, res, password),
        logoutGuest: () => {
          destroySession(cookies[GUEST_COOKIE])
          clearCookie(req, res, GUEST_COOKIE)
          return sendJson(res, 200, { ok: true })
        },
      })
    }

    // 后台管理页
    if (path === '/admin' || path === '/admin/') {
      return serveStatic(res, ADMIN_DIR, '/index.html', { spaFallback: true })
    }
    if (path.startsWith('/admin/')) {
      if (serveStatic(res, ADMIN_DIR, path.slice('/admin'.length), { spaFallback: true })) return
      return sendText(res, 404, '未找到')
    }

    if (!existsSync(DIST_DIR)) {
      return sendText(
        res,
        503,
        '前端产物不存在。请先在项目根目录运行 npm run build，或用 GIP_DIST_DIR 指向已构建的 dist 目录。',
      )
    }

    if (serveStatic(res, DIST_DIR, path, { spaFallback: true })) return
    return sendText(res, 404, '未找到')
  } catch (err) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    if (err instanceof HttpError) return sendError(res, err.status, err.message)
    console.error('请求处理失败：', err)
    return sendError(res, 502, err instanceof Error ? err.message : '服务器内部错误')
  }
})

// 出图请求可能是 512MB 级 multipart，且长时间无字节返回，关闭默认超时交由渠道 timeout 控制。
server.requestTimeout = 0
server.headersTimeout = 65_000
server.timeout = 0

server.listen(PORT, HOST, () => {
  console.log(`GPT Image Playground 服务已启动：http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`)
  console.log(`后台管理：http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/admin`)
  console.log(`配置目录：${DATA_DIR}`)
  console.log(`前端产物：${DIST_DIR}${existsSync(DIST_DIR) ? '' : '（不存在，需先 npm run build）'}`)
  if (!getConfig().adminPasswordHash) console.log('尚未设置管理员口令，首次访问 /admin 时设置。')
})
