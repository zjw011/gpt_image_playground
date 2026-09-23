// 配置持久化：单个 JSON 文件 + 原子写入 + 内存缓存。
// 选 JSON 而非 SQLite 是为了零原生依赖，渠道数量级在几十条，读写全量完全够用。

import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const CONFIG_VERSION = 2
const SCRYPT_KEYLEN = 64

export const BUILT_IN_PROVIDERS = new Set(['openai', 'sb2api-async', 'fal'])

/** 访问方式：open 任何人可用、passcode 共享口令、accounts 逐用户账号（数据互相隔离）、wechat 微信扫码关注登录。 */
export const ACCESS_MODES = new Set(['open', 'passcode', 'accounts', 'wechat'])

/** Agent 模式的接入方式：off 不开放、native 原生 image_generation 工具、hybrid 文本模型 + 独立图像渠道。 */
export const AGENT_MODES = new Set(['off', 'native', 'hybrid'])

/** 用户名限制得比较严，因为它同时被用作前端本地仓库的命名空间。 */
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,31}$/

/** 用户登录口令的最小长度。比管理员口令宽松：它有 IP 限流兜底，而且是要口头转达给别人的。 */
export const MIN_USER_PASSWORD_LENGTH = 6

// 剔除 0/O/1/l/I 这些容易念错抄错的字符——这串东西是要发微信或者口头念给别人的。
const PASSCODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/**
 * 生成随机登录口令，形如 `k7mq-3xf9`。
 * 8 位 31 进制约 40 bit 熵，配合"10 分钟失败 10 次锁 10 分钟"的限流，暴力破解不现实。
 * 用 randomInt 而不是 randomBytes % 31，后者会引入取模偏差。
 */
export function generatePasscode() {
  const chars = Array.from({ length: 8 }, () => PASSCODE_ALPHABET[randomInt(PASSCODE_ALPHABET.length)])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}

export function isValidUsername(value) {
  return USERNAME_PATTERN.test(String(value ?? ''))
}

/** 生成邀请码，形如 `q7mkx-3f9dp`。比登录口令长两位——它是公开投放的，被猜中的机会更多。 */
export function generateInviteCode() {
  const chars = Array.from({ length: 10 }, () => PASSCODE_ALPHABET[randomInt(PASSCODE_ALPHABET.length)])
  return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`
}

/** 邀请码比对前先规整：忽略大小写和连字符，用户手抄时最容易在这两处出错。 */
export function normalizeInviteCode(value) {
  return String(value ?? '').trim().toLowerCase().replace(/-/g, '')
}

/**
 * 用户 id。用户名可改、邮箱可换，id 一旦生成就跟着作品走，所以必须随机且唯一。
 * 前缀带时间戳只为排查时一眼看出创建顺序，不作为唯一性依据。
 */
export function generateUserId() {
  return `u-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

let dataFile = ''
let cache = null

export function initStore(dataDir) {
  dataFile = join(dataDir, 'config.json')
  mkdirSync(dirname(dataFile), { recursive: true })
  cache = readConfigFile()
  return cache
}

function createEmptyConfig() {
  return {
    version: CONFIG_VERSION,
    adminPasswordHash: '',
    guestPasswordHash: '',
    site: {
      title: '绘想',
      // 默认开放：首次部署时前端就能直接用；改成 passcode / accounts 由管理员决定。
      accessMode: 'open',
      failoverEnabled: true,
      failoverMaxAttempts: 0,
      allowGuestParamOverride: true,
      // Agent 模式默认关闭：它需要指定一条 Responses 渠道，管理员没指定就不该在前端露出入口。
      agentMode: 'off',
      agentTextChannelId: '',
      agentImageChannelId: '',
      agentMaxToolRounds: 15,
      agentWebSearch: false,
      // 自助注册默认关闭：开着等于把渠道额度对全网敞开，必须由管理员显式打开。
      registrationEnabled: false,
      // 加了邮箱验证码之后，邀请码从"必经关卡"降级成"可选加码"。默认不要求——
      // 少一个用户看不懂的东西，注册转化率就高一点。
      requireInviteCode: false,
      inviteCode: '',
      inviteMaxUses: 0,
      inviteUsedCount: 0,
      inviteExpiresAt: 0,
      // 发验证码用的 SMTP。默认空配置，此时注册功能拿不到验证码，等于不可用。
      smtp: {
        enabled: false,
        host: '',
        port: 465,
        encryption: 'ssl',
        user: '',
        password: '',
        from: '',
        fromName: '',
        allowUnauthorized: false,
        dailyLimitPerEmail: 8,
        hourlyLimitPerIp: 20,
      },
      // 微信扫码关注登录。默认关闭，且必须凑齐 AppID/AppSecret/Token 才能真正启用。
      wechat: {
        enabled: false,
        appId: '',
        appSecret: '',
        // 公众号后台「服务器配置」里填的 Token，用于校验微信推送的签名。
        token: '',
        // 公众号后台「服务器配置」里的消息加解密密钥。安全/兼容模式必填，明文模式可留空。
        encodingAesKey: '',
        // 公众号的固定二维码图片（data: 内联图或 https 外链），验证码模式下显示给用户扫。
        qrcodeImage: '',
        // code：扫码关注后在公众号里回复验证码（任何账号类型都能用，含未认证订阅号）；
        // qrcode：直接扫「带参数二维码」即登录（接口只对微信认证服务号开放，个人主体拿不到）。
        loginMode: 'code',
        // 扫码关注后回复的文案，留空则只回 success（不产生被动回复）。
        replyText: '',
        // 是否尝试拉取昵称头像。需要账号已认证（认证订阅号或认证服务号），未认证会返回 48001。
        fetchProfile: true,
      },
      // 积分制。默认关闭——不开启时前端完全看不到积分相关入口，行为与升级前一致。
      credits: {
        enabled: false,
        costPerImage: 1,
        signupBonus: 0,
        purchaseUrl: '',
        // 默认档位按 1 元 = 200 积分定价；后台「积分与卡密」可随时改
        packs: [
          { name: '100 积分', price: '¥0.5', credits: 100 },
          { name: '500 积分', price: '¥2.5', credits: 500 },
          { name: '1,200 积分', price: '¥6', credits: 1200 },
          { name: '2,800 积分', price: '¥14', credits: 2800 },
        ],
        channelRates: {},
      },
    },
    users: [],
    channels: [],
    customProviders: [],
    updatedAt: 0,
  }
}

function readConfigFile() {
  if (!existsSync(dataFile)) {
    const config = createEmptyConfig()
    writeConfigFile(config)
    return config
  }

  try {
    return normalizeConfig(JSON.parse(readFileSync(dataFile, 'utf-8')))
  } catch (err) {
    console.error('配置文件读取失败，将使用空配置：', err)
    return createEmptyConfig()
  }
}

function writeConfigFile(config) {
  const tmp = `${dataFile}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, dataFile)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function normalizeBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeInt(value, fallback, min, max) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(numeric)))
}

/** 渠道清洗：外部输入（配置文件、后台表单）一律走这里，保证下游字段齐全。 */
export function normalizeChannel(input, fallbackId) {
  const record = isRecord(input) ? input : {}
  const provider = normalizeString(record.provider, 'openai').trim() || 'openai'
  const apiMode = record.apiMode === 'responses' ? 'responses' : 'images'

  return {
    id: normalizeString(record.id, fallbackId).trim() || fallbackId,
    name: normalizeString(record.name, '未命名渠道').trim() || '未命名渠道',
    description: normalizeString(record.description, ''),
    enabled: normalizeBool(record.enabled, true),
    provider,
    baseUrl: normalizeString(record.baseUrl, '').trim(),
    apiKey: normalizeString(record.apiKey, ''),
    model: normalizeString(record.model, 'gpt-image-2').trim() || 'gpt-image-2',
    apiMode,
    timeout: normalizeInt(record.timeout, 600, 10, 3600),
    codexCli: normalizeBool(record.codexCli, false),
    responseFormatB64Json: normalizeBool(record.responseFormatB64Json, false),
    streamImages: normalizeBool(record.streamImages, provider === 'openai' && apiMode === 'responses'),
    streamPartialImages: normalizeInt(record.streamPartialImages, 1, 0, 3),
    reasoningEffort: normalizeString(record.reasoningEffort, '') || undefined,
    transparentBackgroundMethod: record.transparentBackgroundMethod === 'local' ? 'local' : 'api',
    createdAt: normalizeInt(record.createdAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    updatedAt: normalizeInt(record.updatedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
  }
}

/** 用户清洗。id 一旦生成就不再变，改用户名不会让对方丢掉已有的作品。 */
export function normalizeUser(input, fallbackId) {
  const record = isRecord(input) ? input : {}
  const username = normalizeString(record.username, '').trim()

  return {
    id: normalizeString(record.id, fallbackId).trim() || fallbackId,
    username,
    displayName: normalizeString(record.displayName, '').trim(),
    passwordHash: normalizeString(record.passwordHash, ''),
    // 站长角色：登录后由前端分流进管理后台。只有 role === 'admin' 的账号能碰 /api/admin/*。
    role: record.role === 'admin' ? 'admin' : 'user',
    // 注册邮箱一律小写存储：A@qq.com 和 a@qq.com 必须落到同一个账号，
    // 否则同一台邮箱能反复注册出无数个小号来领注册赠送的积分。
    email: normalizeString(record.email, '').trim().toLowerCase(),
    enabled: normalizeBool(record.enabled, true),
    note: normalizeString(record.note, ''),
    // 区分账号是怎么来的，后台名册上要能一眼看出来。
    createdVia: normalizeCreatedVia(record.createdVia),
    emailVerifiedAt: normalizeInt(record.emailVerifiedAt, 0, 0, Number.MAX_SAFE_INTEGER),
    createdAt: normalizeInt(record.createdAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    updatedAt: normalizeInt(record.updatedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    lastSeenAt: normalizeInt(record.lastSeenAt, 0, 0, Number.MAX_SAFE_INTEGER),
    // 微信身份。openid 是登录的主键，一旦绑定不再变动；昵称头像只是展示用，拿不到就留空。
    wechatOpenId: normalizeString(record.wechatOpenId, '').trim(),
    wechatUnionId: normalizeString(record.wechatUnionId, '').trim(),
    wechatNickname: normalizeString(record.wechatNickname, '').trim(),
    wechatAvatar: normalizeString(record.wechatAvatar, '').trim(),
    wechatSubscribed: normalizeBool(record.wechatSubscribed, false),
  }
}

const CREATED_VIA = new Set(['admin', 'invite', 'wechat', 'email'])

function normalizeCreatedVia(value) {
  const raw = normalizeString(value, '').trim()
  return CREATED_VIA.has(raw) ? raw : 'admin'
}

/** 老配置只有 guestGateEnabled 布尔值，映射成新的三档 accessMode。 */
function normalizeAccessMode(site) {
  const raw = normalizeString(site.accessMode, '').trim()
  if (ACCESS_MODES.has(raw)) return raw
  return site.guestGateEnabled === true ? 'passcode' : 'open'
}

/** Agent 的文本渠道必须是 OpenAI 兼容的 Responses 渠道，只有它支持对话与工具调用。 */
export function isAgentTextChannel(channel) {
  return channel.enabled && channel.provider === 'openai' && channel.apiMode === 'responses'
}

/**
 * Agent 设置清洗。指定的渠道被删掉或改了 API 模式后，这里会把 agentMode 拉回 off——
 * 宁可前端不显示 Agent 入口，也不能让用户点进去撞一个配置错误弹窗。
 */
function normalizeAgentSettings(site, channels) {
  const mode = AGENT_MODES.has(normalizeString(site.agentMode, '').trim()) ? site.agentMode : 'off'
  const textId = normalizeString(site.agentTextChannelId, '').trim()
  const imageId = normalizeString(site.agentImageChannelId, '').trim()
  // 只认还活着且仍然是 Responses 的渠道；没显式指定时自动挑第一条可用的，省掉管理员一次点击。
  const textChannel = channels.find((item) => item.id === textId && isAgentTextChannel(item))
    ?? (textId ? null : channels.find(isAgentTextChannel))
  const imageChannel = channels.find((item) => item.id === imageId && item.enabled)
    ?? (imageId ? null : channels.find((item) => item.enabled))

  return {
    agentMode: textChannel && (mode !== 'hybrid' || imageChannel) ? mode : 'off',
    agentTextChannelId: textChannel?.id ?? '',
    agentImageChannelId: imageChannel?.id ?? '',
    agentMaxToolRounds: normalizeInt(site.agentMaxToolRounds, 15, 1, 100),
    agentWebSearch: normalizeBool(site.agentWebSearch, false),
  }
}

/**
 * 自助注册设置清洗。
 * 注册只在多用户模式下有意义——别的模式下根本没有"账号"这个概念。
 *
 * 邀请码从"必经关卡"改成了"可选加码"：主关卡换成了邮箱验证码。
 * 所以这里只检查"要邀请码时是否真的配了码"，不再要求必须有码才能开注册。
 */
function normalizeRegistration(site, accessMode) {
  const inviteCode = normalizeString(site.inviteCode, '').trim()
  const expiresAt = normalizeInt(site.inviteExpiresAt, 0, 0, Number.MAX_SAFE_INTEGER)
  const requireInviteCode = normalizeBool(site.requireInviteCode, false)

  return {
    registrationEnabled: normalizeBool(site.registrationEnabled, false)
      && accessMode === 'accounts'
      && (!requireInviteCode || Boolean(inviteCode)),
    requireInviteCode,
    inviteCode,
    inviteMaxUses: normalizeInt(site.inviteMaxUses, 0, 0, 10_000),
    inviteUsedCount: normalizeInt(site.inviteUsedCount, 0, 0, Number.MAX_SAFE_INTEGER),
    inviteExpiresAt: expiresAt,
  }
}

/** 邮件加密方式。与 smtp.mjs 里的一致，`none` 是明文（只给内网中继用）。 */
export const SMTP_ENCRYPTIONS = new Set(['ssl', 'starttls', 'none'])

/** 邮件发信设置是否真的能跑通：四要素缺一不可。 */
export function isSmtpConfigured(smtp) {
  return Boolean(smtp && smtp.host && smtp.user && smtp.password && (smtp.from || smtp.user))
}

/**
 * 邮件发信设置清洗。
 *
 * `enabled` 用服务端算出来的那份：缺任何一项都不可能发出信，留一个"开着但一定失败"
 * 的开关只会让管理员反复排查前端为什么收不到验证码。
 */
function normalizeSmtp(site) {
  const raw = isRecord(site.smtp) ? site.smtp : {}
  const host = normalizeString(raw.host, '').trim().slice(0, 200)
  const user = normalizeString(raw.user, '').trim().slice(0, 200)
  // 密码在这里是"授权码 / 客户端专用密码"，长度上限给宽一点（有的服务商字符串很长）。
  const password = normalizeString(raw.password, '').slice(0, 400)
  const from = normalizeString(raw.from, '').trim().slice(0, 200)
  const encryptionInput = normalizeString(raw.encryption, '').trim().toLowerCase()

  const normalized = {
    enabled: false,
    host,
    port: normalizeInt(raw.port, 0, 0, 65535),
    encryption: SMTP_ENCRYPTIONS.has(encryptionInput) ? encryptionInput : 'ssl',
    user,
    password,
    // 发件人留空时取登录账号。QQ / 163 本来就强制要求两者一致，
    // 自动兜底能省掉管理员一个必填项，也少一次 550。
    from: from || user,
    fromName: normalizeString(raw.fromName, '').trim().slice(0, 60),
    allowUnauthorized: normalizeBool(raw.allowUnauthorized, false),
    // 限流值的上限是"防手滑"的保险丝：填成 0 会让注册功能彻底不可用。
    dailyLimitPerEmail: normalizeInt(raw.dailyLimitPerEmail, 8, 1, 200),
    hourlyLimitPerIp: normalizeInt(raw.hourlyLimitPerIp, 20, 1, 2000),
  }

  normalized.enabled = normalizeBool(raw.enabled, false) && isSmtpConfigured(normalized)
  return normalized
}

/** 微信登录方式：code 扫码后回复验证码（未认证也能用）、qrcode 带参数二维码（需认证）。 */
export const WECHAT_LOGIN_MODES = new Set(['code', 'qrcode'])

/**
 * 微信登录设置清洗。
 * `enabled` 只有在三件套（AppID / AppSecret / Token）齐了之后才可能为真——
 * 缺任何一项都不可能跑通，留一个"开着但一定失败"的开关只会让管理员反复排查前端。
 */
function normalizeWechat(site) {
  const raw = isRecord(site.wechat) ? site.wechat : {}
  const appId = normalizeString(raw.appId, '').trim()
  const appSecret = normalizeString(raw.appSecret, '').trim()
  const token = normalizeString(raw.token, '').trim()
  // 安全 / 兼容模式下微信推来的是密文，必须拿 EncodingAESKey 解开。43 位字符。
  const encodingAesKey = normalizeString(raw.encodingAesKey, '').trim().slice(0, 64)
  // 公众号二维码图片：管理员传上来的固定二维码，验证码模式下要显示给用户扫。
  // 允许是 data: 内联图（上传）或 http(s) 外链（图床），长度上限防手滑贴进一个二进制文件。
  const qrcodeImage = normalizeString(raw.qrcodeImage, '').trim().slice(0, 400_000)

  return {
    enabled: normalizeBool(raw.enabled, false) && Boolean(appId && appSecret && token),
    appId,
    appSecret,
    token,
    encodingAesKey,
    qrcodeImage,
    // 「生成带参数的二维码」只有认证公众号才能调，所以默认走验证码模式。
    loginMode: WECHAT_LOGIN_MODES.has(raw.loginMode) ? raw.loginMode : 'code',
    replyText: normalizeString(raw.replyText, '').slice(0, 600),
    fetchProfile: normalizeBool(raw.fetchProfile, true),
  }
}

/**
 * 套餐价格是"展示文案"（"¥9.9"、"限时 8 折"），所以存字符串不下发货币单位。
 * 但后台填价格时人手最容易直接敲 `9.9`，如果严格只认字符串就会静默丢掉价格——
 * 管理员在界面上看到「已保存」，回列表却发现标价空了。这里顺手把数字转成字符串。
 */
function normalizePackPrice(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * 积分设置清洗。
 * 面额与单价的上下限是防手滑的保险丝：单价 0 等于全站免费，面额 999 亿等于余额溢出。
 */
function normalizeCreditSettings(site) {
  const raw = isRecord(site.credits) ? site.credits : {}

  const packs = (Array.isArray(raw.packs) ? raw.packs : [])
    .filter(isRecord)
    .slice(0, 12)
    .map((pack) => ({
      name: normalizeString(pack.name, '').trim().slice(0, 40),
      price: normalizePackPrice(pack.price).trim().slice(0, 20),
      credits: normalizeInt(pack.credits, 0, 0, 100_000_000),
    }))
    .filter((pack) => pack.credits > 0)

  // 渠道倍率存百分比整数，100 表示原价。用整数是为了避开浮点误差累积到余额上。
  const channelRates = {}
  if (isRecord(raw.channelRates)) {
    for (const [id, value] of Object.entries(raw.channelRates)) {
      const numeric = Number(value)
      if (!id || !Number.isFinite(numeric) || numeric <= 0) continue
      channelRates[id] = Math.min(1000, Math.max(1, Math.trunc(numeric)))
    }
  }

  return {
    enabled: normalizeBool(raw.enabled, false),
    costPerImage: normalizeInt(raw.costPerImage, 1, 0, 100_000),
    signupBonus: normalizeInt(raw.signupBonus, 0, 0, 1_000_000),
    purchaseUrl: normalizeString(raw.purchaseUrl, '').trim().slice(0, 500),
    packs,
    channelRates,
  }
}

function normalizeConfig(input) {
  const record = isRecord(input) ? input : {}
  const site = isRecord(record.site) ? record.site : {}
  const channels = Array.isArray(record.channels) ? record.channels : []
  const seen = new Set()
  const normalizedChannels = []

  for (const [idx, item] of channels.entries()) {
    const channel = normalizeChannel(item, `channel-${idx + 1}`)
    if (seen.has(channel.id)) continue
    seen.add(channel.id)
    normalizedChannels.push(channel)
  }

  const rawUsers = Array.isArray(record.users) ? record.users : []
  const seenUserIds = new Set()
  const seenUsernames = new Set()
  const normalizedUsers = []

  for (const [idx, item] of rawUsers.entries()) {
    const user = normalizeUser(item, `user-${idx + 1}`)
    // 用户名非法或重复的条目直接丢弃：它无法登录，留着只会让后台列表出现幽灵行。
    if (!isValidUsername(user.username)) continue
    const lowered = user.username.toLowerCase()
    if (seenUserIds.has(user.id) || seenUsernames.has(lowered)) continue
    seenUserIds.add(user.id)
    seenUsernames.add(lowered)
    normalizedUsers.push(user)
  }

  const accessMode = normalizeAccessMode(site)

  return {
    version: CONFIG_VERSION,
    adminPasswordHash: normalizeString(record.adminPasswordHash, ''),
    guestPasswordHash: normalizeString(record.guestPasswordHash, ''),
    site: {
      title: normalizeString(site.title, '绘想'),
      accessMode,
      failoverEnabled: normalizeBool(site.failoverEnabled, true),
      failoverMaxAttempts: normalizeInt(site.failoverMaxAttempts, 0, 0, 50),
      allowGuestParamOverride: normalizeBool(site.allowGuestParamOverride, true),
      ...normalizeAgentSettings(site, normalizedChannels),
      ...normalizeRegistration(site, accessMode),
      smtp: normalizeSmtp(site),
      wechat: normalizeWechat(site),
      credits: normalizeCreditSettings(site),
    },
    users: normalizedUsers,
    channels: normalizedChannels,
    customProviders: Array.isArray(record.customProviders) ? record.customProviders.filter(isRecord) : [],
    updatedAt: normalizeInt(record.updatedAt, 0, 0, Number.MAX_SAFE_INTEGER),
  }
}

export function getConfig() {
  if (!cache) throw new Error('配置尚未初始化')
  return cache
}

export function updateConfig(mutator) {
  const next = normalizeConfig(mutator(structuredClone(getConfig())))
  next.updatedAt = Date.now()
  writeConfigFile(next)
  cache = next
  return cache
}

// ===== 口令哈希 =====

export function hashPassword(password) {
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

export function verifyPassword(password, stored) {
  if (!stored) return false
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false

  try {
    const salt = Buffer.from(parts[1], 'hex')
    const expected = Buffer.from(parts[2], 'hex')
    const derived = scryptSync(password, salt, expected.length)
    return timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

// ===== 对外投影 =====

/** 前端可见的渠道投影：不含 apiKey，也不含真实 baseUrl。 */
export function toPublicChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    description: channel.description,
    provider: channel.provider,
    model: channel.model,
    apiMode: channel.apiMode,
    timeout: channel.timeout,
    codexCli: channel.codexCli,
    responseFormatB64Json: channel.responseFormatB64Json,
    streamImages: channel.streamImages,
    streamPartialImages: channel.streamPartialImages,
    reasoningEffort: channel.reasoningEffort,
    transparentBackgroundMethod: channel.transparentBackgroundMethod,
  }
}

/** 后台可见的渠道投影：密钥只回传掩码，避免管理页把密钥再打一遍到网络上。 */
export function toAdminChannel(channel) {
  return {
    ...channel,
    apiKey: undefined,
    apiKeyMask: maskApiKey(channel.apiKey),
    hasApiKey: Boolean(channel.apiKey),
  }
}

export function maskApiKey(apiKey) {
  if (!apiKey) return ''
  if (apiKey.length <= 8) return '*'.repeat(apiKey.length)
  return `${apiKey.slice(0, 4)}${'*'.repeat(Math.min(12, apiKey.length - 8))}${apiKey.slice(-4)}`
}

/** 后台可见的微信设置投影：AppSecret 与 Token 都是凭据，只回掩码。 */
/**
 * 微信配置的后台投影。
 *
 * 三处刻意的不透明处理：
 *   1. AppSecret / Token / EncodingAESKey 只回"有没有"和打码后的样子。
 *      后台的"留空表示不修改"依赖这个 mask，让管理员确认填过什么而不必读出明文。
 *   2. 二维码图片可能是 400KB 的 data URL，而 state 是每次操作后都要重拉的接口，
 *      把它塞进去纯属浪费带宽。要展示时前端直接引用同源的 /api/wechat/qr-image。
 *   3. enabled 用服务端算过的那份——它要求 AppID+AppSecret+Token 齐全，
 *      原样回传管理员勾的复选框只会让人以为"开了"，实际根本不工作。
 */
export function toAdminWechat(site) {
  const wechat = site.wechat
  return {
    appId: wechat.appId,
    appSecretMask: maskApiKey(wechat.appSecret),
    hasAppSecret: Boolean(wechat.appSecret),
    tokenMask: maskApiKey(wechat.token),
    hasToken: Boolean(wechat.token),
    encodingAesKeyMask: maskApiKey(wechat.encodingAesKey),
    hasEncodingAesKey: Boolean(wechat.encodingAesKey),
    qrcodeImage: '',
    hasQrcodeImage: Boolean(wechat.qrcodeImage),
    loginMode: wechat.loginMode,
    replyText: wechat.replyText,
    fetchProfile: wechat.fetchProfile,
    enabled: wechat.enabled,
  }
}

/** 下发给前端的渠道：只保留启用且已配置密钥的，顺序即故障转移顺序。 */
export function getEnabledChannels() {
  return getConfig().channels.filter((channel) => channel.enabled && channel.apiKey)
}

/**
 * 后台可见的站点设置投影。
 *
 * 把两处凭据从 site 里剔掉：微信的 AppSecret / Token / EncodingAESKey，以及 SMTP 授权码。
 * 它们各自有专门的带掩码投影（toAdminWechat / toAdminSmtp）。
 * 原样把整个 site 丢给前端，等于让这些密钥在管理页每次刷新时都过一次网络。
 */
export function toAdminSite(site) {
  const { wechat, smtp, ...rest } = site
  return rest
}

/**
 * 邮件发信设置的后台投影。
 * 授权码（password）只回"有没有"和打码后的样子——
 * 后台的"留空表示不修改"依赖这个 mask，让管理员确认填过什么而不必读出明文。
 */
export function toAdminSmtp(site) {
  const smtp = site.smtp
  return {
    enabled: smtp.enabled,
    host: smtp.host,
    port: smtp.port,
    encryption: smtp.encryption,
    user: smtp.user,
    passwordMask: maskApiKey(smtp.password),
    hasPassword: Boolean(smtp.password),
    from: smtp.from,
    fromName: smtp.fromName,
    allowUnauthorized: smtp.allowUnauthorized,
    dailyLimitPerEmail: smtp.dailyLimitPerEmail,
    hourlyLimitPerIp: smtp.hourlyLimitPerIp,
  }
}

export function findChannel(id) {
  return getConfig().channels.find((channel) => channel.id === id) ?? null
}

// ===== 用户 =====

export function findUserById(id) {
  return getConfig().users.find((user) => user.id === id) ?? null
}

/** 用户名不区分大小写：避免 Alice 和 alice 变成两个账号却共用一个心理预期。 */
export function findUserByUsername(username) {
  const target = String(username ?? '').trim().toLowerCase()
  if (!target) return null
  return getConfig().users.find((user) => user.username.toLowerCase() === target) ?? null
}

/**
 * 邮箱查找。存的时候已经统一小写，这里再兜一次是为了兼容老配置里的大小写混写。
 * 注册要拿它挡重复：不然同一台邮箱能反复注册小号来领注册赠送的积分。
 */
export function findUserByEmail(email) {
  const target = String(email ?? '').trim().toLowerCase()
  if (!target) return null
  return getConfig().users.find((user) => user.email && user.email === target) ?? null
}

/** openid 是微信登录的唯一主键：同一个人反复扫码必须落到同一个账号。 */
export function findUserByOpenId(openid) {
  const target = String(openid ?? '').trim()
  if (!target) return null
  return getConfig().users.find((user) => user.wechatOpenId === target) ?? null
}

/** 前台可见的用户投影：只给展示需要的字段。 */
export function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.wechatNickname || user.displayName || user.username,
    avatar: user.wechatAvatar || '',
    // 邮箱回给本人是合理的（用户中心要显示"绑定的是哪个邮箱"），
    // 但它只在本人的响应里出现，不会出现在任何列表接口中。
    email: user.email || '',
    // 管理员身份要跟着本人走：登录响应和 bootstrap 都靠它分流后台入口。
    role: user.role === 'admin' ? 'admin' : 'user',
  }
}

/** 后台可见的用户投影：口令只回传"是否已设置"，永不回传哈希。 */
export function toAdminUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email || '',
    emailVerified: Boolean(user.emailVerifiedAt),
    enabled: user.enabled,
    role: user.role === 'admin' ? 'admin' : 'user',
    note: user.note,
    createdVia: user.createdVia,
    hasPassword: Boolean(user.passwordHash),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastSeenAt: user.lastSeenAt,
    // 微信身份：openid 绝不回传（它本身就是一个可用来定位用户的标识），
    // 只回"是不是微信账号"和展示用的昵称头像。
    wechat: Boolean(user.wechatOpenId),
    wechatNickname: user.wechatNickname,
    wechatAvatar: user.wechatAvatar,
    wechatSubscribed: user.wechatSubscribed,
  }
}

/**
 * 注册当前是否开放，以及为什么不开。
 * 返回具体原因而不是布尔值：注册页要把"名额用完了"和"过期了"分开告诉用户，
 * 否则他只会反复重试同一个码。
 *
 * 注意：这里**不检查邮箱发信有没有配好**——发信坏了是 503（服务器的问题），
 * 不是 403（你没资格注册）。两件事在注册页上要给用户完全不同的提示。
 */
export function inviteStatus(site, now = Date.now()) {
  if (!site.registrationEnabled) return { ok: false, reason: 'disabled' }
  // 不要求邀请码时，直接放行；主关卡是邮箱验证码。
  if (!site.requireInviteCode) return { ok: true, reason: '' }
  if (!site.inviteCode) return { ok: false, reason: 'disabled' }
  if (site.inviteExpiresAt && now > site.inviteExpiresAt) return { ok: false, reason: 'expired' }
  if (site.inviteMaxUses && site.inviteUsedCount >= site.inviteMaxUses) return { ok: false, reason: 'exhausted' }
  return { ok: true, reason: '' }
}
