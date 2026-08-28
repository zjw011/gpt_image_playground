// 后端托管模式：渠道与密钥由服务端后台管理，前端只拿到渠道 id 与显示信息。
// 请求打到同源 /api/relay/<channelId>/，由服务端补上真实地址与 Authorization。

import type { ApiMode, ApiProfile, CustomProviderDefinition } from '../types'
import { normalizeCustomProviderDefinitions } from './apiProfiles'

/** 占位密钥：只为通过前端的必填校验，真实凭据由服务端注入后覆盖。 */
export const BACKEND_MANAGED_API_KEY = 'backend-managed'

export interface BackendChannel {
  id: string
  name: string
  description: string
  provider: string
  model: string
  apiMode: ApiMode
  timeout: number
  codexCli: boolean
  responseFormatB64Json: boolean
  streamImages: boolean
  streamPartialImages: number
  reasoningEffort?: string
  transparentBackgroundMethod: 'api' | 'local'
}

export interface BackendSite {
  title: string
  failoverEnabled: boolean
  failoverMaxAttempts: number
  allowGuestParamOverride: boolean
  /** Agent 接入方式，由后台统一决定；off 时前端不显示 Agent 入口。 */
  agentMode: 'off' | 'native' | 'hybrid'
  agentTextChannelId: string
  agentImageChannelId: string
  agentMaxToolRounds: number
  agentWebSearch: boolean
}

/** 访问方式：open 任何人可用、passcode 共享口令、accounts 逐用户账号（数据互相隔离）。 */
export type BackendAccessMode = 'open' | 'passcode' | 'accounts'

export interface BackendUser {
  id: string
  username: string
  displayName: string
}

export interface BackendBootstrap {
  backendMode: true
  initialized: boolean
  accessMode: BackendAccessMode
  guestPasswordSet: boolean
  userCount: number
  authenticated: boolean
  user: BackendUser | null
  workspaceId: string
  site: BackendSite
  channels: BackendChannel[]
  customProviders: CustomProviderDefinition[]
}

let bootstrap: BackendBootstrap | null = null

export function getBackendBootstrap() {
  return bootstrap
}

export function isBackendMode() {
  return bootstrap !== null
}

/** 后端模式下前端不允许自建/编辑渠道，设置页只做只读展示。 */
export function isBackendLocked() {
  return bootstrap !== null && bootstrap.authenticated
}

/** 管理员可以在后台禁止访客改尺寸/质量等参数，此时输入栏隐藏参数面板。 */
export function isGuestParamOverrideAllowed() {
  return bootstrap === null || bootstrap.site.allowGuestParamOverride
}

/** 多用户模式下 Header 要显示当前账号并提供退出入口。 */
export function getBackendUser() {
  return bootstrap?.user ?? null
}

/** 站点名：托管模式下跟着后台的「站点标题」走，管理员改一处顶栏和标签页一起变。 */
export function getSiteTitle() {
  return bootstrap?.site.title ?? '绘想'
}

/**
 * Agent 入口是否可用。后端托管模式下完全由管理员的 agentMode 决定——
 * 关着就不该在前端露出按钮，否则用户点进去只会撞一个"请去配置"的弹窗，而他本来就无处可配。
 */
export function isAgentAvailable() {
  return bootstrap === null || bootstrap.site.agentMode !== 'off'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeChannel(input: unknown, idx: number): BackendChannel | null {
  if (!isRecord(input)) return null
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!id) return null

  return {
    id,
    name: typeof input.name === 'string' && input.name.trim() ? input.name : `渠道 ${idx + 1}`,
    description: typeof input.description === 'string' ? input.description : '',
    provider: typeof input.provider === 'string' && input.provider.trim() ? input.provider : 'openai',
    model: typeof input.model === 'string' && input.model.trim() ? input.model : 'gpt-image-2',
    apiMode: input.apiMode === 'responses' ? 'responses' : 'images',
    timeout: typeof input.timeout === 'number' && Number.isFinite(input.timeout) ? input.timeout : 600,
    codexCli: input.codexCli === true,
    responseFormatB64Json: input.responseFormatB64Json === true,
    streamImages: input.streamImages === true,
    streamPartialImages: typeof input.streamPartialImages === 'number' ? input.streamPartialImages : 1,
    reasoningEffort: typeof input.reasoningEffort === 'string' && input.reasoningEffort ? input.reasoningEffort : undefined,
    transparentBackgroundMethod: input.transparentBackgroundMethod === 'local' ? 'local' : 'api',
  }
}

function normalizeBootstrap(input: unknown): BackendBootstrap | null {
  if (!isRecord(input) || input.backendMode !== true) return null
  const site = isRecord(input.site) ? input.site : {}
  const rawChannels = Array.isArray(input.channels) ? input.channels : []
  const rawUser = isRecord(input.user) ? input.user : null
  const accessMode = input.accessMode === 'passcode' || input.accessMode === 'accounts' ? input.accessMode : 'open'

  return {
    backendMode: true,
    initialized: input.initialized === true,
    accessMode,
    guestPasswordSet: input.guestPasswordSet === true,
    userCount: typeof input.userCount === 'number' && Number.isFinite(input.userCount) ? input.userCount : 0,
    authenticated: input.authenticated === true,
    user: rawUser && typeof rawUser.id === 'string' && typeof rawUser.username === 'string'
      ? {
          id: rawUser.id,
          username: rawUser.username,
          displayName: typeof rawUser.displayName === 'string' ? rawUser.displayName : '',
        }
      : null,
    workspaceId: typeof input.workspaceId === 'string' && input.workspaceId ? input.workspaceId : 'shared',
    site: {
      title: typeof site.title === 'string' && site.title.trim() ? site.title : '绘想',
      failoverEnabled: site.failoverEnabled !== false,
      failoverMaxAttempts: typeof site.failoverMaxAttempts === 'number' && Number.isFinite(site.failoverMaxAttempts)
        ? Math.max(0, Math.trunc(site.failoverMaxAttempts))
        : 0,
      allowGuestParamOverride: site.allowGuestParamOverride !== false,
      agentMode: site.agentMode === 'native' || site.agentMode === 'hybrid' ? site.agentMode : 'off',
      agentTextChannelId: typeof site.agentTextChannelId === 'string' ? site.agentTextChannelId : '',
      agentImageChannelId: typeof site.agentImageChannelId === 'string' ? site.agentImageChannelId : '',
      agentMaxToolRounds: typeof site.agentMaxToolRounds === 'number' && Number.isFinite(site.agentMaxToolRounds)
        ? Math.min(100, Math.max(1, Math.trunc(site.agentMaxToolRounds)))
        : 15,
      agentWebSearch: site.agentWebSearch === true,
    },
    channels: rawChannels.map(normalizeChannel).filter((channel): channel is BackendChannel => channel !== null),
    customProviders: normalizeCustomProviderDefinitions(input.customProviders),
  }
}

/** 拉取后端引导信息。不存在后端（纯静态部署）时返回 null，前端退回自带配置模式。 */
export async function loadBackendBootstrap(): Promise<BackendBootstrap | null> {
  try {
    const response = await fetch('/api/bootstrap', { headers: { Accept: 'application/json' } })
    if (!response.ok) return null
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) return null
    bootstrap = normalizeBootstrap(await response.json())
    return bootstrap
  } catch {
    return null
  }
}

export function getRelayBaseUrl(channelId: string) {
  // 结尾的 / 让 buildApiUrl 直接拼接端点，不再自动插入 /v1（版本前缀交给服务端按渠道地址决定）。
  return `${window.location.origin}/api/relay/${encodeURIComponent(channelId)}/`
}

export function backendChannelToApiProfile(channel: BackendChannel): ApiProfile {
  return {
    id: `backend-${channel.id}`,
    name: channel.name,
    description: channel.description || undefined,
    provider: channel.provider,
    baseUrl: getRelayBaseUrl(channel.id),
    apiKey: BACKEND_MANAGED_API_KEY,
    model: channel.model,
    timeout: channel.timeout,
    apiMode: channel.apiMode,
    reasoningEffort: channel.reasoningEffort as ApiProfile['reasoningEffort'],
    codexCli: channel.codexCli,
    apiProxy: false,
    responseFormatB64Json: channel.responseFormatB64Json || undefined,
    streamImages: channel.streamImages,
    streamPartialImages: channel.streamPartialImages,
    transparentBackgroundMethod: channel.transparentBackgroundMethod,
  }
}

/** 把后端渠道转成预置配置的形状，交给现有 presetConfig 策略统一收敛。 */
export function backendBootstrapToPresetConfig(data: BackendBootstrap) {
  const profiles = data.channels.map(backendChannelToApiProfile)
  return {
    customProviders: data.customProviders,
    profiles: profiles.map((profile, idx) => (idx === 0 ? { ...profile, isDefault: true } : profile)),
  }
}

/**
 * 后台的 Agent 设置翻译成前端的 settings 字段。
 * 渠道 id 要加上 `backend-` 前缀才对得上 backendChannelToApiProfile 生成的 profile id。
 */
export function backendAgentSettings(data: BackendBootstrap) {
  return {
    agentApiConfigMode: data.site.agentMode,
    agentTextProfileId: data.site.agentTextChannelId ? `backend-${data.site.agentTextChannelId}` : null,
    agentImageProfileId: data.site.agentImageChannelId ? `backend-${data.site.agentImageChannelId}` : null,
    agentMaxToolRounds: data.site.agentMaxToolRounds,
    agentWebSearch: data.site.agentWebSearch,
  }
}

/** 前台登录：passcode 模式只需口令，accounts 模式还要用户名。 */
export async function submitFrontLogin(credentials: { username?: string, password: string }) {
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
  return payload
}

export async function submitFrontLogout() {
  await fetch('/api/session', { method: 'DELETE' }).catch(() => {})
}
