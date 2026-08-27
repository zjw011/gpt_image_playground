// 配置持久化：单个 JSON 文件 + 原子写入 + 内存缓存。
// 选 JSON 而非 SQLite 是为了零原生依赖，渠道数量级在几十条，读写全量完全够用。

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const CONFIG_VERSION = 1
const SCRYPT_KEYLEN = 64

export const BUILT_IN_PROVIDERS = new Set(['openai', 'sb2api-async', 'fal'])

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
      title: 'GPT Image Playground',
      // 默认不开门禁：首次部署时前端就能直接用；设置访客口令后由管理员或 GIP_GUEST_PASSWORD 开启。
      guestGateEnabled: false,
      failoverEnabled: true,
      failoverMaxAttempts: 0,
      allowGuestParamOverride: true,
    },
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

  return {
    version: CONFIG_VERSION,
    adminPasswordHash: normalizeString(record.adminPasswordHash, ''),
    guestPasswordHash: normalizeString(record.guestPasswordHash, ''),
    site: {
      title: normalizeString(site.title, 'GPT Image Playground'),
      guestGateEnabled: normalizeBool(site.guestGateEnabled, false),
      failoverEnabled: normalizeBool(site.failoverEnabled, true),
      failoverMaxAttempts: normalizeInt(site.failoverMaxAttempts, 0, 0, 50),
      allowGuestParamOverride: normalizeBool(site.allowGuestParamOverride, true),
    },
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
