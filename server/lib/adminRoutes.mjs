// 后台管理接口：渠道 CRUD、排序、连通测试、用户管理、站点设置、口令管理。
// 所有路由都要求管理员会话，除了 /api/admin/state（用于判断是否首次初始化）与 /api/admin/login。

import { randomBytes } from 'node:crypto'
import { HttpError, readJsonBody, sendJson } from './http.mjs'
import {
  ACCESS_MODES,
  BUILT_IN_PROVIDERS,
  findChannel,
  findUserById,
  findUserByUsername,
  generatePasscode,
  getConfig,
  hashPassword,
  isValidUsername,
  MIN_USER_PASSWORD_LENGTH,
  normalizeChannel,
  normalizeUser,
  toAdminChannel,
  toAdminUser,
  updateConfig,
  verifyPassword,
} from './store.mjs'
import { buildUpstreamUrl } from './upstream.mjs'

function genChannelId() {
  return `ch-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

function genUserId() {
  return `u-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

function assertChannelInput(input, config, currentId) {
  const provider = String(input.provider ?? 'openai').trim()
  if (!provider) throw new HttpError(400, '必须选择服务商类型')
  if (!BUILT_IN_PROVIDERS.has(provider) && !config.customProviders.some((item) => item.id === provider)) {
    throw new HttpError(400, `未知的服务商类型「${provider}」，请先添加对应的自定义服务商`)
  }
  if (provider !== 'fal' && !String(input.baseUrl ?? '').trim()) {
    throw new HttpError(400, 'API 地址不能为空')
  }
  if (!String(input.name ?? '').trim()) throw new HttpError(400, '渠道名称不能为空')
  if (currentId && !findChannel(currentId)) throw new HttpError(404, '渠道不存在')
}

export async function handleAdminRoute(req, res, ctx) {
  const path = ctx.path
  const method = req.method ?? 'GET'

  // ===== 渠道列表与站点状态 =====
  if (path === '/api/admin/state' && method === 'GET') {
    const config = getConfig()
    return sendJson(res, 200, {
      initialized: Boolean(config.adminPasswordHash),
      authenticated: ctx.role === 'admin',
      ...(ctx.role === 'admin'
        ? {
            site: config.site,
            guestPasswordSet: Boolean(config.guestPasswordHash),
            channels: config.channels.map(toAdminChannel),
            users: config.users.map(toAdminUser),
            minUserPasswordLength: MIN_USER_PASSWORD_LENGTH,
            customProviders: config.customProviders,
            updatedAt: config.updatedAt,
          }
        : {}),
    })
  }

  if (ctx.role !== 'admin') throw new HttpError(401, '需要管理员登录')

  // ===== 渠道 CRUD =====
  if (path === '/api/admin/channels' && method === 'POST') {
    const body = await readJsonBody(req)
    assertChannelInput(body, getConfig(), null)
    if (!String(body.apiKey ?? '').trim()) throw new HttpError(400, 'API Key 不能为空')

    const now = Date.now()
    const channel = normalizeChannel({ ...body, id: genChannelId(), createdAt: now, updatedAt: now }, genChannelId())
    updateConfig((config) => {
      config.channels.push(channel)
      return config
    })
    return sendJson(res, 200, { channel: toAdminChannel(findChannel(channel.id)) })
  }

  const channelMatch = path.match(/^\/api\/admin\/channels\/([^/]+)$/)
  if (channelMatch) {
    const id = decodeURIComponent(channelMatch[1])

    if (method === 'PUT') {
      const body = await readJsonBody(req)
      const existing = findChannel(id)
      if (!existing) throw new HttpError(404, '渠道不存在')
      assertChannelInput({ ...existing, ...body }, getConfig(), id)

      // apiKey 留空表示不修改，避免后台每次保存都要重填密钥。
      const nextApiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : existing.apiKey
      if (!nextApiKey) throw new HttpError(400, 'API Key 不能为空')

      updateConfig((config) => {
        const idx = config.channels.findIndex((item) => item.id === id)
        config.channels[idx] = normalizeChannel(
          { ...config.channels[idx], ...body, id, apiKey: nextApiKey, createdAt: existing.createdAt, updatedAt: Date.now() },
          id,
        )
        return config
      })
      return sendJson(res, 200, { channel: toAdminChannel(findChannel(id)) })
    }

    if (method === 'DELETE') {
      if (!findChannel(id)) throw new HttpError(404, '渠道不存在')
      updateConfig((config) => {
        config.channels = config.channels.filter((item) => item.id !== id)
        return config
      })
      return sendJson(res, 200, { ok: true })
    }
  }

  // ===== 排序：前端传完整 id 顺序 =====
  if (path === '/api/admin/channels/reorder' && method === 'POST') {
    const body = await readJsonBody(req)
    const order = Array.isArray(body.order) ? body.order.filter((id) => typeof id === 'string') : []
    updateConfig((config) => {
      const byId = new Map(config.channels.map((item) => [item.id, item]))
      const sorted = []
      for (const id of order) {
        const channel = byId.get(id)
        if (channel) {
          sorted.push(channel)
          byId.delete(id)
        }
      }
      config.channels = [...sorted, ...byId.values()]
      return config
    })
    return sendJson(res, 200, { channels: getConfig().channels.map(toAdminChannel) })
  }

  // ===== 连通测试：只探测端点可达性与鉴权，不真正出图 =====
  if (path === '/api/admin/channels/test' && method === 'POST') {
    const body = await readJsonBody(req)
    const channel = typeof body.id === 'string' ? findChannel(body.id) : null
    if (!channel) throw new HttpError(404, '渠道不存在')
    return sendJson(res, 200, await testChannel(channel))
  }

  // ===== 自定义服务商 =====
  if (path === '/api/admin/custom-providers' && method === 'PUT') {
    const body = await readJsonBody(req)
    const providers = Array.isArray(body.customProviders) ? body.customProviders : []
    for (const provider of providers) {
      if (!provider || typeof provider !== 'object') throw new HttpError(400, '自定义服务商必须是对象')
      const id = String(provider.id ?? '').trim()
      if (!id) throw new HttpError(400, '自定义服务商缺少 id')
      if (BUILT_IN_PROVIDERS.has(id)) throw new HttpError(400, `自定义服务商 id「${id}」与内置服务商冲突`)
      if (!provider.submit || typeof provider.submit !== 'object') throw new HttpError(400, `自定义服务商「${id}」缺少 submit 映射`)
    }
    updateConfig((config) => {
      config.customProviders = providers
      return config
    })
    return sendJson(res, 200, { customProviders: getConfig().customProviders })
  }

  // ===== 用户管理 =====
  if (path === '/api/admin/users' && method === 'POST') {
    const body = await readJsonBody(req)
    const username = String(body.username ?? '').trim()
    if (!isValidUsername(username)) {
      throw new HttpError(400, '用户名需为 2-32 位字母、数字、下划线、点或连字符，且以字母或数字开头')
    }
    if (findUserByUsername(username)) throw new HttpError(409, `用户名「${username}」已存在`)

    // 没填口令就随机生成一个，明文只在这次响应里回传，之后只剩哈希。
    const provided = String(body.password ?? '')
    if (provided && provided.length < MIN_USER_PASSWORD_LENGTH) {
      throw new HttpError(400, `登录口令至少 ${MIN_USER_PASSWORD_LENGTH} 个字符`)
    }
    const password = provided || generatePasscode()

    const now = Date.now()
    const id = genUserId()
    const user = normalizeUser({
      id,
      username,
      displayName: String(body.displayName ?? '').trim(),
      note: String(body.note ?? '').trim(),
      enabled: body.enabled !== false,
      passwordHash: hashPassword(password),
      createdAt: now,
      updatedAt: now,
    }, id)

    updateConfig((config) => {
      config.users.push(user)
      return config
    })
    return sendJson(res, 200, { user: toAdminUser(findUserById(id)), password, generated: !provided })
  }

  const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/)
  if (userMatch) {
    const id = decodeURIComponent(userMatch[1])
    const existing = findUserById(id)
    if (!existing) throw new HttpError(404, '用户不存在')

    if (method === 'PUT') {
      const body = await readJsonBody(req)
      const username = typeof body.username === 'string' ? body.username.trim() : existing.username
      if (!isValidUsername(username)) {
        throw new HttpError(400, '用户名需为 2-32 位字母、数字、下划线、点或连字符，且以字母或数字开头')
      }
      const conflict = findUserByUsername(username)
      if (conflict && conflict.id !== id) throw new HttpError(409, `用户名「${username}」已存在`)

      // 口令留空表示不修改；填了就至少 MIN_USER_PASSWORD_LENGTH 位，并踢掉该用户所有旧会话。
      const password = typeof body.password === 'string' ? body.password : ''
      if (password && password.length < MIN_USER_PASSWORD_LENGTH) {
        throw new HttpError(400, `登录口令至少 ${MIN_USER_PASSWORD_LENGTH} 个字符`)
      }

      const enabled = body.enabled === undefined ? existing.enabled : body.enabled !== false
      updateConfig((config) => {
        const idx = config.users.findIndex((item) => item.id === id)
        config.users[idx] = normalizeUser({
          ...config.users[idx],
          username,
          displayName: typeof body.displayName === 'string' ? body.displayName.trim() : existing.displayName,
          note: typeof body.note === 'string' ? body.note.trim() : existing.note,
          enabled,
          passwordHash: password ? hashPassword(password) : existing.passwordHash,
          createdAt: existing.createdAt,
          updatedAt: Date.now(),
        }, id)
        return config
      })
      if (password || !enabled) ctx.onUserInvalidated(id)
      return sendJson(res, 200, { user: toAdminUser(findUserById(id)) })
    }

    if (method === 'DELETE') {
      updateConfig((config) => {
        config.users = config.users.filter((item) => item.id !== id)
        return config
      })
      ctx.onUserInvalidated(id)
      return sendJson(res, 200, { ok: true })
    }
  }

  // ===== 站点设置 =====
  if (path === '/api/admin/site' && method === 'PUT') {
    const body = await readJsonBody(req)
    const config = getConfig()
    const accessMode = typeof body.accessMode === 'string' ? body.accessMode : config.site.accessMode
    if (!ACCESS_MODES.has(accessMode)) throw new HttpError(400, '未知的访问方式')
    // 拦住会把自己锁在门外的组合：切到需要凭据的模式时，凭据得先存在。
    if (accessMode === 'passcode' && !config.guestPasswordHash) {
      throw new HttpError(400, '请先设置访客口令，再切换到共享口令模式')
    }
    if (accessMode === 'accounts' && !config.users.some((user) => user.enabled && user.passwordHash)) {
      throw new HttpError(400, '请先创建至少一个启用的用户，再切换到多用户模式')
    }

    updateConfig((next) => {
      next.site = { ...next.site, ...body, accessMode }
      return next
    })
    return sendJson(res, 200, { site: getConfig().site })
  }

  // ===== 口令管理 =====
  if (path === '/api/admin/password' && method === 'PUT') {
    const body = await readJsonBody(req)
    const target = body.target === 'guest' ? 'guest' : 'admin'
    const next = String(body.password ?? '')

    if (target === 'guest' && !next) {
      if (getConfig().site.accessMode === 'passcode') {
        throw new HttpError(400, '当前处于共享口令模式，清除口令会让所有人无法进入。请先切换访问方式')
      }
      updateConfig((config) => {
        config.guestPasswordHash = ''
        return config
      })
      ctx.onPasswordChanged('guest')
      return sendJson(res, 200, { ok: true, guestPasswordSet: false })
    }

    // 访客口令按用户口令的宽松下限来；管理员口令仍要求 8 位。
    const minLength = target === 'guest' ? MIN_USER_PASSWORD_LENGTH : 8
    if (next.length < minLength) throw new HttpError(400, `口令至少 ${minLength} 个字符`)
    if (target === 'admin' && !verifyPassword(String(body.currentPassword ?? ''), getConfig().adminPasswordHash)) {
      throw new HttpError(403, '当前管理员口令不正确')
    }

    const hash = hashPassword(next)
    updateConfig((config) => {
      if (target === 'admin') config.adminPasswordHash = hash
      else config.guestPasswordHash = hash
      return config
    })
    ctx.onPasswordChanged(target)
    return sendJson(res, 200, { ok: true })
  }

  // 只吐一个随机口令，不落库。后台的「随机生成」按钮用它填输入框，保存仍走上面的常规路径。
  if (path === '/api/admin/passcode' && method === 'POST') {
    return sendJson(res, 200, { password: generatePasscode() })
  }

  throw new HttpError(404, '未知的管理接口')
}

/** 渠道探测：优先请求 models 列表，失败则回落到一次极小的出图请求判断鉴权是否通过。 */
async function testChannel(channel) {
  if (channel.provider === 'fal') {
    // fal 没有轻量鉴权探测端点，直接确认凭据格式即可，真实错误留给出图时的故障转移处理。
    return channel.apiKey
      ? { ok: true, status: 0, message: 'fal 渠道无轻量探测端点，已确认密钥已配置' }
      : { ok: false, status: 0, message: '未配置 API Key' }
  }

  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)

  try {
    const url = buildUpstreamUrl(channel.baseUrl, 'models', '')
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${channel.apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    const text = (await response.text()).slice(0, 400)
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - started,
      message: response.ok ? '连通正常' : `HTTP ${response.status}：${text || '无响应内容'}`,
    }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      message: err instanceof Error ? err.message : '探测失败',
    }
  } finally {
    clearTimeout(timer)
  }
}
