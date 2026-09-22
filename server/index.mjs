#!/usr/bin/env node
// 绘想后端服务：
// - /admin        后台管理页（管理员口令）
// - /api/admin/*  渠道与站点管理接口
// - /api/bootstrap /api/session  访客引导与口令门禁
// - /api/relay/:channelId/*      凭据注入中继（访客看不到地址与密钥）
// - 其余路径      托管 dist/ 静态前端

import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { handleAdminRoute } from './lib/adminRoutes.mjs'
import { initCards } from './lib/cards.mjs'
import { initCredits, grantSignupBonus } from './lib/credits.mjs'
import {
  cancelEmailCode,
  issueEmailCode,
  normalizeEmail,
  verifyEmailCode,
} from './lib/emailCodes.mjs'
import { handleGuestRoute } from './lib/guestRoutes.mjs'
import { clearCookie, getClientIp, HttpError, parseCookies, readJsonBody, sendError, sendJson, sendText, setCookie } from './lib/http.mjs'
import { getLockRemainingSeconds, isLocked, recordFailure, recordSuccess } from './lib/rateLimit.mjs'
import {
  ADMIN_COOKIE,
  createSession,
  destroySession,
  destroySessionsByRole,
  destroySessionsByUser,
  getSession,
  GUEST_COOKIE,
} from './lib/sessions.mjs'
import { describeSmtpError, sendMail } from './lib/smtp.mjs'
import { serveStatic } from './lib/staticFiles.mjs'
import {
  findUserByEmail,
  findUserById,
  findUserByUsername,
  getConfig,
  hashPassword,
  initStore,
  inviteStatus,
  isSmtpConfigured,
  isValidUsername,
  MIN_USER_PASSWORD_LENGTH,
  normalizeInviteCode,
  normalizeUser,
  updateConfig,
  verifyPassword,
} from './lib/store.mjs'
import { flushUsage, initUsage } from './lib/usage.mjs'

const serverDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(serverDir, '..')

const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '0.0.0.0'
const DATA_DIR = resolve(process.env.GIP_DATA_DIR ?? join(projectRoot, 'server-data'))
const DIST_DIR = resolve(process.env.GIP_DIST_DIR ?? join(projectRoot, 'dist'))
const ADMIN_DIR = join(serverDir, 'admin')

const config = initStore(DATA_DIR)
initUsage(DATA_DIR)
initCredits(DATA_DIR)
initCards(DATA_DIR)

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
  if (initial.length < MIN_USER_PASSWORD_LENGTH) {
    console.error(`GIP_GUEST_PASSWORD 至少需要 ${MIN_USER_PASSWORD_LENGTH} 个字符，已忽略。`)
  } else {
    updateConfig((next) => {
      next.guestPasswordHash = hashPassword(initial)
      next.site.accessMode = 'passcode'
      return next
    })
    console.log('已使用 GIP_GUEST_PASSWORD 初始化访客口令并切换到共享口令模式。')
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

/**
 * 需要同源校验的访客接口白名单。
 * 用白名单而不是"全部要求同源"，是因为 /api/wechat/callback 必须放行——
 * 它由微信的服务器直接 POST 过来，永远不可能带上我们的 Origin。
 */
const SAME_ORIGIN_API_PATHS = new Set([
  '/api/session',
  '/api/register',
  '/api/auth/email-code',
  '/api/auth/reset-password',
  '/api/credits/redeem',
  '/api/wechat/login',
])

// ===== 邮箱验证码 =====

/** 把后台那份 SMTP 配置转成 smtp.mjs 的入参。发件人昵称缺省用站点名。 */
function smtpSendOptions(smtp) {
  return {
    host: smtp.host,
    port: smtp.port,
    encryption: smtp.encryption,
    user: smtp.user,
    password: smtp.password,
    from: smtp.from,
    fromName: smtp.fromName || getConfig().site.title,
    allowUnauthorized: smtp.allowUnauthorized,
  }
}

/**
 * 验证码邮件的正文。
 *
 * 纯文本和 HTML 两份都给：纯文本是给反垃圾系统看的（只有 HTML 的邮件更容易被判垃圾），
 * HTML 是给人看的。验证码在两边都是纯文本，不做图片——图片里的码没法复制，
 * 而且带图的邮件更容易被拦。
 */
function buildVerificationEmail({ title, code, purpose, ttlMinutes }) {
  const action = purpose === 'reset' ? '重置密码' : '注册账号'
  const subject = `【${title}】${action}验证码 ${code}`
  const warn = purpose === 'reset'
    ? '如果你没有申请重置密码，说明有人误填了你的邮箱，可以忽略本邮件。'
    : '如果你没有申请注册，可以忽略本邮件，你的邮箱不会被使用。'

  const text = [
    `${action}验证码：${code}`,
    '',
    `验证码 ${ttlMinutes} 分钟内有效，请勿转发给任何人。`,
    warn,
    '',
    `—— ${title}`,
  ].join('\n')

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#1f2329">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:14px;padding:32px 28px">
    <p style="margin:0 0 4px;font-size:20px;font-weight:600">${escapeHtml(title)}</p>
    <p style="margin:0 0 24px;font-size:14px;color:#8a9099">${action}验证码</p>
    <div style="background:#f5f6f8;border-radius:10px;padding:18px 0;text-align:center">
      <span style="font-size:34px;font-weight:700;letter-spacing:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${code}</span>
    </div>
    <p style="margin:20px 0 0;font-size:14px;color:#5c6169">验证码 ${ttlMinutes} 分钟内有效，请勿转发给任何人。</p>
    <p style="margin:8px 0 0;font-size:13px;color:#8a9099">${escapeHtml(warn)}</p>
    <hr style="border:none;border-top:1px solid #eceef1;margin:24px 0">
    <p style="margin:0;font-size:13px;color:#8a9099">${escapeHtml(title)}</p>
  </div>
</body></html>`

  return { subject, text, html }
}

/** 邮件正文里的插值全部转义：站点名是管理员填的，没理由让它能注入 HTML。 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 签发失败的原因 → 给用户看的话。 */
function emailCodeErrorMessage(result) {
  switch (result.reason) {
    case 'cooldown':
      return `${result.retryAfterSeconds} 秒后可重新获取验证码`
    case 'daily-limit':
      return '该邮箱今天获取验证码的次数已达上限，请明天再试'
    case 'ip-limit':
      return '操作过于频繁，请稍后再试'
    default:
      return '邮箱地址不正确'
  }
}

/** 校验失败的原因 → 给用户看的话。统一成一句话，不告诉对方猜错了几次。 */
function verifyCodeErrorMessage(reason) {
  switch (reason) {
    case 'expired':
      return '验证码已过期，请重新获取'
    case 'too-many-attempts':
      return '错误次数过多，验证码已失效，请重新获取'
    default:
      return '验证码不正确，请核对后重试'
  }
}

/**
 * 发送邮箱验证码。
 *
 * 这个接口不要求登录，所以它是全网可达的——限流必须做在三层上（见 emailCodes.mjs）。
 * 另外它也是唯一一个能让服务器主动往外发信的口子，所以：
 *   · 对外永远只说"发出去了 / 频率太高"，绝不回显验证码；
 *   · 发信失败的**真实原因**只写进服务端日志，给用户一句模糊的提示。
 *     否则任何人都能通过这个接口把我们 SMTP 的错误信息（甚至服务器地址）读出来。
 */
async function handleEmailCode(req, res, input) {
  const ip = getClientIp(req)
  const current = getConfig()
  const site = current.site

  const purpose = input.purpose === 'reset' ? 'reset' : 'register'

  if (purpose === 'register') {
    if (site.accessMode !== 'accounts') throw new HttpError(403, '本站未开放账号注册')
    const status = inviteStatus(site)
    if (!status.ok) throw new HttpError(403, '本站未开放自助注册')
  }

  if (!isSmtpConfigured(site.smtp) || !site.smtp.enabled) {
    throw new HttpError(503, '本站尚未配置邮件发信，暂时无法发送验证码，请联系管理员')
  }

  const email = normalizeEmail(input.email)
  if (!email) throw new HttpError(400, '请输入有效的邮箱地址')

  // 注册路径可以直说"这个邮箱已经注册过"——不说的话用户会卡在最后一步反复重试。
  // 重置密码路径则绝不能承认邮箱是否存在，否则这里就成了一个邮箱探测接口。
  if (purpose === 'register' && findUserByEmail(email)) {
    throw new HttpError(409, '该邮箱已被注册，请直接登录或找回密码')
  }

  const issued = issueEmailCode({
    email,
    purpose,
    ip,
    dailyPerEmail: site.smtp.dailyLimitPerEmail,
    hourlyPerIp: site.smtp.hourlyLimitPerIp,
  })
  if (!issued.ok) throw new HttpError(429, emailCodeErrorMessage(issued))

  const target = purpose === 'reset' ? findUserByEmail(email) : null
  // 重置密码时账号不存在：配额已经扣了（让响应时序与存在时一致），但信不发。
  if (purpose === 'reset' && !target) {
    return sendJson(res, 200, {
      ok: true,
      resendAfterSeconds: issued.resendAfterSeconds,
      ttlSeconds: issued.ttlSeconds,
    })
  }

  const mail = buildVerificationEmail({
    title: site.title,
    code: issued.code,
    purpose,
    ttlMinutes: Math.round(issued.ttlSeconds / 60),
  })

  try {
    await sendMail({ ...smtpSendOptions(site.smtp), to: email, ...mail })
  } catch (error) {
    // 发信失败要把配额退回去，否则 SMTP 配错的那一天里用户会一次次白耗额度。
    cancelEmailCode({ email, purpose, ip })
    console.error(`[mail] 向 ${email} 发送验证码失败：${describeSmtpError(error)}`)
    throw new HttpError(502, '验证码发送失败，请稍后重试；若持续失败请联系管理员')
  }

  return sendJson(res, 200, {
    ok: true,
    resendAfterSeconds: issued.resendAfterSeconds,
    ttlSeconds: issued.ttlSeconds,
  })
}

/**
 * 用邮箱验证码重置密码。
 * 不自动登录：重置密码是一个"凭证可能已经泄露"的场景，让用户拿新密码重新登一次，
 * 能顺带确认新密码是对的。
 */
async function handleResetPassword(req, res, input) {
  const ip = getClientIp(req)
  const key = `guest:${ip}`
  if (isLocked(key)) throw new HttpError(429, `尝试次数过多，请 ${getLockRemainingSeconds(key)} 秒后重试`)

  const password = String(input.password ?? '')
  if (password.length < MIN_USER_PASSWORD_LENGTH) {
    throw new HttpError(400, `新口令至少 ${MIN_USER_PASSWORD_LENGTH} 个字符`)
  }

  const email = normalizeEmail(input.email)
  const user = email ? findUserByEmail(email) : null

  // 邮箱不存在和验证码错到不了区分：统一一句话，避免这里变成邮箱探测接口。
  const verified = user
    ? verifyEmailCode({ email, purpose: 'reset', code: input.code })
    : { ok: false }
  if (!verified.ok) {
    recordFailure(key)
    throw new HttpError(400, verified.reason ? verifyCodeErrorMessage(verified.reason) : '验证码不正确或已失效，请重新获取')
  }

  updateConfig((config) => {
    const idx = config.users.findIndex((item) => item.id === user.id)
    if (idx >= 0) {
      config.users[idx] = {
        ...config.users[idx],
        passwordHash: hashPassword(password),
        updatedAt: Date.now(),
      }
    }
    return config
  })

  // 密码变了，旧会话必须全部作废，否则被盗号的人还能继续用旧 cookie。
  destroySessionsByUser(user.id)
  recordSuccess(key)
  return sendJson(res, 200, { ok: true, username: user.username })
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

/**
 * 前台登录：passcode 模式只校验共享口令，accounts 模式校验用户名 + 该用户口令。
 * 两种模式共用同一个 cookie，会话里的 userId 决定前端落到哪个工作区。
 */async function handleFrontLogin(req, res, credentials) {
  const ip = getClientIp(req)
  const key = `guest:${ip}`
  if (isLocked(key)) throw new HttpError(429, `尝试次数过多，请 ${getLockRemainingSeconds(key)} 秒后重试`)

  const current = getConfig()
  const mode = current.site.accessMode
  if (mode === 'open') return sendJson(res, 200, { ok: true, gateDisabled: true })
  // 微信登录模式没有口令入口：身份只能由扫码产生。
  if (mode === 'wechat') throw new HttpError(403, '本站使用微信扫码登录，请扫码进入')

  if (mode === 'accounts') {
    const user = findUserByUsername(credentials.username)
    // 用户不存在与口令错误返回同一句话，避免后台用户名被逐个探测出来。
    if (!user || !user.passwordHash || !verifyPassword(credentials.password, user.passwordHash)) {
      recordFailure(key)
      throw new HttpError(401, '用户名或口令不正确')
    }
    if (!user.enabled) throw new HttpError(403, '该账号已被停用')

    updateConfig((config) => {
      const idx = config.users.findIndex((item) => item.id === user.id)
      if (idx >= 0) config.users[idx] = { ...config.users[idx], lastSeenAt: Date.now() }
      return config
    })

    const session = createSession('guest', user.id)
    setCookie(req, res, GUEST_COOKIE, session.token, session.maxAgeSeconds)
    recordSuccess(key)
    return sendJson(res, 200, {
      ok: true,
      user: { id: user.id, username: user.username, displayName: user.displayName },
      workspaceId: user.id,
    })
  }

  if (!current.guestPasswordHash) throw new HttpError(503, '管理员尚未设置访问口令')
  if (!verifyPassword(credentials.password, current.guestPasswordHash)) {
    recordFailure(key)
    throw new HttpError(401, '访问口令不正确')
  }

  const session = createSession('guest')
  setCookie(req, res, GUEST_COOKIE, session.token, session.maxAgeSeconds)
  recordSuccess(key)
  return sendJson(res, 200, { ok: true, workspaceId: 'shared' })
}

/**
 * 自助注册：凭邮箱验证码建账号并直接登录。
 *
 * 校验顺序是刻意排的——**邮箱验证码放在最后验**。
 * 验证码一验就作废，如果先验码再报"用户名已被占用"，用户改个名字回来发现码没了，
 * 得重新收一次邮件。所以所有不需要消耗验证码的检查都要排在前面。
 *
 * 与登录共用同一个限流桶：注册更值得防，它会真的往配置文件里写东西。
 */
async function handleRegister(req, res, input) {
  const ip = getClientIp(req)
  const key = `guest:${ip}`
  if (isLocked(key)) throw new HttpError(429, `尝试次数过多，请 ${getLockRemainingSeconds(key)} 秒后重试`)

  const current = getConfig()
  const site = current.site
  if (site.accessMode !== 'accounts') throw new HttpError(403, '本站未开放自助注册')

  const status = inviteStatus(site)
  if (!status.ok) {
    throw new HttpError(403, status.reason === 'expired'
      ? '邀请码已过期，请向管理员索取新的邀请码'
      : status.reason === 'exhausted'
        ? '邀请名额已用完，请向管理员索取新的邀请码'
        : '本站未开放自助注册')
  }

  // 邀请码现在是可选加码：默认不要求，要求时仍然必须对上。
  if (site.requireInviteCode && normalizeInviteCode(input.inviteCode) !== normalizeInviteCode(site.inviteCode)) {
    recordFailure(key)
    throw new HttpError(403, '邀请码不正确')
  }

  const email = normalizeEmail(input.email)
  if (!email) throw new HttpError(400, '请输入有效的邮箱地址')
  if (findUserByEmail(email)) throw new HttpError(409, '该邮箱已被注册，请直接登录')

  const username = String(input.username ?? '').trim()
  if (!isValidUsername(username)) {
    throw new HttpError(400, '用户名需为 2-32 位字母、数字、下划线、点或连字符，且以字母或数字开头')
  }
  if (findUserByUsername(username)) throw new HttpError(409, `用户名「${username}」已被占用`)

  const password = String(input.password ?? '')
  if (password.length < MIN_USER_PASSWORD_LENGTH) {
    throw new HttpError(400, `登录口令至少 ${MIN_USER_PASSWORD_LENGTH} 个字符`)
  }

  // 到这里为止所有可能让用户"改一下重试"的检查都过了，现在才动验证码。
  const verified = verifyEmailCode({ email, purpose: 'register', code: input.code })
  if (!verified.ok) {
    recordFailure(key)
    throw new HttpError(400, verifyCodeErrorMessage(verified.reason))
  }

  const now = Date.now()
  const id = `u-${now.toString(36)}-${randomBytes(3).toString('hex')}`
  updateConfig((config) => {
    config.users.push(normalizeUser({
      id,
      username,
      email,
      passwordHash: hashPassword(password),
      enabled: true,
      note: '邮箱注册',
      createdVia: 'email',
      emailVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    }, id))
    if (site.requireInviteCode) config.site.inviteUsedCount += 1
    return config
  })

  // 注册赠送只在新账号上发一次。放到建号之后，用户一登录就能看到余额。
  const bonus = getConfig().site.credits.signupBonus
  if (bonus > 0) grantSignupBonus(id, bonus, { ref: 'email' })

  const session = createSession('guest', id)
  setCookie(req, res, GUEST_COOKIE, session.token, session.maxAgeSeconds)
  recordSuccess(key)
  return sendJson(res, 200, {
    ok: true,
    user: { id, username, displayName: username, email },
    workspaceId: id,
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  const cookies = parseCookies(req.headers.cookie)
  const adminSession = getSession(cookies[ADMIN_COOKIE])
  const guestSession = getSession(cookies[GUEST_COOKIE])
  const adminRole = adminSession?.role ?? null
  // 会话里只存 userId，用户可能已被删除或停用，所以每次请求都重新解析。
  const sessionUser = guestSession?.userId ? findUserById(guestSession.userId) : null
  const activeUser = sessionUser?.enabled ? sessionUser : null

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
        onUserInvalidated: (userId) => destroySessionsByUser(userId),
      })
    }

    if (path.startsWith('/api/')) {
      // 会改状态、或会消耗资源的接口一律要求同源。
      // /api/wechat/callback 是例外——它由微信的服务器发起，不可能带我们的 Origin。
      if (SAME_ORIGIN_API_PATHS.has(path)) assertSameOrigin(req)
      return await handleGuestRoute(req, res, {
        path,
        search: url.search,
        role: adminRole === 'admin' ? 'admin' : guestSession?.role ?? null,
        user: activeUser,
        login: (credentials) => handleFrontLogin(req, res, credentials),
        register: (input) => handleRegister(req, res, input),
        sendEmailCode: (input) => handleEmailCode(req, res, input),
        resetPassword: (input) => handleResetPassword(req, res, input),
        logout: () => {
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
    if (err instanceof HttpError) return sendError(res, err.status, err.message, err.extra)
    console.error('请求处理失败：', err)
    return sendError(res, 502, err instanceof Error ? err.message : '服务器内部错误')
  }
})

// 出图请求可能是 512MB 级 multipart，且长时间无字节返回，关闭默认超时交由渠道 timeout 控制。
server.requestTimeout = 0
server.headersTimeout = 65_000
server.timeout = 0

server.listen(PORT, HOST, () => {
  console.log(`绘想服务已启动：http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`)
  console.log(`后台管理：http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/admin`)
  console.log(`配置目录：${DATA_DIR}`)
  console.log(`前端产物：${DIST_DIR}${existsSync(DIST_DIR) ? '' : '（不存在，需先 npm run build）'}`)
  if (!getConfig().adminPasswordHash) console.log('尚未设置管理员口令，首次访问 /admin 时设置。')
})

// 用量统计按 5 秒防抖落盘，退出前补一次，否则最后几条会丢。
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    flushUsage()
    server.close(() => process.exit(0))
    // 有长连接（SSE）挂着时 close 不会立刻回调，给 2 秒后强退。
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
