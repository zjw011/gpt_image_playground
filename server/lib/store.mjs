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
      inviteCode: '',
      inviteMaxUses: 0,
      inviteUsedCount: 0,
      inviteExpiresAt: 0,
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
        packs: [],
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
    enabled: normalizeBool(record.enabled, true),
    note: normalizeString(record.note, ''),
    // 区分账号是怎么来的，后台名册上要能一眼看出来。
    createdVia: record.createdVia === 'invite' ? 'invite' : record.createdVia === 'wechat' ? 'wechat' : 'admin',
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
 * 注册只在多用户模式下有意义——别的模式下根本没有"账号"这个概念，
 * 所以这里会在缺少邀请码或不是 accounts 模式时把开关强制关掉，而不是留一个半开的状态。
 */
function normalizeRegistration(site, accessMode) {
  const inviteCode = normalizeString(site.inviteCode, '').trim()
  const expiresAt = normalizeInt(site.inviteExpiresAt, 0, 0, Number.MAX_SAFE_INTEGER)

  return {
    registrationEnabled: normalizeBool(site.registrationEnabled, false) && accessMode === 'accounts' && Boolean(inviteCode),
    inviteCode,
    inviteMaxUses: normalizeInt(site.inviteMaxUses, 0, 0, 10_000),
    inviteUsedCount: normalizeInt(site.inviteUsedCount, 0, 0, Number.MAX_SAFE_INTEGER),
    inviteExpiresAt: expiresAt,
  }
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
      price: normalizeString(pack.price, '').trim().slice(0, 20),
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
  }
}

/** 后台可见的用户投影：口令只回传"是否已设置"，永不回传哈希。 */
export function toAdminUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    enabled: user.enabled,
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
 * 邀请码当前是否还能用。
 * 返回具体原因而不是布尔值：注册页要把"名额用完了"和"过期了"分开告诉用户，
 * 否则他只会反复重试同一个码。
 */
export function inviteStatus(site, now = Date.now()) {
  if (!site.registrationEnabled) return { ok: false, reason: 'disabled' }
  if (!site.inviteCode) return { ok: false, reason: 'disabled' }
  if (site.inviteExpiresAt && now > site.inviteExpiresAt) return { ok: false, reason: 'expired' }
  if (site.inviteMaxUses && site.inviteUsedCount >= site.inviteMaxUses) return { ok: false, reason: 'exhausted' }
  return { ok: true, reason: '' }
}
