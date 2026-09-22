// 访客接口 + 凭据注入中继。
// 访客永远拿不到 baseUrl 与 apiKey：前端只知道渠道 id，请求打到 /api/relay/<id>/...，
// 由 relay.mjs 补上真实地址和 Authorization，并在渠道之间静默做故障转移。

import { addCredits, userCreditsView } from './credits.mjs'
import { redeemCard } from './cards.mjs'
import { getClientIp, HttpError, readJsonBody, sendJson } from './http.mjs'
import { isLocked, getLockRemainingSeconds, recordFailure, recordSuccess } from './rateLimit.mjs'
import { handleRelay } from './relay.mjs'
import { getConfig, getEnabledChannels, inviteStatus, isSmtpConfigured, toPublicChannel } from './store.mjs'
import { handleWechatCallback, pollWechatLogin, serveFixedQrcode, serveSceneQrcode, startWechatLogin } from './wechatRoutes.mjs'

/** 共享工作区标识：open / passcode 模式下所有人同一个本地仓库。 */
const SHARED_WORKSPACE_ID = 'shared'

/** 需要"有身份"才算登录的模式。 */
function requiresAccount(accessMode) {
  return accessMode === 'accounts' || accessMode === 'wechat'
}

export function getWorkspaceId(accessMode, user) {
  // 用户 id 本身就以 u- 开头，直接用它当工作区名，不再叠前缀。
  return requiresAccount(accessMode) && user ? user.id : SHARED_WORKSPACE_ID
}

/**
 * 积分开关的公开投影。管理员没开积分制时前端完全看不到相关入口。
 * signupBonus 是故意公开的：它是登录页最有效的拉新文案（"注册即送 50 积分"），
 * 本身也不是什么秘密——任何人注册一次就知道了。
 */
function publicCredits(site) {
  return {
    enabled: site.credits.enabled,
    costPerImage: site.credits.costPerImage,
    signupBonus: site.credits.enabled ? site.credits.signupBonus : 0,
    purchaseUrl: site.credits.purchaseUrl,
    packs: site.credits.packs,
  }
}

export async function handleGuestRoute(req, res, ctx) {
  const config = getConfig()
  const accessMode = config.site.accessMode

  // 微信登录相关的接口必须在门禁之外——它们就是用来穿过门禁的。
  if (ctx.path.startsWith('/api/wechat/')) {
    return handleWechatRoute(req, res, ctx, accessMode)
  }

  const gateOpen = accessMode === 'open'
    || ctx.role === 'admin'
    || (accessMode === 'passcode' && ctx.role === 'guest')
    || (requiresAccount(accessMode) && ctx.role === 'guest' && Boolean(ctx.user))

  if (ctx.path === '/api/bootstrap' && req.method === 'GET') {
    return sendJson(res, 200, {
      backendMode: true,
      initialized: Boolean(config.adminPasswordHash),
      accessMode,
      guestPasswordSet: Boolean(config.guestPasswordHash),
      userCount: config.users.filter((user) => user.enabled).length,
      authenticated: gateOpen,
      user: ctx.user
        ? {
            id: ctx.user.id,
            username: ctx.user.username,
            displayName: ctx.user.wechatNickname || ctx.user.displayName || ctx.user.username,
            avatar: ctx.user.wechatAvatar || '',
            email: ctx.user.email || '',
          }
        : null,
      workspaceId: getWorkspaceId(accessMode, ctx.user),
      // 注册入口是否可见。只回传"能不能注册"和"要不要邀请码"，邀请码本身不下发。
      registrationOpen: accessMode === 'accounts' && inviteStatus(config.site).ok,
      // 自助注册还依赖"能发验证码"这一条。没配 SMTP 时前端要把注册入口关掉并说明原因，
      // 而不是让用户填完表单才在最后一步撞 503。
      registration: {
        enabled: accessMode === 'accounts' && inviteStatus(config.site).ok,
        requireInviteCode: config.site.requireInviteCode,
        emailVerification: isSmtpConfigured(config.site.smtp) && config.site.smtp.enabled,
      },
      credits: publicCredits(config.site),
      // 登录页需要知道的：用哪种方式、要不要显示二维码。凭据一律不下发。
      wechat: {
        enabled: config.site.wechat.enabled,
        loginMode: config.site.wechat.loginMode,
        hasQrcodeImage: Boolean(config.site.wechat.qrcodeImage),
      },
      site: {
        title: config.site.title,
        failoverEnabled: config.site.failoverEnabled,
        failoverMaxAttempts: config.site.failoverMaxAttempts,
        allowGuestParamOverride: config.site.allowGuestParamOverride,
        // Agent 也由后台总控：前端只拿到「用哪条渠道」，拿不到地址和密钥。
        agentMode: config.site.agentMode,
        agentTextChannelId: config.site.agentTextChannelId,
        agentImageChannelId: config.site.agentImageChannelId,
        agentMaxToolRounds: config.site.agentMaxToolRounds,
        agentWebSearch: config.site.agentWebSearch,
      },
      ...(gateOpen
        ? {
            channels: getEnabledChannels().map(toPublicChannel),
            customProviders: config.customProviders,
          }
        : {}),
      // 登录后顺带把余额下发，省掉前端启动时再打一次。
      ...(gateOpen && config.site.credits.enabled && ctx.user
        ? { credits: { ...publicCredits(config.site), ...userCreditsView(ctx.user.id) } }
        : {}),
    })
  }

  if (ctx.path === '/api/session' && req.method === 'POST') {
    const body = await readJsonBody(req)
    return ctx.login({ username: String(body.username ?? ''), password: String(body.password ?? '') })
  }

  if (ctx.path === '/api/session' && req.method === 'DELETE') {
    return ctx.logout()
  }

  if (ctx.path === '/api/register' && req.method === 'POST') {
    const body = await readJsonBody(req)
    return ctx.register({
      username: String(body.username ?? ''),
      password: String(body.password ?? ''),
      email: String(body.email ?? ''),
      code: String(body.code ?? ''),
      inviteCode: String(body.inviteCode ?? ''),
    })
  }

  // ===== 邮箱验证码 =====

  if (ctx.path === '/api/auth/email-code' && req.method === 'POST') {
    const body = await readJsonBody(req)
    return ctx.sendEmailCode({
      email: String(body.email ?? ''),
      purpose: body.purpose === 'reset' ? 'reset' : 'register',
    })
  }

  if (ctx.path === '/api/auth/reset-password' && req.method === 'POST') {
    const body = await readJsonBody(req)
    return ctx.resetPassword({
      email: String(body.email ?? ''),
      code: String(body.code ?? ''),
      password: String(body.password ?? ''),
    })
  }

  // ===== 积分 =====

  if (ctx.path === '/api/credits' && req.method === 'GET') {
    if (!config.site.credits.enabled) throw new HttpError(404, '本站未启用积分制')
    if (!ctx.user) throw new HttpError(401, '请先登录')
    return sendJson(res, 200, userCreditsView(ctx.user.id, 60))
  }

  if (ctx.path === '/api/credits/redeem' && req.method === 'POST') {
    if (!config.site.credits.enabled) throw new HttpError(404, '本站未启用积分制')
    if (!ctx.user) throw new HttpError(401, '请先登录后再兑换')

    // 卡密是可爆破的秘密（虽然有 60 bit 空间），跟登录共用"10 分钟 10 次"的限流桶。
    const ip = getClientIp(req)
    const key = `redeem:${ip}`
    if (isLocked(key)) throw new HttpError(429, `尝试次数过多，请 ${getLockRemainingSeconds(key)} 秒后重试`)

    const body = await readJsonBody(req)
    const result = redeemCard(body.code, ctx.user.id)
    if (!result.ok) {
      recordFailure(key)
      throw new HttpError(400, result.message)
    }
    recordSuccess(key)

    addCredits(ctx.user.id, result.credits, { type: 'redeem', ref: result.code, note: '卡密兑换' })
    return sendJson(res, 200, {
      ok: true,
      credited: result.credits,
      ...userCreditsView(ctx.user.id, 60),
    })
  }

  if (ctx.path.startsWith('/api/relay/')) {
    if (!gateOpen) throw new HttpError(401, accessMode === 'accounts' || accessMode === 'wechat' ? '需要登录' : '需要访问口令')
    return handleRelay(req, res, ctx)
  }

  throw new HttpError(404, '未知接口')
}

/** 微信登录相关的路由。这些接口本身不需要身份，它们的作用就是拿到身份。 */
async function handleWechatRoute(req, res, ctx, accessMode) {
  const config = getConfig()

  if (!config.site.wechat.enabled) throw new HttpError(503, '本站未启用微信登录')

  if (ctx.path === '/api/wechat/login' && req.method === 'POST') {
    if (accessMode !== 'wechat') throw new HttpError(403, '当前站点不是微信登录模式')
    const ip = getClientIp(req)
    const key = `wechat-login:${ip}`
    if (isLocked(key)) throw new HttpError(429, `操作过于频繁，请 ${getLockRemainingSeconds(key)} 秒后重试`)
    // 发起登录本身不算失败，不计入限流桶；限流桶留给"验证码猜错"这类失败。
    recordSuccess(key)
    return startWechatLogin(req, res)
  }

  if (ctx.path === '/api/wechat/login' && req.method === 'GET') {
    return pollWechatLogin(req, res, ctx)
  }

  // 公众号的固定二维码图片（验证码模式下显示给用户扫）。
  if (ctx.path === '/api/wechat/qr-image' && req.method === 'GET') {
    return serveFixedQrcode(res)
  }

  const sceneMatch = ctx.path.match(/^\/api\/wechat\/qr\/([^/]+)\.png$/)
  if (sceneMatch && req.method === 'GET') {
    return serveSceneQrcode(res, decodeURIComponent(sceneMatch[1]))
  }

  // 微信服务器的校验与事件推送。既不要求同源也不要求登录——
  // 请求来自微信的服务器，它没有我们的 cookie。
  if (ctx.path === '/api/wechat/callback') {
    return handleWechatCallback(req, res, ctx)
  }

  throw new HttpError(404, '未知接口')
}
