// 访客接口 + 凭据注入中继。
// 访客永远拿不到 baseUrl 与 apiKey：前端只知道渠道 id，请求打到 /api/relay/<id>/...，
// 由这里补上真实地址和 Authorization 再转发。

import { HttpError, readJsonBody, sendJson } from './http.mjs'
import { findChannel, getConfig, getEnabledChannels, toPublicChannel } from './store.mjs'
import { buildUpstreamUrl, pipeToUpstream } from './upstream.mjs'

const FAL_TARGET_URL_HEADER = 'x-fal-target-url'
const FAL_ALLOWED_HOSTS = /(^|\.)(fal\.run|fal\.ai)$/

export async function handleGuestRoute(req, res, ctx) {
  const config = getConfig()
  const gateOpen = !config.site.guestGateEnabled || ctx.role === 'guest' || ctx.role === 'admin'

  if (ctx.path === '/api/bootstrap' && req.method === 'GET') {
    return sendJson(res, 200, {
      backendMode: true,
      initialized: Boolean(config.adminPasswordHash),
      guestGateEnabled: config.site.guestGateEnabled,
      guestPasswordSet: Boolean(config.guestPasswordHash),
      authenticated: gateOpen,
      site: {
        title: config.site.title,
        failoverEnabled: config.site.failoverEnabled,
        failoverMaxAttempts: config.site.failoverMaxAttempts,
        allowGuestParamOverride: config.site.allowGuestParamOverride,
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
    return ctx.loginGuest(String(body.password ?? ''))
  }

  if (ctx.path === '/api/session' && req.method === 'DELETE') {
    return ctx.logoutGuest()
  }

  if (ctx.path.startsWith('/api/relay/')) {
    if (!gateOpen) throw new HttpError(401, '需要访问口令')
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

  if (channel.provider === 'fal') {
    // fal SDK 的 proxyUrl 机制：真实目标放在 x-fal-target-url 头里。
    const upstreamUrl = resolveFalTargetUrl(req, channel)
    return pipeToUpstream(req, res, {
      upstreamUrl,
      authHeader: `Key ${channel.apiKey}`,
      timeoutMs,
      // 目标头已被消费，不能再往上游传。
      dropHeaders: [FAL_TARGET_URL_HEADER],
    })
  }

  if (!endpointPath) throw new HttpError(400, '缺少上游接口路径')

  const search = ctx.search ?? ''
  return pipeToUpstream(req, res, {
    upstreamUrl: buildUpstreamUrl(channel.baseUrl, endpointPath, search),
    authHeader: `Bearer ${channel.apiKey}`,
    timeoutMs,
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
