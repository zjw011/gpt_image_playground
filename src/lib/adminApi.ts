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

export function getAdminState() {
  return request<AdminState>('/api/admin/state')
}

export function getAdminDashboard() {
  return request<AdminDashboard>('/api/admin/dashboard')
}

export function getAdminOverview(range = 'today') {
  return request<Record<string, unknown>>(`/api/admin/overview?range=${encodeURIComponent(range)}`)
}

export function getAdminUsage() {
  return request<Record<string, unknown>>('/api/admin/usage')
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
export function getAdminCredits() {
  return request<Record<string, unknown>>('/api/admin/credits')
}
export function resetCreditStats() {
  return request('/api/admin/credits/stats', { method: 'DELETE' })
}
export function setUserBalance(userId: string, balance: number, note = '管理员调整') {
  return request<{ ok: boolean, balance: number, changed: boolean }>(`/api/admin/credits/users/${encodeURIComponent(userId)}`, { method: 'PUT', body: JSON.stringify({ balance, note }) })
}

// ===== 卡密 =====
export function listCards(query = '') {
  return request<Record<string, unknown>>(`/api/admin/cards${query ? `?${query}` : ''}`)
}
export function generateCards(body: Record<string, unknown>) {
  return request<Record<string, unknown>>('/api/admin/cards', { method: 'POST', body: JSON.stringify(body) })
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
