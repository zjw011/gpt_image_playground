// 后端托管模式：渠道与密钥由服务端后台管理，前端只拿到渠道 id 与显示信息。
// 请求打到同源 /api/relay/<channelId>/，由服务端补上真实地址与 Authorization。

import type { ApiMode, ApiProfile, CustomProviderDefinition } from '../types'
import { normalizeCustomProviderDefinitions } from './apiProfiles'
import { useCreditsStore } from './creditsStore'

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

/** 访问方式：open 任何人可用、passcode 共享口令、accounts 逐用户账号、wechat 微信扫码（数据互相隔离）。 */
export type BackendAccessMode = 'open' | 'passcode' | 'accounts' | 'wechat'

export interface BackendUser {
  id: string
  username: string
  displayName: string
  /** 微信头像地址；非微信登录的用户拿不到，显示时回退到首字母。 */
  avatar?: string
}

/** 后台配置的充值套餐，只用于展示，真正的兑换发生在卡密那一层。 */
export interface BackendCreditPack {
  name: string
  price: string
  credits: number
}

export interface BackendCreditsConfig {
  enabled: boolean
  /** 单张图的基准价（分）。实际扣费还要乘上渠道倍率。 */
  costPerImage: number
  /** 用户自助购买卡密的链接，由管理员填写。留空则不显示购买入口。 */
  purchaseUrl: string
  packs: BackendCreditPack[]
}

export type BackendLedgerType = 'signup' | 'redeem' | 'spend' | 'refund' | 'admin'

export interface BackendLedgerEntry {
  at: number
  type: BackendLedgerType
  amount: number
  balanceAfter: number
  ref: string
  note: string
}

/** 当前账号的余额视图。数字都是整数积分，前端不做任何浮点换算。 */
export interface BackendCreditsView {
  balance: number
  /** 在途占位：已发起但还没结算的请求，可用余额要减掉它。 */
  reserved: number
  available: number
  totalIn: number
  totalOut: number
  ledger: BackendLedgerEntry[]
}

/**
 * bootstrap 里的 credits 是「配置 + 当前账号视图」的合并体：
 * 未登录或未启用时只有配置部分，登录后额外带上余额与流水。
 */
export type BackendCredits = BackendCreditsConfig & Partial<BackendCreditsView>

/** 登录页需要知道的微信配置。凭据（AppSecret / Token）一律不下发。 */
export interface BackendWechatConfig {
  enabled: boolean
  /** code = 扫码关注后回 6 位验证码；qrcode = 带参数二维码扫码即登录（仅微信认证服务号可用）。 */
  loginMode: 'code' | 'qrcode'
  hasQrcodeImage: boolean
}

/** 发起登录的返回。两种模式共用外壳，差异字段按需出现。 */
export interface BackendWechatLoginStart {
  mode: 'code' | 'qrcode'
  pollToken: string
  /** code 模式下电脑要显示给用户的那串数字。 */
  code?: string
  /** qrcode 模式：同源的二维码图片地址，直接塞进 img src。 */
  qrUrl?: string
  /** code 模式：管理员上传的公众号固定二维码（可能是 data: 内联图）。 */
  qrImage?: string
  expiresIn: number
  /** 请求的是带参数二维码但调用失败、已自动降级到验证码模式。 */
  degraded?: boolean
  degradedReason?: string
}

export type BackendWechatPoll =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'ok', user: BackendUser, workspaceId: string, credits: BackendCreditsView | null }

export interface BackendBootstrap {
  backendMode: true
  initialized: boolean
  accessMode: BackendAccessMode
  guestPasswordSet: boolean
  userCount: number
  authenticated: boolean
  user: BackendUser | null
  workspaceId: string
  /** 是否开放凭邀请码自助注册。只在 accounts 模式下可能为 true。 */
  registrationOpen: boolean
  credits: BackendCredits
  wechat: BackendWechatConfig
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

/** 积分设置。非托管模式或后台没开积分制时为 null，界面据此隐藏所有积分入口。 */
export function getCreditsConfig(): BackendCreditsConfig | null {
  if (!bootstrap?.credits.enabled) return null
  return {
    enabled: bootstrap.credits.enabled,
    costPerImage: bootstrap.credits.costPerImage,
    purchaseUrl: bootstrap.credits.purchaseUrl,
    packs: bootstrap.credits.packs,
  }
}

/**
 * 当前账号的余额视图，未登录或未启用积分时为 null。
 *
 * 从 creditsStore 读而不是从 bootstrap 快照读：生图扣费不会重新拉 bootstrap，
 * 快照会一直停在启动那一刻的数字上。
 */
export function getCreditsView(): BackendCreditsView | null {
  return useCreditsStore.getState().view
}

/** 从合并体里剥出纯余额部分。没有 balance 字段就代表服务端没下发余额。 */
function creditsViewOf(credits: BackendCredits): BackendCreditsView | null {
  if (typeof credits.balance !== 'number') return null
  return {
    balance: credits.balance,
    reserved: credits.reserved ?? 0,
    available: credits.available ?? credits.balance,
    totalIn: credits.totalIn ?? 0,
    totalOut: credits.totalOut ?? 0,
    ledger: credits.ledger ?? [],
  }
}

export function getWechatConfig(): BackendWechatConfig | null {
  return bootstrap?.wechat ?? null
}

/**
 * 用服务端刚回传的余额覆盖本地缓存。
 *
 * 兑换与生图都会返回最新余额，直接写回这里而不是重新拉一次 bootstrap——
 * bootstrap 顺带会带回渠道等一大堆东西，为了一个数字去重新解析它不划算。
 */
export function applyCreditsView(view: BackendCreditsView) {
  useCreditsStore.getState().setView(view)
}

/** 只更新数字字段（生图的响应头只带扣费与余额，不带流水）。 */
export function applyCreditsBalance(patch: Partial<BackendCreditsView>) {
  useCreditsStore.getState().patch(patch)
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

/** 服务端下发的数字都当作不可信输入：非有限数一律归零，避免 NaN 顺着界面扩散。 */
function toCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function normalizeLedger(input: unknown): BackendLedgerEntry[] {
  if (!Array.isArray(input)) return []
  const types = new Set<BackendLedgerType>(['signup', 'redeem', 'spend', 'refund', 'admin'])
  return input.filter(isRecord).map((entry) => ({
    at: toCount(entry.at),
    type: types.has(entry.type as BackendLedgerType) ? entry.type as BackendLedgerType : 'admin',
    amount: toCount(entry.amount),
    balanceAfter: toCount(entry.balanceAfter),
    ref: typeof entry.ref === 'string' ? entry.ref : '',
    note: typeof entry.note === 'string' ? entry.note : '',
  }))
}

/**
 * 余额视图整体可选：未登录、未启用积分时服务端不下发这些字段。
 * 只有五个数字字段齐全才认，否则宁可当"没有余额信息"，也不显示一个半真的数字。
 */
function normalizeCreditsView(input: Record<string, unknown>): BackendCreditsView | null {
  if (typeof input.balance !== 'number' || !Number.isFinite(input.balance)) return null
  return {
    balance: toCount(input.balance),
    reserved: toCount(input.reserved),
    available: typeof input.available === 'number' && Number.isFinite(input.available) ? toCount(input.available) : toCount(input.balance),
    totalIn: toCount(input.totalIn),
    totalOut: toCount(input.totalOut),
    ledger: normalizeLedger(input.ledger),
  }
}

function normalizeCredits(input: unknown): BackendCredits {
  const raw = isRecord(input) ? input : {}
  const view = normalizeCreditsView(raw)
  return {
    enabled: raw.enabled === true,
    costPerImage: toCount(raw.costPerImage),
    purchaseUrl: typeof raw.purchaseUrl === 'string' ? raw.purchaseUrl.trim() : '',
    packs: (Array.isArray(raw.packs) ? raw.packs : [])
      .filter(isRecord)
      .map((pack) => ({
        name: typeof pack.name === 'string' ? pack.name : '',
        price: typeof pack.price === 'string' ? pack.price : '',
        credits: toCount(pack.credits),
      }))
      .filter((pack) => pack.credits > 0),
    ...(view ?? {}),
  }
}

function normalizeWechatConfig(input: unknown): BackendWechatConfig {
  const raw = isRecord(input) ? input : {}
  return {
    enabled: raw.enabled === true,
    loginMode: raw.loginMode === 'qrcode' ? 'qrcode' : 'code',
    hasQrcodeImage: raw.hasQrcodeImage === true,
  }
}

function normalizeBootstrap(input: unknown): BackendBootstrap | null {
  if (!isRecord(input) || input.backendMode !== true) return null
  const site = isRecord(input.site) ? input.site : {}
  const rawChannels = Array.isArray(input.channels) ? input.channels : []
  const rawUser = isRecord(input.user) ? input.user : null
  const accessMode = input.accessMode === 'passcode' || input.accessMode === 'accounts' || input.accessMode === 'wechat'
    ? input.accessMode
    : 'open'

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
          avatar: typeof rawUser.avatar === 'string' ? rawUser.avatar : '',
        }
      : null,
    workspaceId: typeof input.workspaceId === 'string' && input.workspaceId ? input.workspaceId : 'shared',
    registrationOpen: input.registrationOpen === true,
    credits: normalizeCredits(input.credits),
    wechat: normalizeWechatConfig(input.wechat),
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
    const next = normalizeBootstrap(await response.json())
    bootstrap = next
    // 登录状态下 bootstrap 会顺带把余额下发，这里灌进 creditsStore 作为初始值。
    // 未登录 / 未启用积分时是 null，界面自然就不会显示积分入口。
    useCreditsStore.getState().setView(next ? creditsViewOf(next.credits) : null)
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

/** 凭邀请码自助注册。成功后服务端直接下发会话，不需要再登录一次。 */
export async function submitRegister(input: { username: string, password: string, inviteCode: string }) {
  const response = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
  return payload
}

/** 从 URL 读邀请码。管理员发出的邀请链接形如 `/?invite=xxxx-yyyyy`。 */
export function readInviteFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get('invite')?.trim() ?? ''
  } catch {
    return ''
  }
}

/**
 * 服务端错误的统一读法。
 *
 * 服务端把"是什么错"放在 `code` 这类结构化字段里，人话放 `error` 里。
 * 调用方想按 code 分流就调 pickErrorCode，想直接展示就调 extractErrorMessage。
 */
async function readErrorPayload(response: Response) {
  const payload = await response.json().catch(() => ({}))
  return isRecord(payload) ? payload : {}
}

function extractErrorMessage(payload: Record<string, unknown>, fallback: string) {
  return typeof payload.error === 'string' && payload.error ? payload.error : fallback
}

/** 错误码：`insufficient-credits` 这类。界面据此决定弹充值入口还是弹普通报错。 */
export function pickErrorCode(error: unknown): string {
  return typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : ''
}

/** 带错误码的异常。普通 Error 也能用，只是拿不到 code。 */
class BackendRequestError extends Error {
  code: string
  payload: Record<string, unknown>

  constructor(message: string, code: string, payload: Record<string, unknown>) {
    super(message)
    this.name = 'BackendRequestError'
    this.code = code
    this.payload = payload
  }
}

function toRequestError(payload: Record<string, unknown>, status: number): BackendRequestError {
  return new BackendRequestError(
    extractErrorMessage(payload, `HTTP ${status}`),
    typeof payload.code === 'string' ? payload.code : '',
    payload,
  )
}

// ===== 微信扫码登录 =====

/** 发起一次微信登录。返回的 pollToken 拿去轮询，剩下的字段决定界面怎么画。 */
export async function startWechatLogin(): Promise<BackendWechatLoginStart> {
  const response = await fetch('/api/wechat/login', { method: 'POST' })
  const payload = await readErrorPayload(response)
  if (!response.ok) throw toRequestError(payload, response.status)

  const pollToken = typeof payload.pollToken === 'string' ? payload.pollToken : ''
  if (!pollToken) throw new Error('服务端没有返回登录令牌，请刷新页面重试')

  return {
    mode: payload.mode === 'qrcode' ? 'qrcode' : 'code',
    pollToken,
    code: typeof payload.code === 'string' ? payload.code : '',
    qrUrl: typeof payload.qrUrl === 'string' ? payload.qrUrl : '',
    qrImage: typeof payload.qrImage === 'string' ? payload.qrImage : '',
    expiresIn: typeof payload.expiresIn === 'number' && Number.isFinite(payload.expiresIn) ? payload.expiresIn : 600,
    degraded: payload.degraded === true,
    degradedReason: typeof payload.degradedReason === 'string' ? payload.degradedReason : '',
  }
}

/** 轮询登录结果。pending / expired 都是正常的业务状态，不该当异常抛。 */
export async function pollWechatLogin(pollToken: string): Promise<BackendWechatPoll> {
  const response = await fetch(`/api/wechat/login?t=${encodeURIComponent(pollToken)}`, {
    headers: { Accept: 'application/json' },
  })
  const payload = await readErrorPayload(response)
  if (!response.ok) throw toRequestError(payload, response.status)

  if (payload.status !== 'ok') {
    return { status: payload.status === 'expired' ? 'expired' : 'pending' }
  }

  const rawUser = isRecord(payload.user) ? payload.user : null
  return {
    status: 'ok',
    user: rawUser
      ? {
          id: typeof rawUser.id === 'string' ? rawUser.id : '',
          username: typeof rawUser.username === 'string' ? rawUser.username : '',
          displayName: typeof rawUser.displayName === 'string' ? rawUser.displayName : '',
          avatar: typeof rawUser.avatar === 'string' ? rawUser.avatar : '',
        }
      : { id: '', username: '', displayName: '', avatar: '' },
    workspaceId: typeof payload.workspaceId === 'string' ? payload.workspaceId : 'shared',
    credits: isRecord(payload.credits) ? normalizeCreditsView(payload.credits) : null,
  }
}

// ===== 积分 =====

/** 拉一次余额与流水。redeem 之后其实不需要它——兑换接口已经把新余额一起回了。 */
export async function fetchCredits(): Promise<BackendCreditsView> {
  const response = await fetch('/api/credits', { headers: { Accept: 'application/json' } })
  const payload = await readErrorPayload(response)
  if (!response.ok) throw toRequestError(payload, response.status)

  const view = normalizeCreditsView(payload)
  if (!view) throw new Error('服务端返回的余额数据格式不正确')
  applyCreditsView(view)
  return view
}

export interface RedeemResult extends BackendCreditsView {
  /** 这次兑换到账的积分数。 */
  credited: number
}

/**
 * 兑换卡密。
 *
 * 失败原因（卡密不存在 / 已使用 / 已作废）都由服务端措辞后放在 error 里，
 * 前端不重复维护一套文案表——两处都写必然有一天会对不上。
 */
export async function redeemCardCode(code: string): Promise<RedeemResult> {
  const response = await fetch('/api/credits/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  const payload = await readErrorPayload(response)
  if (!response.ok) throw toRequestError(payload, response.status)

  const view = normalizeCreditsView(payload)
  if (!view) throw new Error('兑换成功，但服务端没返回余额，请刷新页面确认')
  applyCreditsView(view)
  return { ...view, credited: toCount(payload.credited) }
}

/**
 * 卡密输入的实时整理：转大写、只留字母数字、按 3-4-4-4 分组（对齐 GIP-XXXX-XXXX-XXXX）。
 *
 * 服务端本来就会归一化，这里做一遍纯粹是为了让用户在输入框里看到自己打了什么——
 * 卡密是从纸上抄的，分隔符对不上最容易让人以为"卡密错了"。
 * 首段固定 3 位而不是 4 位，是为了让边打边显示时前缀不会先滑一格再滑回来。
 */
export function formatCardCodeInput(value: string) {
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15)
  if (!cleaned) return ''
  const head = cleaned.slice(0, 3)
  const rest = cleaned.slice(3).match(/.{1,4}/g)
  return rest ? `${head}-${rest.join('-')}` : head
}

