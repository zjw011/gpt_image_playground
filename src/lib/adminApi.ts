// 管理后台 API 客户端。封装 /api/admin/* 接口，统一错误处理。
// 后台已经并入主前端 SPA：这些接口凭 role=admin 的登录会话即可调用。

export interface AdminState {
  initialized: boolean
  authenticated: boolean
  site: Record<string, unknown>
  guestPasswordSet: boolean
  channels: AdminChannel[]
  users: AdminUser[]
  minUserPasswordLength: number
  customProviders: unknown[]
  wechat: Record<string, unknown>
  credits: Record<string, unknown>
  smtp: Record<string, unknown>
  updatedAt: number
}

export interface AdminChannel {
  id: string
  name: string
  provider: string
  baseUrl?: string
  model?: string
  enabled: boolean
  apiKeyMask?: string
  hasApiKey: boolean
  health?: { state: string }
  [key: string]: unknown
}

export interface AdminUser {
  id: string
  username: string
  displayName: string
  email: string
  enabled: boolean
  role?: 'admin' | 'user'
  note: string
  createdVia: string
  hasPassword: boolean
  balance: number
  totalOut: number
  createdAt: number
  lastSeenAt: number
  [key: string]: unknown
}

export interface AdminDashboard {
  stats: {
    imagesToday: number
    imagesOk: number
    imagesFail: number
    userCount: number
    channelCount: number
    channelUp: number
    creditBalance: number
    creditSpent: number
    cardCount: number
    cardUnused: number
  }
  trend: Array<{ day: string, images: number, spent: number }>
  recentLedger: Array<Record<string, unknown>>
  updatedAt: number
}

async function request<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error || `HTTP ${response.status}`)
  }
  return payload as T
}

// ===== 读缓存 =====
// 后台每个页签挂载时都要拉一份全量配置，服务器一慢"点一下卡一下"就很明显。
// 给读接口加个短 TTL：切页签时直接吃缓存秒开；任何写操作之后页面都会带 fresh=true
// 重新拉一遍，缓存随之更新。后台通常就站长一个人在用，几秒的陈旧可以接受。
interface CacheEntry<T> { at: number, data: T }
const readCaches = new Map<string, CacheEntry<unknown>>()

async function cachedRead<T>(key: string, maxAgeMs: number, loader: () => Promise<T>): Promise<T> {
  if (maxAgeMs > 0) {
    const hit = readCaches.get(key) as CacheEntry<T> | undefined
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.data
  }
  const data = await loader()
  readCaches.set(key, { at: Date.now(), data })
  return data
}

export function getAdminState(maxAgeMs = 0) {
  return cachedRead('state', maxAgeMs, () => request<AdminState>('/api/admin/state')) as Promise<AdminState>
}

export function getAdminDashboard(maxAgeMs = 0) {
  return cachedRead('dashboard', maxAgeMs, () => request<AdminDashboard>('/api/admin/dashboard')) as Promise<AdminDashboard>
}

export function getAdminCredits(maxAgeMs = 0) {
  return cachedRead('credits', maxAgeMs, () => request<Record<string, unknown>>('/api/admin/credits')) as Promise<Record<string, unknown>>
}

export function getAdminUsage(maxAgeMs = 0) {
  return cachedRead('usage', maxAgeMs, () => request<Record<string, unknown>>('/api/admin/usage')) as Promise<Record<string, unknown>>
}

export function resetAdminUsage() {
  return request('/api/admin/usage', { method: 'DELETE' })
}

// ===== 渠道 =====
export function createChannel(body: Record<string, unknown>) {
  return request<{ channel: AdminChannel }>('/api/admin/channels', { method: 'POST', body: JSON.stringify(body) })
}
export function updateChannel(id: string, body: Record<string, unknown>) {
  return request<{ channel: AdminChannel }>(`/api/admin/channels/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) })
}
export function deleteChannel(id: string) {
  return request(`/api/admin/channels/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
export function reorderChannels(order: string[]) {
  return request<{ channels: AdminChannel[] }>('/api/admin/channels/reorder', { method: 'POST', body: JSON.stringify({ order }) })
}
export function testChannel(id: string) {
  return request<Record<string, unknown>>('/api/admin/channels/test', { method: 'POST', body: JSON.stringify({ id }) })
}
export function testAllChannels() {
  return request<{ results: Array<Record<string, unknown>> }>('/api/admin/channels/test-all', { method: 'POST' })
}
export function auditChannels(ids?: string[]) {
  return request<{ results: Array<Record<string, unknown>> }>('/api/admin/channels/audit', { method: 'POST', body: JSON.stringify({ ids: ids ?? [] }) })
}
export function bulkDisableChannels(ids: string[]) {
  return request<{ disabled: string[], channels: AdminChannel[] }>('/api/admin/channels/bulk-disable', { method: 'POST', body: JSON.stringify({ ids }) })
}
export function clearChannelFault(id: string) {
  return request(`/api/admin/channels/${encodeURIComponent(id)}/clear-fault`, { method: 'POST' })
}

// ===== 自定义服务商 =====
// 非 OpenAI 格式的第三方接口靠这组模板接入，前端和后端共用同一份定义。
export function updateCustomProviders(customProviders: unknown[]) {
  return request<{ customProviders: unknown[] }>('/api/admin/custom-providers', {
    method: 'PUT',
    body: JSON.stringify({ customProviders }),
  })
}

// ===== 用户 =====
export function createUser(body: Record<string, unknown>) {
  return request<{ user: AdminUser, password: string, generated: boolean }>('/api/admin/users', { method: 'POST', body: JSON.stringify(body) })
}
export function updateUser(id: string, body: Record<string, unknown>) {
  return request<{ user: AdminUser }>(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) })
}
export function deleteUser(id: string) {
  return request(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ===== 站点 =====
export function updateSite(body: Record<string, unknown>) {
  return request<{ site: Record<string, unknown> }>('/api/admin/site', { method: 'PUT', body: JSON.stringify(body) })
}

// ===== 积分 =====
export function updateCredits(body: Record<string, unknown>) {
  return request('/api/admin/credits', { method: 'PUT', body: JSON.stringify(body) })
}
export function resetCreditStats() {
  return request('/api/admin/credits/stats', { method: 'DELETE' })
}
export function setUserBalance(userId: string, balance: number, note = '管理员调整') {
  return request<{ ok: boolean, balance: number, changed: boolean }>(`/api/admin/credits/users/${encodeURIComponent(userId)}`, { method: 'PUT', body: JSON.stringify({ balance, note }) })
}

// ===== 卡密 =====
export type CardStatus = 'unused' | 'used' | 'void'

export interface AdminCardRow {
  code: string
  credits: number
  batch: string
  note: string
  status: CardStatus
  createdAt: number
  usedAt: number
  usedBy: string
  /** 兑换者昵称，服务端已按名册映射好；未兑换为空串 */
  usedByName?: string
}

export interface CardBatch {
  id: string
  credits: number
  count: number
  note: string
  createdAt: number
  total: number
  used: number
  unused: number
  voided: number
}

export interface CardsOverview {
  total: number
  unused: number
  used: number
  void: number
  redeemedCredits: number
  unusedCredits: number
  batches: number
}

export interface CardTable {
  total: number
  limit: number
  offset: number
  cards: AdminCardRow[]
  batches: CardBatch[]
  overview: CardsOverview
}

export function getCardTable(params: { status?: string, batch?: string, keyword?: string, limit?: number, offset?: number }) {
  const query = new URLSearchParams()
  if (params.status) query.set('status', params.status)
  if (params.batch) query.set('batch', params.batch)
  if (params.keyword) query.set('keyword', params.keyword)
  query.set('limit', String(params.limit ?? 50))
  query.set('offset', String(params.offset ?? 0))
  return request<CardTable>(`/api/admin/cards?${query.toString()}`)
}

export function generateCards(body: { credits: number, count: number, note?: string }) {
  return request<{ batchId: string, credits: number, count: number, codes: string[], overview: CardsOverview }>('/api/admin/cards', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** 作废：只能作废未使用的。传 batch 则整批作废。 */
export function voidCards(codes: string[]) {
  return request<{ changed: number, overview: CardsOverview }>('/api/admin/cards/void', { method: 'POST', body: JSON.stringify({ codes }) })
}
export function voidCardBatch(batch: string) {
  return request<{ changed: number, overview: CardsOverview }>('/api/admin/cards/void', { method: 'POST', body: JSON.stringify({ batch }) })
}
/** 恢复：把已作废的卡重新放回未使用。 */
export function restoreCards(codes: string[]) {
  return request<{ changed: number, overview: CardsOverview }>('/api/admin/cards/restore', { method: 'POST', body: JSON.stringify({ codes }) })
}
/** 删除：已兑换的卡是财务凭证，服务端会跳过并在结果里回报 skipped 数。 */
export function deleteCards(codes: string[]) {
  return request<{ removed: number, skipped: number, overview: CardsOverview }>('/api/admin/cards/delete', { method: 'POST', body: JSON.stringify({ codes }) })
}
export function deleteCardBatch(batch: string) {
  return request<{ removed: number, overview: CardsOverview }>('/api/admin/cards/delete', { method: 'POST', body: JSON.stringify({ batch }) })
}

// ===== 微信 / SMTP =====
export function updateWechat(body: Record<string, unknown>) {
  return request('/api/admin/wechat', { method: 'PUT', body: JSON.stringify(body) })
}
export function updateSmtp(body: Record<string, unknown>) {
  return request('/api/admin/smtp', { method: 'PUT', body: JSON.stringify(body) })
}
export function testSmtp(body: Record<string, unknown>) {
  return request<Record<string, unknown>>('/api/admin/smtp/test', { method: 'POST', body: JSON.stringify(body) })
}
export function sendSmtpTest(body: Record<string, unknown>) {
  return request<Record<string, unknown>>('/api/admin/smtp/send-test', { method: 'POST', body: JSON.stringify(body) })
}

// ===== 访客口令 / 邀请码 =====
export function generatePasscode() {
  return request<{ password: string }>('/api/admin/passcode', { method: 'POST' })
}
export function setGuestPassword(password: string) {
  return request('/api/admin/password', { method: 'PUT', body: JSON.stringify({ target: 'guest', password }) })
}
export function generateInvite() {
  return request<Record<string, unknown>>('/api/admin/invite', { method: 'POST' })
}
export function deleteInvite() {
  return request('/api/admin/invite', { method: 'DELETE' })
}
