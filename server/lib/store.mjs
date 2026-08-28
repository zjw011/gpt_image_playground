// 配置持久化：单个 JSON 文件 + 原子写入 + 内存缓存。
// 选 JSON 而非 SQLite 是为了零原生依赖，渠道数量级在几十条，读写全量完全够用。

import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const CONFIG_VERSION = 2
const SCRYPT_KEYLEN = 64

export const BUILT_IN_PROVIDERS = new Set(['openai', 'sb2api-async', 'fal'])

/** 访问方式：open 任何人可用、passcode 共享口令、accounts 逐用户账号（数据互相隔离）。 */
export const ACCESS_MODES = new Set(['open', 'passcode', 'accounts'])

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
    createdAt: normalizeInt(record.createdAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    updatedAt: normalizeInt(record.updatedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    lastSeenAt: normalizeInt(record.lastSeenAt, 0, 0, Number.MAX_SAFE_INTEGER),
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

  return {
    version: CONFIG_VERSION,
    adminPasswordHash: normalizeString(record.adminPasswordHash, ''),
    guestPasswordHash: normalizeString(record.guestPasswordHash, ''),
    site: {
      title: normalizeString(site.title, '绘想'),
      accessMode: normalizeAccessMode(site),
      failoverEnabled: normalizeBool(site.failoverEnabled, true),
      failoverMaxAttempts: normalizeInt(site.failoverMaxAttempts, 0, 0, 50),
      allowGuestParamOverride: normalizeBool(site.allowGuestParamOverride, true),
      ...normalizeAgentSettings(site, normalizedChannels),
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

/** 后台可见的用户投影：口令只回传"是否已设置"，永不回传哈希。 */
export function toAdminUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    enabled: user.enabled,
    note: user.note,
    hasPassword: Boolean(user.passwordHash),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastSeenAt: user.lastSeenAt,
  }
}
