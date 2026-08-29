// 访客接口 + 凭据注入中继。
// 访客永远拿不到 baseUrl 与 apiKey：前端只知道渠道 id，请求打到 /api/relay/<id>/...，
// 由这里补上真实地址和 Authorization 再转发。

import { HttpError, readJsonBody, sendJson } from './http.mjs'
import { findChannel, getConfig, getEnabledChannels, inviteStatus, toPublicChannel } from './store.mjs'
import { buildUpstreamUrl, pipeToUpstream } from './upstream.mjs'
import { recordChannelCall } from './usage.mjs'

const FAL_TARGET_URL_HEADER = 'x-fal-target-url'
const FAL_ALLOWED_HOSTS = /(^|\.)(fal\.run|fal\.ai)$/

/** 共享工作区标识：open / passcode 模式下所有人同一个本地仓库。 */
const SHARED_WORKSPACE_ID = 'shared'

export function getWorkspaceId(accessMode, user) {
  // 用户 id 本身就以 u- 开头，直接用它当工作区名，不再叠前缀。
  return accessMode === 'accounts' && user ? user.id : SHARED_WORKSPACE_ID
}

export async function handleGuestRoute(req, res, ctx) {
  const config = getConfig()
  const accessMode = config.site.accessMode
  const gateOpen = accessMode === 'open'
    || ctx.role === 'admin'
    || (accessMode === 'passcode' && ctx.role === 'guest')
    || (accessMode === 'accounts' && ctx.role === 'guest' && Boolean(ctx.user))

  if (ctx.path === '/api/bootstrap' && req.method === 'GET') {
    return sendJson(res, 200, {
      backendMode: true,
      initialized: Boolean(config.adminPasswordHash),
      accessMode,
      guestPasswordSet: Boolean(config.guestPasswordHash),
      userCount: config.users.filter((user) => user.enabled).length,
      authenticated: gateOpen,
      user: ctx.user ? { id: ctx.user.id, username: ctx.user.username, displayName: ctx.user.displayName } : null,
      workspaceId: getWorkspaceId(accessMode, ctx.user),
      // 注册入口是否可见。只回传"能不能注册"，邀请码本身不下发——它得由管理员另行转达。
      registrationOpen: accessMode === 'accounts' && inviteStatus(config.site).ok,
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
      inviteCode: String(body.inviteCode ?? ''),
    })
  }

  if (ctx.path.startsWith('/api/relay/')) {
    if (!gateOpen) throw new HttpError(401, accessMode === 'accounts' ? '需要登录' : '需要访问口令')
    return relayToChannel(req, res, ctx)
  }

  throw new HttpError(404, '未知接口')
}

async function relayToChannel(req, res, ctx) {
  const rest = ctx.path.slice('/api/relay/'.length)
  const slash = rest.indexOf('/')
  const channelId = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash))
  const endpointPath = slash < 0 ? '' : rest.slice(slash + 1)

  const channel = findChannel(channelId)
  if (!channel) throw new HttpError(404, '渠道不存在或已下线')
  if (!channel.enabled) throw new HttpError(503, `渠道「${channel.name}」已停用`)
  if (!channel.apiKey) throw new HttpError(503, `渠道「${channel.name}」未配置 API Key`)

  const timeoutMs = Math.max(10_000, channel.timeout * 1000)
  // 只统计提交请求。异步渠道的轮询是 GET，一次出图能轮几十次，全记会把成功率算歪。
  const counted = req.method === 'POST'
  const started = Date.now()
  // 访客提前断开（点了停止、关了标签页）会让转发以失败结算，但这跟渠道好坏无关。
  let clientGone = false
  res.on('close', () => {
    if (!res.writableEnded) clientGone = true
  })
  const track = (ok, status, error) => {
    if (!counted) return
    recordChannelCall({
      channelId,
      userId: ctx.user?.id ?? '',
      ok,
      status,
      latencyMs: Date.now() - started,
      at: started,
      error,
      aborted: !ok && clientGone,
    })
  }

  try {
    const result = channel.provider === 'fal'
      // fal SDK 的 proxyUrl 机制：真实目标放在 x-fal-target-url 头里。目标头已被消费，不能再往上游传。
      ? await pipeToUpstream(req, res, {
          upstreamUrl: resolveFalTargetUrl(req, channel),
          authHeader: `Key ${channel.apiKey}`,
          timeoutMs,
          dropHeaders: [FAL_TARGET_URL_HEADER],
        })
      : await (() => {
          if (!endpointPath) throw new HttpError(400, '缺少上游接口路径')
          return pipeToUpstream(req, res, {
            upstreamUrl: buildUpstreamUrl(channel.baseUrl, endpointPath, ctx.search ?? ''),
            authHeader: `Bearer ${channel.apiKey}`,
            timeoutMs,
          })
        })()

    const status = result?.status ?? 0
    track(status >= 200 && status < 300, status, status >= 200 && status < 300 ? '' : `上游返回 HTTP ${status}`)
    return result
  } catch (err) {
    track(false, 0, err instanceof Error ? err.message : '转发失败')
    throw err
  }
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
