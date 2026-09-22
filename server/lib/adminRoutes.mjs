// 后台管理接口：渠道 CRUD、排序、连通测试、用户管理、站点设置、口令管理。
// 所有路由都要求管理员会话，除了 /api/admin/state（用于判断是否首次初始化）与 /api/admin/login。

import { randomBytes } from 'node:crypto'
import {
  cardsOverview,
  deleteBatch,
  deleteCards,
  exportCards,
  generateCards,
  listBatches,
  listCards,
  recentRedeems,
  restoreCards,
  voidBatch,
  voidCards,
} from './cards.mjs'
import { auditChannel } from './channelAudit.mjs'
import { creditsOverview, creditsSummary, listLedger, removeAccount, resetCreditStats, setBalance } from './credits.mjs'
import { EMAIL_CODE_COOLDOWN_MS, EMAIL_CODE_TTL_MS } from './emailCodes.mjs'
import { HttpError, readJsonBody, sendJson, sendText } from './http.mjs'
import { describeSmtpError, sendMail, SMTP_PRESETS, verifyConnection } from './smtp.mjs'
import {
  ACCESS_MODES,
  AGENT_MODES,
  BUILT_IN_PROVIDERS,
  SMTP_ENCRYPTIONS,
  WECHAT_LOGIN_MODES,
  findChannel,
  findUserById,
  findUserByUsername,
  generateInviteCode,
  generatePasscode,
  getConfig,
  hashPassword,
  isAgentTextChannel,
  isSmtpConfigured,
  isValidUsername,
  MIN_USER_PASSWORD_LENGTH,
  normalizeChannel,
  normalizeUser,
  toAdminChannel,
  toAdminSite,
  toAdminSmtp,
  toAdminUser,
  toAdminWechat,
  updateConfig,
  verifyPassword,
} from './store.mjs'
import { buildUpstreamUrl } from './upstream.mjs'
import { channelHealth, clearChannelFault, resetUsage, usageOverview, usageSummary } from './usage.mjs'
import { getAccessToken, isWechatConfigured, QRCODE_TTL_SECONDS, wechatCallbackPath } from './wechat.mjs'

/** 判断是不是一个普通对象。store.mjs 里那份没有导出，这里不为了两个判断去加一个导出。 */
function isRecordLike(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

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
    const userNames = new Map(config.users.map((user) => [user.id, user.wechatNickname || user.displayName || user.username]))
    const creditsRows = new Map(creditsSummary(userNames, { ledgerLimit: 1 }).users.map((row) => [row.id, row]))

    return sendJson(res, 200, {
      initialized: Boolean(config.adminPasswordHash),
      authenticated: ctx.role === 'admin',
      ...(ctx.role === 'admin'
        ? {
            site: toAdminSite(config.site),
            guestPasswordSet: Boolean(config.guestPasswordHash),
            // 健康度直接挂在渠道上：后台列表要能一眼看出哪条挂了，不该再多一次请求。
            channels: config.channels.map((channel) => ({ ...toAdminChannel(channel), health: channelHealth(channel.id) })),
            // 用户列表顺带带上积分余额，省掉为了显示一列数字再打一次接口。
            users: config.users.map((user) => ({
              ...toAdminUser(user),
              balance: creditsRows.get(user.id)?.balance ?? 0,
              totalOut: creditsRows.get(user.id)?.totalOut ?? 0,
            })),
            minUserPasswordLength: MIN_USER_PASSWORD_LENGTH,
            customProviders: config.customProviders,
            wechat: {
              ...toAdminWechat(config.site),
              // 回调地址要展示给管理员复制到公众号后台，这里直接算好。
              callbackPath: wechatCallbackPath(),
              configured: isWechatConfigured(config.site.wechat),
              qrcodeTtlSeconds: QRCODE_TTL_SECONDS,
            },
            credits: {
              ...creditsOverview(),
              cards: cardsOverview(),
            },
            // 邮件发信设置。授权码只回掩码，另附 SMTP 服务商预设供下拉选择。
            smtp: {
              ...toAdminSmtp(config.site),
              presets: SMTP_PRESETS,
              codeTtlSeconds: Math.floor(EMAIL_CODE_TTL_MS / 1000),
              codeCooldownSeconds: Math.floor(EMAIL_CODE_COOLDOWN_MS / 1000),
            },
            updatedAt: config.updatedAt,
          }
        : {}),
    })
  }

  if (ctx.role !== 'admin') throw new HttpError(401, '需要管理员登录')

  // ===== 概览：后台首屏，回答"今天出了多少图、谁在用" =====
  if (path === '/api/admin/overview' && method === 'GET') {
    const config = getConfig()
    return sendJson(res, 200, {
      ...usageOverview(
        new Map(config.channels.map((item) => [item.id, item.name])),
        new Map(config.users.map((item) => [item.id, item.displayName || item.username])),
        { range: new URLSearchParams(ctx.search ?? '').get('range') },
      ),
      // 只有多用户模式才知道"是谁"，其他模式下前端要据此隐藏按用户表。
      accessMode: config.site.accessMode,
      userCount: config.users.length,
      channelCount: config.channels.length,
    })
  }

  // ===== 用量统计 =====
  if (path === '/api/admin/usage' && method === 'GET') {
    const config = getConfig()
    return sendJson(res, 200, usageSummary(
      new Map(config.channels.map((item) => [item.id, item.name])),
      new Map(config.users.map((item) => [item.id, item.displayName || item.username])),
    ))
  }

  if (path === '/api/admin/usage' && method === 'DELETE') {
    resetUsage()
    return sendJson(res, 200, { ok: true })
  }

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
    const result = await testChannel(channel)
    // 探测通过就说明渠道现在是好的，顺手把故障标记撤掉——
    // 否则管理员测出"连通正常"却还盯着一个红色徽标，只能去清空全部统计。
    if (result.ok) clearChannelFault(channel.id)
    return sendJson(res, 200, { ...result, health: channelHealth(channel.id) })
  }

  // 一键测全部：并发探测所有渠道，省掉逐条点。渠道数量级在几十条，全并发不会打爆上游。
  if (path === '/api/admin/channels/test-all' && method === 'POST') {
    const channels = getConfig().channels
    const results = await Promise.all(channels.map(async (channel) => ({
      id: channel.id,
      name: channel.name,
      ...(channel.apiKey
        ? await testChannel(channel)
        : { ok: false, status: 0, message: '未配置 API Key' }),
    })))
    for (const result of results) {
      if (result.ok) clearChannelFault(result.id)
    }
    return sendJson(res, 200, { results })
  }

  // 手动消除故障标记：管理员自己测过没问题时，用它把徽标清掉，
  // 不必为了一条渠道去清空所有统计。
  const clearFaultMatch = path.match(/^\/api\/admin\/channels\/([^/]+)\/clear-fault$/)
  if (clearFaultMatch && method === 'POST') {
    const id = decodeURIComponent(clearFaultMatch[1])
    if (!findChannel(id)) throw new HttpError(404, '渠道不存在')
    clearChannelFault(id)
    return sendJson(res, 200, { ok: true, health: channelHealth(id) })
  }

  // 深度自检：真发一次最小出图请求，区分"没余额"和"密钥错"。
  // 会消耗额度，所以只在管理员明确点击时执行，且逐条串行——
  // 几十条渠道同时真出图既烧钱又容易撞上限流，把好渠道也判成坏的。
  if (path === '/api/admin/channels/audit' && method === 'POST') {
    const config = getConfig()
    const body = await readJsonBody(req)
    const only = Array.isArray(body.ids) ? new Set(body.ids.filter((id) => typeof id === 'string')) : null
    const targets = only ? config.channels.filter((item) => only.has(item.id)) : config.channels

    const results = []
    for (const channel of targets) {
      const result = await auditChannel(channel, config.customProviders)
      // 自检真出图成功，说明这条渠道现在确实是好的，顺手把故障标记撤掉。
      if (result.verdict === 'ok') clearChannelFault(channel.id)
      results.push({ id: channel.id, name: channel.name, enabled: channel.enabled, ...result })
    }
    return sendJson(res, 200, { results })
  }

  // 批量停用：自检点出没余额的渠道后一键处理。停用而不是删除，
  // 密钥留着，充值后重新勾上就能继续用。
  if (path === '/api/admin/channels/bulk-disable' && method === 'POST') {
    const body = await readJsonBody(req)
    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : []
    if (!ids.length) throw new HttpError(400, '没有指定要停用的渠道')

    const wanted = new Set(ids)
    const disabled = []
    updateConfig((config) => {
      for (const channel of config.channels) {
        if (!wanted.has(channel.id) || !channel.enabled) continue
        channel.enabled = false
        channel.updatedAt = Date.now()
        disabled.push(channel.name)
      }
      return config
    })
    return sendJson(res, 200, { disabled, channels: getConfig().channels.map(toAdminChannel) })
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

    const agentMode = typeof body.agentMode === 'string' ? body.agentMode : config.site.agentMode
    if (!AGENT_MODES.has(agentMode)) throw new HttpError(400, '未知的 Agent 接入方式')
    // 开 Agent 前先确认渠道就位，否则前端会露出一个点进去就报错的入口。
    if (agentMode !== 'off') {
      const textId = typeof body.agentTextChannelId === 'string' ? body.agentTextChannelId : config.site.agentTextChannelId
      const textChannel = config.channels.find((item) => item.id === textId)
      if (!textChannel || !isAgentTextChannel(textChannel)) {
        throw new HttpError(400, 'Agent 需要一条启用中的 OpenAI 兼容 Responses 渠道，请先添加或选择')
      }
      if (agentMode === 'hybrid') {
        const imageId = typeof body.agentImageChannelId === 'string' ? body.agentImageChannelId : config.site.agentImageChannelId
        if (!config.channels.some((item) => item.id === imageId && item.enabled)) {
          throw new HttpError(400, '混合模式还需要选一条启用中的图像渠道')
        }
      }
    }

    // 注册只在多用户模式下成立。
    // 邀请码现在是可选加码（主关卡是邮箱验证码），所以只有管理员显式要求邀请码时，
    // 才需要检查"有没有生成过码"。
    // 明确要求打开却不满足条件时报错；只是切访问方式带出来的旧值，静默关掉就好——
    // 不该让管理员为一个他没碰过的开关卡在这里。
    const wantsRegistration = body.registrationEnabled === true
    const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : config.site.inviteCode
    const requireInviteCode = body.requireInviteCode === undefined
      ? config.site.requireInviteCode
      : body.requireInviteCode === true
    if (wantsRegistration) {
      if (accessMode !== 'accounts') throw new HttpError(400, '自助注册只能在多用户账号模式下开启')
      if (requireInviteCode && !inviteCode) throw new HttpError(400, '已勾选「要求邀请码」，请先生成邀请码')
    }
    const registrationEnabled = body.registrationEnabled === undefined
      ? config.site.registrationEnabled && accessMode === 'accounts' && (!requireInviteCode || Boolean(inviteCode))
      : wantsRegistration

    updateConfig((next) => {
      next.site = { ...next.site, ...body, accessMode, agentMode, registrationEnabled }
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

  // ===== 邀请码 =====
  // 换一个新码并把已用次数归零：旧码立即失效，等于"作废重发"。
  if (path === '/api/admin/invite' && method === 'POST') {
    const code = generateInviteCode()
    updateConfig((config) => {
      config.site.inviteCode = code
      config.site.inviteUsedCount = 0
      return config
    })
    return sendJson(res, 200, { inviteCode: code })
  }

  if (path === '/api/admin/invite' && method === 'DELETE') {
    updateConfig((config) => {
      config.site.inviteCode = ''
      config.site.inviteUsedCount = 0
      // 不再顺手把 registrationEnabled 关掉：邀请码已经降级成可选的加码，
      // 作废它不该连带关掉"用邮箱验证码注册"这条主路径。
      // 如果管理员恰好还勾着「额外要求邀请码」，normalizeRegistration 会自动把注册停掉
      // （要求邀请码却没有码，等于全站都注册不了），这正是期望行为。
      return config
    })
    return sendJson(res, 200, { ok: true })
  }

  // ===== 积分 =====
  //
  // 专门开一个只改积分的口子，而不是复用 /api/admin/site：
  // 那个接口会顺带重算 registrationEnabled、校验 agentMode，改个单价却把访问方式相关字段
  // 一起卷进来，出了问题很难查。这里只碰 site.credits。
  if (path === '/api/admin/credits' && method === 'PUT') {
    const body = await readJsonBody(req)
    const current = getConfig().site.credits
    const raw = isRecordLike(body.credits) ? body.credits : body

    updateConfig((config) => {
      config.site.credits = {
        ...current,
        ...raw,
        // 渠道倍率与套餐是整块替换的语义：后台每次保存都提交完整列表，
        // 合并旧值会让"删掉一个套餐"变成不可能。
        channelRates: isRecordLike(raw.channelRates) ? raw.channelRates : current.channelRates,
        packs: Array.isArray(raw.packs) ? raw.packs : current.packs,
      }
      return config
    })
    return sendJson(res, 200, { credits: getConfig().site.credits })
  }

  if (path === '/api/admin/credits' && method === 'GET') {
    const config = getConfig()
    const userNames = new Map(config.users.map((user) => [user.id, user.wechatNickname || user.displayName || user.username]))
    return sendJson(res, 200, {
      ...creditsSummary(userNames, { ledgerLimit: 200 }),
      overview: creditsOverview(),
      settings: config.site.credits,
    })
  }

  const balanceMatch = path.match(/^\/api\/admin\/credits\/users\/([^/]+)$/)
  if (balanceMatch && method === 'PUT') {
    const id = decodeURIComponent(balanceMatch[1])
    const user = findUserById(id)
    if (!user) throw new HttpError(404, '用户不存在')

    const body = await readJsonBody(req)
    const next = Number(body.balance)
    if (!Number.isFinite(next) || next < 0) throw new HttpError(400, '积分必须是不小于 0 的数字')

    const result = setBalance(id, Math.trunc(next), { note: String(body.note ?? '管理员调整') })
    return sendJson(res, 200, { ok: true, balance: result.balance, changed: result.changed })
  }

  // 清空统计但不动余额。余额是用户资产，任何"清空"按钮都不该碰它。
  if (path === '/api/admin/credits/stats' && method === 'DELETE') {
    resetCreditStats()
    return sendJson(res, 200, { ok: true })
  }

  // ===== 卡密 =====
  if (path === '/api/admin/cards' && method === 'GET') {
    const query = new URLSearchParams(ctx.search ?? '')
    const config = getConfig()
    const userNames = new Map(config.users.map((user) => [user.id, user.wechatNickname || user.displayName || user.username]))
    return sendJson(res, 200, {
      ...listCards({
        status: query.get('status') ?? '',
        batch: query.get('batch') ?? '',
        keyword: query.get('keyword') ?? '',
        limit: Number(query.get('limit')) || 100,
        offset: Number(query.get('offset')) || 0,
      }),
      batches: listBatches(),
      overview: cardsOverview(),
      recentRedeems: recentRedeems(30, userNames),
    })
  }

  if (path === '/api/admin/cards' && method === 'POST') {
    const body = await readJsonBody(req)
    try {
      const result = generateCards({
        credits: Number(body.credits),
        count: Number(body.count),
        note: body.note,
      })
      return sendJson(res, 200, { ...result, overview: cardsOverview() })
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : '生成失败')
    }
  }

  if (path === '/api/admin/cards/void' && method === 'POST') {
    const body = await readJsonBody(req)
    const result = body.batch
      ? voidBatch(String(body.batch))
      : voidCards(body.codes)
    return sendJson(res, 200, { ...result, overview: cardsOverview() })
  }

  if (path === '/api/admin/cards/restore' && method === 'POST') {
    const body = await readJsonBody(req)
    return sendJson(res, 200, { ...restoreCards(body.codes), overview: cardsOverview() })
  }

  if (path === '/api/admin/cards/delete' && method === 'POST') {
    const body = await readJsonBody(req)
    // 已兑换的卡是财务凭证，deleteCards 会跳过它们并如实回报跳过了几张。
    const result = body.batch ? deleteBatch(String(body.batch)) : deleteCards(body.codes)
    return sendJson(res, 200, { ...result, overview: cardsOverview() })
  }

  // 导出成纯文本，一行一张码——直接贴进发卡网就行。
  if (path === '/api/admin/cards/export' && method === 'GET') {
    const query = new URLSearchParams(ctx.search ?? '')
    const status = query.get('status') ?? ''
    const batch = query.get('batch') ?? ''
    const rows = exportCards({ status, batch })
    if (!rows.length) throw new HttpError(404, '没有符合条件的卡密')

    const header = query.get('with-credits') === '1'
      ? (row) => `${row.code},${row.credits}`
      : (row) => row.code
    const body = rows.map(header).join('\n')
    const stamp = new Date().toISOString().slice(0, 10)
    return sendText(res, 200, body, `text/plain; charset=utf-8`, {
      'Content-Disposition': `attachment; filename="gip-cards-${stamp}.txt"`,
    })
  }

  // ===== 微信登录设置 =====
  if (path === '/api/admin/wechat' && method === 'PUT') {
    const body = await readJsonBody(req)
    const current = getConfig().site.wechat
    if (body.loginMode !== undefined && !WECHAT_LOGIN_MODES.has(body.loginMode)) {
      throw new HttpError(400, '未知的微信登录方式')
    }
    // 凭据留空表示"不修改"，否则后台每次保存都要重填 AppSecret。
    const appSecret = typeof body.appSecret === 'string' && body.appSecret.trim() ? body.appSecret.trim() : current.appSecret
    const token = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : current.token
    const encodingAesKey = typeof body.encodingAesKey === 'string' && body.encodingAesKey.trim()
      ? body.encodingAesKey.trim()
      : current.encodingAesKey

    if (encodingAesKey && encodingAesKey.length !== 43) {
      throw new HttpError(400, 'EncodingAESKey 必须是 43 位字符，请从公众号后台原样复制')
    }

    updateConfig((config) => {
      config.site.wechat = {
        ...config.site.wechat,
        ...body,
        appSecret,
        token,
        encodingAesKey,
        appId: typeof body.appId === 'string' ? body.appId.trim() : current.appId,
      }
      return config
    })
    return sendJson(res, 200, { wechat: toAdminWechat(getConfig().site) })
  }

  // 拿一次 access_token，验证 AppID / AppSecret / IP 白名单三件事是否都对了。
  if (path === '/api/admin/wechat/test' && method === 'POST') {
    const wechat = getConfig().site.wechat
    if (!wechat.appId || !wechat.appSecret) throw new HttpError(400, '请先填写 AppID 与 AppSecret')
    try {
      await getAccessToken(wechat, { force: true })
      return sendJson(res, 200, { ok: true, message: '接口调用成功：AppID、AppSecret 与 IP 白名单都已就绪' })
    } catch (err) {
      return sendJson(res, 200, { ok: false, message: err instanceof Error ? err.message : '调用失败' })
    }
  }

  // ===== 邮件发信（注册验证码）=====
  //
  // 与 /api/admin/site 分开：那个接口会把整个 body 摊进 site，
  // 而 SMTP 有"留空表示不修改"的凭据语义，混在一起会把授权码覆盖成空串。
  if (path === '/api/admin/smtp' && method === 'PUT') {
    const body = await readJsonBody(req)
    const current = getConfig().site.smtp

    if (body.encryption !== undefined && !SMTP_ENCRYPTIONS.has(body.encryption)) {
      throw new HttpError(400, '未知的加密方式')
    }

    // 授权码留空表示"不修改"，否则后台每次保存都要重新粘贴一遍。
    // 想清空就把 enabled 关掉，而不是把授权码抹成空——那会让配置处于半死状态。
    const password = typeof body.password === 'string' && body.password.trim()
      ? body.password.trim()
      : current.password

    const host = body.host !== undefined ? String(body.host).trim() : current.host
    const user = body.user !== undefined ? String(body.user).trim() : current.user

    // 提前把明显的错拦下来：这些错的后果是"信发不出去"，而错误信息只会出现在
    // 用户点注册的那一刻，排查起来很绕。
    if (body.enabled === true) {
      if (!host) throw new HttpError(400, '请先填写 SMTP 服务器地址')
      if (!user) throw new HttpError(400, '请先填写 SMTP 登录账号（通常是完整邮箱地址）')
      if (!password) throw new HttpError(400, '请先填写 SMTP 授权码')
    }

    updateConfig((config) => {
      config.site.smtp = {
        ...config.site.smtp,
        ...body,
        host,
        user,
        password,
        port: body.port !== undefined ? Number(body.port) || 0 : current.port,
        from: body.from !== undefined ? String(body.from).trim() : current.from,
        fromName: body.fromName !== undefined ? String(body.fromName).trim() : current.fromName,
      }
      return config
    })
    return sendJson(res, 200, { smtp: toAdminSmtp(getConfig().site) })
  }

  // 探活：连上去、EHLO、认证，然后退出。不消耗发信额度，用来确认
  // "地址 / 端口 / 加密方式 / 授权码" 这四件事是不是都对。
  if (path === '/api/admin/smtp/test' && method === 'POST') {
    const smtp = getConfig().site.smtp
    if (!isSmtpConfigured(smtp)) throw new HttpError(400, '请先填写服务器地址、账号与授权码')
    try {
      const result = await verifyConnection(smtpOptionsOf(smtp))
      return sendJson(res, 200, {
        ok: true,
        message: `连接与认证都成功（${result.host}:${result.port}，${describeEncryption(result.encryption)}，认证方式 ${result.mechanism}）`,
      })
    } catch (err) {
      return sendJson(res, 200, { ok: false, message: describeSmtpError(err) })
    }
  }

  // 真发一封：探活只能证明"能连上认证"，证明不了"信能投进收件箱"。
  // 域名信誉、发件人是否与账号一致、内容是否被判垃圾，都只有真发一封才看得出来。
  if (path === '/api/admin/smtp/send-test' && method === 'POST') {
    const body = await readJsonBody(req)
    const smtp = getConfig().site.smtp
    if (!isSmtpConfigured(smtp)) throw new HttpError(400, '请先填写服务器地址、账号与授权码')

    const to = String(body.to ?? '').trim() || smtp.user
    const title = getConfig().site.title
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
    try {
      const result = await sendMail({
        ...smtpOptionsOf(smtp),
        to,
        subject: `【${title}】测试邮件`,
        text: `这是一封来自 ${title} 的测试邮件，发送于 ${stamp}。\n\n如果你收到了它，说明注册验证码的邮件通道是通的。`,
        html: `<div style="font-family:sans-serif;font-size:15px;line-height:1.7">
          <p><strong>这是一封测试邮件。</strong></p>
          <p>发送于 ${stamp}。</p>
          <p style="color:#666">收到它说明注册验证码的邮件通道是通的。</p>
        </div>`,
      })
      return sendJson(res, 200, { ok: true, message: `已投递给 ${to}（服务器回应：${result.response || 'OK'}）` })
    } catch (err) {
      return sendJson(res, 200, { ok: false, message: describeSmtpError(err) })
    }
  }

  throw new HttpError(404, '未知的管理接口')
}

/** 后台配置项 → smtp.mjs 入参。和 index.mjs 里那份保持一致。 */
function smtpOptionsOf(smtp) {
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

function describeEncryption(encryption) {
  if (encryption === 'ssl') return '隐式 SSL'
  if (encryption === 'none') return '明文（无加密）'
  return 'STARTTLS'
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
