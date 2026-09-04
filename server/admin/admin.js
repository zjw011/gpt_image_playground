// 后台管理页：无构建步骤的原生 ES module。
// 状态全部来自 /api/admin/state，写操作后重新拉取，避免本地与服务端不一致。

const app = document.getElementById('app')
const modalEl = document.getElementById('modal')
const toastEl = document.getElementById('toast')

const BUILT_IN_PROVIDERS = [
  { id: 'openai', label: 'OpenAI 兼容（Images / Responses）' },
  { id: 'sb2api-async', label: 'sb2api 异步' },
  { id: 'fal', label: 'fal.ai' },
]

const NAV = [
  { id: 'overview', label: '概览' },
  { id: 'channels', label: '渠道链路' },
  { id: 'usage', label: '用量与健康' },
  { id: 'agent', label: 'Agent 模式' },
  { id: 'users', label: '用户' },
  { id: 'access', label: '访问与安全' },
  { id: 'providers', label: '自定义服务商' },
]

/** 概览的时间范围选项。 */
const RANGES = [
  { id: 'today', label: '今日' },
  { id: 'week', label: '近 7 天' },
  { id: 'all', label: '近 14 天' },
]

/** 渠道健康度的展示映射。文案直接说"该怎么办"，不是只报一个状态词。 */
const HEALTH_LABELS = {
  healthy: { tone: 'live', text: '正常' },
  flaky: { tone: 'warn', text: '不稳' },
  down: { tone: 'alert', text: '疑似故障' },
  unknown: { tone: 'idle', text: '未使用' },
}

const AGENT_MODES = [
  {
    id: 'off',
    title: '不开放',
    detail: '前端只有画廊，顶栏不显示 Agent 切换按钮。',
  },
  {
    id: 'native',
    title: '原生',
    detail: '由模型自己调用 image_generation 工具出图。要求这条渠道的模型真的支持该工具，例如 gpt-5 系列。',
  },
  {
    id: 'hybrid',
    title: '混合',
    detail: '文本模型只负责对话和调用自定义工具，图片交给另一条图像渠道生成。模型不支持 image_generation 时用这个。',
  },
]

const ACCESS_MODES = [
  {
    id: 'open',
    title: '开放访问',
    detail: '拿到网址的人都能直接用。所有人共享同一份本地历史记录，适合只给自己或完全信任的小圈子。',
  },
  {
    id: 'passcode',
    title: '共享口令',
    detail: '所有人用同一个口令进入，也共享同一份历史记录。适合临时分享给一小群人。',
  },
  {
    id: 'accounts',
    title: '多用户账号',
    detail: '每人一套用户名和口令，各自的生图记录、收藏与设置完全隔离，互相看不到对方的作品。',
  },
]

let state = null
let usage = null
let overview = null
// 概览的时间范围。今日是默认——首屏要回答的第一个问题是"今天怎么样"。
let overviewRange = 'today'
let view = 'overview'
let expandedChannelId = null
let expandedUserId = null
let creatingUser = false
// 刚生成的明文口令：服务端只在创建/重置那一次回传，此后只剩哈希，所以必须留在页面上等管理员抄走。
let freshCredential = null
// 一键测全部的结果，按渠道 id 存；null 表示还没测过。
let probeAll = null
let probeAllRunning = false
let toastTimer = 0

/** 相对时间。后台看的是"多久之前"，绝对时间戳还得自己算差值。 */
function ago(at) {
  if (!at) return '从未'
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

function pct(value) {
  return `${Math.round(value * 100)}%`
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
}

function showToast(message, tone = '') {
  toastEl.textContent = message
  toastEl.className = `toast ${tone}`
  toastEl.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastEl.hidden = true }, 3200)
}

/**
 * 自绘确认弹窗，替代原生 confirm()。
 * 原生框在深色后台里是一块刺眼的系统白框，而且删渠道/删用户这种不可逆操作
 * 需要把后果写清楚，一行系统提示塞不下。resolve(true) 表示用户确认。
 */
function confirmDialog({ title, message, confirmText = '确认', tone = 'danger' }) {
  return new Promise((resolve) => {
    modalEl.innerHTML = `
      <div class="modal">
        <div class="modal-box" data-tone="${esc(tone)}" role="alertdialog" aria-modal="true" aria-label="${esc(title)}">
          <h2>${esc(title)}</h2>
          <p>${esc(message)}</p>
          <div class="btn-row">
            <span class="spacer"></span>
            <button type="button" data-act="cancel">取消</button>
            <button class="confirm" type="button" data-act="confirm">${esc(confirmText)}</button>
          </div>
        </div>
      </div>
    `

    const close = (result) => {
      document.removeEventListener('keydown', onKey)
      modalEl.innerHTML = ''
      resolve(result)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') close(false)
      if (event.key === 'Enter') close(true)
    }

    document.addEventListener('keydown', onKey)
    modalEl.querySelector('[data-act=cancel]').addEventListener('click', () => close(false))
    modalEl.querySelector('[data-act=confirm]').addEventListener('click', () => close(true))
    // 点遮罩当作取消；点弹窗本体不能穿透。
    modalEl.querySelector('.modal').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) close(false)
    })
    modalEl.querySelector('[data-act=confirm]').focus()
  })
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
  return payload
}

async function refresh() {
  state = await api('/api/admin/state')
  // 概览是首屏，但要先拿到 state 才知道有没有登录——未登录时请求 /overview 只会换来一个 401。
  if (state.authenticated && view === 'overview') await fetchOverview()
  render()
}

async function loadUsage() {
  try {
    usage = await api('/api/admin/usage')
  } catch (err) {
    usage = null
    showToast(err.message, 'bad')
  }
  render()
}

async function fetchOverview() {
  try {
    overview = await api(`/api/admin/overview?range=${overviewRange}`)
  } catch (err) {
    overview = null
    showToast(err.message, 'bad')
  }
}

async function loadOverview() {
  await fetchOverview()
  render()
}

/** 渠道顺序落库。拖拽和 ↑↓ 都走这里。 */
async function reorderChannels(order) {
  try {
    await api('/api/admin/channels/reorder', { method: 'POST', body: { order } })
    await refresh()
  } catch (err) {
    showToast(err.message, 'bad')
    // 落库失败时重新拉一次，把乐观移动过的 DOM 摆回真实顺序。
    await refresh()
  }
}

function readForm(form) {
  const data = new FormData(form)
  const value = {}
  for (const [key, raw] of data.entries()) value[key] = raw
  for (const input of form.querySelectorAll('input[type=checkbox]')) value[input.name] = input.checked
  for (const input of form.querySelectorAll('input[type=number]')) value[input.name] = Number(value[input.name])
  return value
}

function brand(subtitle) {
  return `
    <div class="rail-brand">
      <span class="rail-mark">绘</span>
      <div>
        <strong>绘想 · 后台</strong>
        <span>${esc(subtitle)}</span>
      </div>
    </div>
  `
}

// ===== 登录 / 初始化 =====

function renderLogin() {
  const first = !state.initialized
  app.className = ''
  app.innerHTML = `
    <div class="login-shell">
      <div class="panel login-panel">
        ${brand(first ? '首次启动' : '需要管理员口令')}
        <p class="hint">${first
          ? '设置管理员口令（至少 8 个字符），设置后立即以管理员身份登录。'
          : '连续失败 10 次会临时锁定该 IP。'}</p>
        <form id="login-form" style="margin-top:20px">
          <label>
            <span>管理员口令</span>
            <input type="password" name="password" autocomplete="current-password" required minlength="${first ? 8 : 1}" autofocus />
          </label>
          <div class="btn-row">
            <button class="primary" type="submit" style="width:100%">${first ? '设置并登录' : '登录'}</button>
          </div>
        </form>
      </div>
    </div>
  `

  app.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const password = new FormData(event.target).get('password')
    try {
      await api('/api/admin/login', { method: 'POST', body: { password } })
      await refresh()
      showToast('已登录', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })
}

// ===== 渠道 =====

function providerOptions(selected) {
  const custom = (state.customProviders ?? []).map((item) => ({ id: item.id, label: `${item.name}（自定义）` }))
  return [...BUILT_IN_PROVIDERS, ...custom]
    .map((item) => `<option value="${esc(item.id)}"${item.id === selected ? ' selected' : ''}>${esc(item.label)}</option>`)
    .join('')
}

function channelForm(channel, idx) {
  const isFal = channel.provider === 'fal'
  return `
    <form class="channel-form" data-id="${esc(channel.id)}">
      <fieldset class="group">
        <legend>接入</legend>
        <div class="row">
          <label><span>渠道名称</span><input name="name" value="${esc(channel.name)}" required /></label>
          <label><span>服务商类型</span><select name="provider">${providerOptions(channel.provider)}</select></label>
        </div>
        <div class="row">
          <label><span>API 地址</span>
            <input name="baseUrl" value="${esc(channel.baseUrl)}" placeholder="https://api.openai.com/v1" />
          </label>
          <label><span>模型 ID</span><input name="model" value="${esc(channel.model)}" required /></label>
        </div>
        <p class="hint" style="margin:-4px 0 14px">${isFal
          ? '留空即用 https://fal.run；填写则视为 fal 兼容网关。'
          : '结尾带 / 表示直接拼接端点，否则自动补 /v1。'}</p>
        <label><span>API Key</span>
          <input name="apiKey" type="password" autocomplete="off" placeholder="${channel.hasApiKey ? `当前 ${esc(channel.apiKeyMask)}，留空表示不修改` : 'sk-...'}" />
        </label>
        <div class="row">
          <label><span>API 模式</span>
            <select name="apiMode">
              <option value="images"${channel.apiMode === 'images' ? ' selected' : ''}>Images API</option>
              <option value="responses"${channel.apiMode === 'responses' ? ' selected' : ''}>Responses API</option>
            </select></label>
          <label><span>超时（秒）</span><input name="timeout" type="number" min="10" max="3600" value="${channel.timeout}" /></label>
        </div>
        <label style="margin-bottom:0"><span>备注（会显示给前端用户）</span><input name="description" value="${esc(channel.description)}" /></label>
      </fieldset>

      <fieldset class="group">
        <legend>行为</legend>
        <label class="check"><input type="checkbox" name="enabled"${channel.enabled ? ' checked' : ''} /><span>启用此渠道</span></label>
        <label class="check"><input type="checkbox" name="codexCli"${channel.codexCli ? ' checked' : ''} /><span>Codex CLI 兼容模式 <em>禁用质量参数，多图改并发</em></span></label>
        <label class="check"><input type="checkbox" name="responseFormatB64Json"${channel.responseFormatB64Json ? ' checked' : ''} /><span>强制请求 b64_json 返回格式</span></label>
        <label class="check" style="margin-bottom:16px"><input type="checkbox" name="streamImages"${channel.streamImages ? ' checked' : ''} /><span>启用流式生成 <em>仅 OpenAI + Responses 有效；故障转移期间自动关闭</em></span></label>
        <div class="row">
          <label style="margin-bottom:0"><span>流式中间图数量</span><input name="streamPartialImages" type="number" min="0" max="3" value="${channel.streamPartialImages}" /></label>
          <label style="margin-bottom:0"><span>透明背景实现</span>
            <select name="transparentBackgroundMethod">
              <option value="api"${channel.transparentBackgroundMethod === 'api' ? ' selected' : ''}>接口原生 background=transparent</option>
              <option value="local"${channel.transparentBackgroundMethod === 'local' ? ' selected' : ''}>本地色键抠除</option>
            </select></label>
        </div>
      </fieldset>

      <div class="btn-row">
        <button class="primary" type="submit">保存</button>
        <button type="button" data-act="test">连通测试</button>
        <button class="icon" type="button" data-act="move-up" title="上移"${idx === 0 ? ' disabled' : ''}>↑</button>
        <button class="icon" type="button" data-act="move-down" title="下移"${idx === state.channels.length - 1 ? ' disabled' : ''}>↓</button>
        <span class="spacer"></span>
        <button class="danger" type="button" data-act="delete">删除渠道</button>
      </div>
      <p class="probe" data-role="probe"></p>
    </form>
  `
}

function channelNode(channel, idx) {
  const open = expandedChannelId === channel.id
  const live = channel.enabled && channel.hasApiKey
  const health = HEALTH_LABELS[channel.health?.state ?? 'unknown']
  const probe = probeAll?.[channel.id]
  return `
    <div class="node ${live ? 'live' : 'idle'}" data-id="${esc(channel.id)}" draggable="true">
      <span class="node-index" title="拖动可调整故障转移顺序">${idx + 1}</span>
      <div class="card">
        <div class="card-head">
          <span class="title">${esc(channel.name)}</span>
          ${live
            ? '<span class="tag live"><span class="dot"></span>在链路中</span>'
            : `<span class="tag ${channel.hasApiKey ? 'idle' : 'alert'}">${channel.enabled ? '缺少 API Key' : '已停用'}</span>`}
          ${live && channel.health?.state !== 'unknown'
            ? `<span class="tag ${health.tone}" title="${esc(healthTitle(channel.health))}">${health.text}</span>`
            : ''}
          <span class="tag">${esc(channel.provider)}</span>
          <span class="tag mono">${esc(channel.model)}</span>
          <span class="spacer"></span>
          ${probe ? `<span class="tag ${probe.ok ? 'live' : 'alert'}" title="${esc(probe.message)}">${probe.ok ? `✓ ${probe.latencyMs ?? 0}ms` : '✗ 探测失败'}</span>` : ''}
          <button class="ghost" data-act="toggle-channel" data-id="${esc(channel.id)}">${open ? '收起' : '编辑'}</button>
        </div>
        <p class="card-meta">${esc(channel.baseUrl || '（未填地址）')}${channel.description ? ` · ${esc(channel.description)}` : ''}</p>
        ${live && channel.health?.state === 'down'
          ? `<p class="card-note bad">连续 ${channel.health.consecutiveFailures} 次请求被渠道自身拒绝或打不通，故障转移正在绕过它。${channel.health.lastError ? `最近错误：${esc(channel.health.lastError)}` : ''}
              <button class="link" type="button" data-act="clear-fault" data-id="${esc(channel.id)}">我测过没问题，消除标记</button></p>`
          : live && channel.health?.state === 'flaky'
            ? `<p class="card-note warn">最近 ${channel.health.recentCalls} 次调用里 ${pct(channel.health.recentFailRate)} 因渠道自身出错，能用但会拖慢出图。
                <button class="link" type="button" data-act="clear-fault" data-id="${esc(channel.id)}">消除标记</button></p>`
            : ''}
        ${open ? `<div class="card-body">${channelForm(channel, idx)}</div>` : ''}
      </div>
    </div>
  `
}

function healthTitle(health) {
  if (health.state === 'down') return `连续失败 ${health.consecutiveFailures} 次`
  if (health.state === 'flaky') return `最近 ${health.recentCalls} 次里失败 ${pct(health.recentFailRate)}`
  if (health.stale) return '之前失败过，但已经很久没再出错，按恢复处理'
  return '最近一次调用成功'
}

function renderChannelsView() {
  const live = state.channels.filter((item) => item.enabled && item.hasApiKey).length
  const broken = state.channels.filter((item) => item.enabled && item.hasApiKey && item.health?.state === 'down')
  return `
    <div class="page-head">
      <h1>渠道链路</h1>
      <p>生图请求从第 1 条开始，失败就自动往下一条走，直到成功或链路走完。拖动卡片或用 ↑ ↓ 调整顺序，把最快最稳的放在前面。当前 ${live} / ${state.channels.length} 条在链路中。</p>
    </div>
    ${broken.length
      ? `<div class="alert">
          <div class="alert-body">
            <strong>${broken.length} 条渠道疑似故障</strong>
            <p>${broken.map((item) => esc(item.name)).join('、')} 连续失败多次，出图请求正在绕过它们。点「一键测全部」——探测通过的会自动消除标记；也可以在卡片上单独消除。</p>
          </div>
          <button type="button" data-view="usage">查看详情</button>
        </div>`
      : ''}
    ${state.channels.length
      ? `<div class="chain" id="chain">${state.channels.map(channelNode).join('')}</div>`
      : '<div class="empty">还没有渠道。新增一条并填入真实 API Key 后，前端才能出图。</div>'}
    <div class="btn-row">
      <button class="primary" id="add-channel" type="button">新增渠道</button>
      ${state.channels.length
        ? `<button id="test-all" type="button"${probeAllRunning ? ' disabled' : ''}>${probeAllRunning ? '正在探测…' : '一键测全部'}</button>`
        : ''}
      ${probeAll ? '<button class="ghost" id="clear-probe" type="button">清除探测结果</button>' : ''}
    </div>
  `
}

// ===== 用户 =====

function minPasswordLength() {
  return state.minUserPasswordLength ?? 6
}

/** 刚生成的凭据块：明文只有这一次机会抄走。 */
function credentialPanel() {
  if (!freshCredential) return ''
  return `
    <div class="credential">
      <strong>${esc(freshCredential.title)}</strong>
      <p>口令只显示这一次，离开这个页面就再也看不到了。忘了就回来重新生成一个。</p>
      <dl class="credential-grid">
        ${freshCredential.username ? `<dt>用户名</dt><dd>${esc(freshCredential.username)}</dd>` : ''}
        <dt>口令</dt><dd>${esc(freshCredential.password)}</dd>
        <dt>网址</dt><dd style="font-size:13px;font-weight:400">${esc(window.location.origin)}</dd>
      </dl>
      <div class="btn-row" style="margin-top:14px">
        <button class="primary" type="button" data-act="copy-credential">复制登录信息</button>
        <button class="ghost" type="button" data-act="dismiss-credential">我记下了</button>
      </div>
    </div>
  `
}

function userForm(user) {
  const creating = !user
  const min = minPasswordLength()
  return `
    <form class="user-form" data-id="${esc(user?.id ?? '')}">
      <div class="row">
        <label><span>用户名（登录用）</span>
          <input name="username" value="${esc(user?.username ?? '')}" placeholder="alice" required />
        </label>
        <label><span>显示名称（可选）</span>
          <input name="displayName" value="${esc(user?.displayName ?? '')}" placeholder="张三" />
        </label>
      </div>
      <p class="hint" style="margin:-4px 0 14px">用户名支持 2-32 位字母、数字、下划线、点和连字符，首字符必须是字母或数字。改用户名不影响对方已有的作品。</p>
      <label><span>登录口令</span>
        <div class="with-action">
          <input name="password" type="text" autocomplete="off" minlength="${min}"
            placeholder="${creating ? `留空自动生成，或自己填（至少 ${min} 位）` : `留空表示不修改（至少 ${min} 位）`}" />
          <button type="button" data-act="regenerate">随机生成</button>
        </div>
      </label>
      <label><span>备注（只有你能看到）</span><input name="note" value="${esc(user?.note ?? '')}" placeholder="给谁用的" /></label>
      <label class="check"><input type="checkbox" name="enabled"${user?.enabled !== false ? ' checked' : ''} /><span>允许登录 <em>取消后该用户所有设备立即被踢下线，数据保留</em></span></label>
      <div class="btn-row">
        <button class="primary" type="submit">${creating ? '创建用户' : '保存'}</button>
        <button class="ghost" type="button" data-act="cancel-user">取消</button>
        ${creating ? '' : '<span class="spacer"></span><button class="danger" type="button" data-act="delete-user">删除用户</button>'}
      </div>
    </form>
  `
}

function personRow(user) {
  const open = expandedUserId === user.id
  const label = user.displayName || user.username
  const seen = user.lastSeenAt
    ? `最近登录 ${new Date(user.lastSeenAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
    : '还没登录过'
  return `
    <div class="person" data-id="${esc(user.id)}" data-open="${open}" data-enabled="${user.enabled}">
      <div class="person-main">
        <span class="avatar">${esc(label.slice(0, 1))}</span>
        <span class="person-id">
          <strong>${esc(label)}</strong>
          <span>${esc(user.username)} · ${esc(seen)}${user.note ? ` · ${esc(user.note)}` : ''}</span>
        </span>
        <span class="person-side">
          ${user.createdVia === 'invite' ? '<span class="tag">自助注册</span>' : ''}
          ${user.enabled
            ? '<span class="tag live"><span class="dot"></span>可登录</span>'
            : '<span class="tag idle">已停用</span>'}
          ${user.hasPassword ? '' : '<span class="tag alert">未设口令</span>'}
          <button class="ghost" data-act="toggle-user" data-id="${esc(user.id)}">${open ? '收起' : '编辑'}</button>
        </span>
      </div>
      ${open ? `<div class="person-body">${userForm(user)}</div>` : ''}
    </div>
  `
}

/** 自助注册面板。只在多用户模式下有意义，所以非该模式时整块折叠成一句说明。 */
function invitePanel() {
  const site = state.site
  const accounts = site.accessMode === 'accounts'
  const expired = site.inviteExpiresAt && Date.now() > site.inviteExpiresAt
  const exhausted = site.inviteMaxUses && site.inviteUsedCount >= site.inviteMaxUses
  const expiryValue = site.inviteExpiresAt
    // datetime-local 要本地时间且不带时区后缀，所以减掉偏移再截断到分钟。
    ? new Date(site.inviteExpiresAt - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    : ''

  return `
    <div class="panel">
      <h2>自助注册</h2>
      <p class="hint">${accounts
        ? '开启后，别人可以凭邀请码自己注册账号，你不用逐个建号发口令。名额和有效期都能限制，随时能作废重发。'
        : '只在「多用户账号」模式下可用——别的模式下前端没有账号这个概念。'}</p>
      ${accounts ? `
        <form id="invite-form" style="margin-top:16px">
          <label><span>邀请码</span>
            <div class="with-action">
              <input name="inviteCode" value="${esc(site.inviteCode)}" readonly placeholder="还没有邀请码" style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:0.06em" />
              <button type="button" data-act="new-invite">${site.inviteCode ? '换一个' : '生成'}</button>
              ${site.inviteCode ? '<button type="button" data-act="copy-invite">复制邀请链接</button>' : ''}
            </div>
          </label>
          <p class="hint" style="margin:-4px 0 16px">${site.inviteCode
            ? '换新码会立即作废旧码，已用次数一起归零。已经注册的账号不受影响。'
            : '生成后把邀请链接发给对方，他自己设用户名和口令。'}</p>
          <div class="row">
            <label><span>名额上限（0 = 不限）</span>
              <input name="inviteMaxUses" type="number" min="0" max="10000" value="${site.inviteMaxUses}" />
            </label>
            <label><span>有效期（留空 = 不过期）</span>
              <input name="inviteExpiresAtLocal" type="datetime-local" value="${esc(expiryValue)}" />
            </label>
          </div>
          <p class="hint" style="margin:-4px 0 16px">
            已注册 ${site.inviteUsedCount} 人${site.inviteMaxUses ? ` / 上限 ${site.inviteMaxUses}` : ''}。
            ${expired ? '<span class="warn">邀请码已过期，现在没人能注册。</span>' : ''}
            ${!expired && exhausted ? '<span class="warn">名额已用完，现在没人能注册。</span>' : ''}
          </p>
          <label class="check"><input type="checkbox" name="registrationEnabled"${site.registrationEnabled ? ' checked' : ''}${site.inviteCode ? '' : ' disabled'} /><span>开放自助注册 <em>${site.inviteCode ? '关掉后邀请链接立即失效，已注册的账号照常能登录' : '需要先生成邀请码'}</em></span></label>
          <div class="btn-row">
            <button class="primary" type="submit">保存</button>
            ${site.inviteCode ? '<span class="spacer"></span><button class="danger" type="button" data-act="revoke-invite">作废邀请码</button>' : ''}
          </div>
        </form>
      ` : ''}
    </div>
  `
}

function renderUsersView() {
  const users = state.users ?? []
  const accounts = state.site.accessMode === 'accounts'
  const usable = users.filter((user) => user.enabled && user.hasPassword).length
  return `
    <div class="page-head">
      <h1>用户</h1>
      <p>每个用户拥有独立的生图记录、收藏和界面设置，互相看不到对方的作品。隔离发生在各自的浏览器本地存储里——同一个人换设备登录不会带走历史记录。</p>
    </div>
    ${accounts
      ? ''
      : `<div class="alert">
          <div class="alert-body">
            <strong>这些账号现在还不生效</strong>
            <p>当前访问方式是「${esc(ACCESS_MODES.find((item) => item.id === state.site.accessMode)?.title ?? state.site.accessMode)}」。${usable ? '切到多用户模式后，别人打开前端就必须先登录。' : '先创建一个账号，再切到多用户模式。'}</p>
          </div>
          ${usable ? '<button class="primary" type="button" id="switch-accounts">切到多用户模式</button>' : ''}
        </div>`}
    ${credentialPanel()}
    ${users.length
      ? `<div class="people">${users.map(personRow).join('')}</div>`
      : '<div class="empty">还没有用户。创建第一个账号后就能切换到多用户模式。</div>'}
    ${creatingUser
      ? `<div class="panel"><h2>新建用户</h2><p class="hint">口令留空会自动生成一个好念好抄的短口令。</p><div style="margin-top:14px">${userForm(null)}</div></div>`
      : '<div class="btn-row"><button class="primary" id="add-user" type="button">新建用户</button></div>'}
    <hr class="divider" />
    ${invitePanel()}
  `
}

// ===== 概览 =====

/**
 * 环比。上一段没有数据时返回空串——"从 0 涨到 5"说成 +∞% 没有意义。
 *
 * graded 控制配色：成功率跌了是坏事，用红色；出图量跌了只是没人用，不该染成告警色。
 */
function delta(current, previous, graded = false) {
  if (!previous) return current ? '<span class="trend flat">新增</span>' : ''
  const ratio = (current - previous) / previous
  if (Math.abs(ratio) < 0.005) return '<span class="trend flat">持平</span>'
  const up = ratio > 0
  const tone = graded ? (up ? 'up' : 'down') : 'flat'
  return `<span class="trend ${tone}">${up ? '↑' : '↓'} ${Math.abs(Math.round(ratio * 100))}%</span>`
}

const RANGE_HINTS = {
  today: '今天',
  week: '近 7 天',
  all: '近 14 天',
}

function renderOverviewView() {
  if (!overview) return '<div class="page-head"><h1>概览</h1></div><div class="empty">正在加载…</div>'

  const label = RANGE_HINTS[overview.range]
  const okRate = overview.totals.total ? overview.totals.ok / overview.totals.total : 0
  const prevOkRate = overview.previous.total ? overview.previous.ok / overview.previous.total : 0
  // 只有多用户模式服务端才知道"是谁"，其他模式下按用户表没有意义。
  const knowsUsers = overview.accessMode === 'accounts'

  return `
    <div class="page-head">
      <h1>概览</h1>
      <p>计的是出图请求次数，不是图片张数——一次要 4 张的请求在这里算 1 次。提示词和图片一个字都不记。</p>
    </div>

    <div class="range-row">
      <div class="range">
        ${RANGES.map((item) => `
          <button class="range-item" type="button" data-range="${item.id}" aria-current="${overview.range === item.id}">${esc(item.label)}</button>
        `).join('')}
      </div>
      <button class="ghost" id="reload-overview" type="button">刷新</button>
    </div>

    ${overview.brokenChannels.length
      ? `<div class="alert">
          <div class="alert-body">
            <strong>${overview.brokenChannels.length} 条渠道疑似故障</strong>
            <p>${overview.brokenChannels.map((item) => esc(item.name)).join('、')} 正在被出图请求绕过。确认没问题的话去渠道页消除标记。</p>
          </div>
          <button type="button" data-view="channels">去处理</button>
        </div>`
      : ''}

    <div class="panel">
      <h2>${esc(label)}</h2>
      <div class="stats">
        <div class="stat">
          <strong>${overview.totals.total}</strong>
          <span>出图请求 ${delta(overview.totals.total, overview.previous.total)}</span>
        </div>
        <div class="stat">
          <strong class="${okRate >= 0.9 ? 'ok' : okRate >= 0.7 ? 'warn' : 'bad'}">${overview.totals.total ? pct(okRate) : '—'}</strong>
          <span>成功率 ${overview.totals.total && overview.previous.total ? delta(Math.round(okRate * 1000), Math.round(prevOkRate * 1000), true) : ''}</span>
        </div>
        <div class="stat">
          <strong>${knowsUsers ? overview.activeUsers : '—'}</strong>
          <span>${knowsUsers ? '活跃用户' : '活跃用户（当前模式不记身份）'}</span>
        </div>
        <div class="stat">
          <strong class="${overview.brokenChannels.length ? 'bad' : ''}">${overview.brokenChannels.length}</strong>
          <span>疑似故障渠道</span>
        </div>
      </div>
      <div style="margin-top:18px">${usageBars(overview.days)}</div>
      <p class="hint" style="margin-top:12px">柱状图固定看近 14 天，方便判断上面这几个数字是高还是低。</p>
    </div>

    <div class="panel">
      <h2>${esc(label)}谁在用</h2>
      ${!knowsUsers
        ? `<div class="empty">当前是「${esc(ACCESS_MODES.find((item) => item.id === overview.accessMode)?.title ?? overview.accessMode)}」模式，服务端不知道每个请求来自谁，所以没法按人统计。切到「多用户账号」模式后这张表才有数据。</div>`
        : overview.users.length
          ? `<table class="grid">
              <thead><tr><th>用户</th><th class="num">出图请求</th><th class="num">占比</th><th class="num">成功率</th><th>最近一次</th></tr></thead>
              <tbody>
                ${overview.users.map((item) => `
                  <tr>
                    <td>${esc(item.name)}${item.exists ? '' : ' <span class="tag idle">已删除</span>'}</td>
                    <td class="num">${item.total}</td>
                    <td class="num muted">${overview.totals.total ? pct(item.total / overview.totals.total) : '—'}</td>
                    <td class="num ${item.total && item.ok / item.total < 0.7 ? 'bad' : ''}">${item.total ? pct(item.ok / item.total) : '—'}</td>
                    <td class="muted">${esc(ago(item.lastAt))}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>`
          : `<div class="empty">${esc(label)}还没有人出图。</div>`}
    </div>

    <div class="panel">
      <h2>${esc(label)}走了哪些渠道</h2>
      ${overview.channels.length
        ? `<table class="grid">
            <thead><tr><th>渠道</th><th>状态</th><th class="num">出图请求</th><th class="num">占比</th><th class="num">成功率</th><th class="num">平均耗时</th></tr></thead>
            <tbody>
              ${overview.channels.map((item) => {
                const health = HEALTH_LABELS[item.state]
                return `
                  <tr>
                    <td>${esc(item.name)}${item.exists ? '' : ' <span class="tag idle">已删除</span>'}</td>
                    <td><span class="tag ${health.tone}">${health.text}</span></td>
                    <td class="num">${item.total}</td>
                    <td class="num muted">${overview.totals.total ? pct(item.total / overview.totals.total) : '—'}</td>
                    <td class="num ${item.total && item.ok / item.total < 0.7 ? 'bad' : ''}">${item.total ? pct(item.ok / item.total) : '—'}</td>
                    <td class="num">${item.avgLatencyMs ? `${(item.avgLatencyMs / 1000).toFixed(1)}s` : '—'}</td>
                  </tr>
                `
              }).join('')}
            </tbody>
          </table>`
        : `<div class="empty">${esc(label)}还没有出图记录。共有 ${overview.channelCount} 条渠道待用。</div>`}
    </div>
  `
}

// ===== 用量与健康 =====

/** 迷你柱状图：14 天的调用量，失败部分叠在柱子上方。用 div 而不是 canvas，省一个渲染路径。 */
function usageBars(days) {
  if (!days.length) return '<div class="empty">还没有出图记录。</div>'
  const peak = Math.max(...days.map((item) => item.total), 1)
  return `
    <div class="bars">
      ${days.map((item) => `
        <div class="bar" title="${esc(item.day)}：${item.total} 次，失败 ${item.fail} 次">
          <div class="bar-stack" style="height:${Math.round((item.total / peak) * 100)}%">
            ${item.fail ? `<div class="bar-fail" style="height:${Math.round((item.fail / item.total) * 100)}%"></div>` : ''}
          </div>
          <span>${esc(item.day.slice(5))}</span>
        </div>
      `).join('')}
    </div>
  `
}

function renderUsageView() {
  if (!usage) return '<div class="page-head"><h1>用量与健康</h1></div><div class="empty">正在加载统计…</div>'

  const okRate = usage.totals.total ? usage.totals.ok / usage.totals.total : 0
  return `
    <div class="page-head">
      <h1>用量与健康</h1>
      <p>只统计渠道、成败、耗时和时间。提示词和图片一个字都不记——图片始终只存在访问者自己的浏览器里，服务端拿不到，也就无从统计。</p>
    </div>

    <div class="panel">
      <h2>近 14 天</h2>
      <div class="stats">
        <div class="stat"><strong>${usage.totals.total}</strong><span>出图请求</span></div>
        <div class="stat"><strong class="${okRate >= 0.9 ? 'ok' : okRate >= 0.7 ? 'warn' : 'bad'}">${usage.totals.total ? pct(okRate) : '—'}</strong><span>成功率</span></div>
        <div class="stat"><strong>${usage.totals.fail}</strong><span>失败次数</span></div>
        <div class="stat"><strong>${usage.channels.length}</strong><span>被用过的渠道</span></div>
      </div>
      <div style="margin-top:18px">${usageBars(usage.days)}</div>
    </div>

    <div class="panel">
      <h2>按渠道</h2>
      ${usage.channels.length ? `
        <table class="grid">
          <thead><tr><th>渠道</th><th>状态</th><th class="num">调用</th><th class="num">成功率</th><th class="num">平均耗时</th><th>最近失败</th></tr></thead>
          <tbody>
            ${usage.channels.map((item) => {
              const health = HEALTH_LABELS[item.state]
              return `
                <tr>
                  <td>${esc(item.name)}${item.exists ? '' : ' <span class="tag idle">已删除</span>'}</td>
                  <td><span class="tag ${health.tone}">${health.text}</span></td>
                  <td class="num">${item.total}</td>
                  <td class="num ${item.total && item.ok / item.total < 0.7 ? 'bad' : ''}">${item.total ? pct(item.ok / item.total) : '—'}</td>
                  <td class="num">${item.avgLatencyMs ? `${(item.avgLatencyMs / 1000).toFixed(1)}s` : '—'}</td>
                  <td class="muted">${item.lastFailAt ? `${esc(ago(item.lastFailAt))}${item.lastError ? ` · ${esc(item.lastError.slice(0, 60))}` : ''}` : '无'}</td>
                </tr>
              `
            }).join('')}
          </tbody>
        </table>
      ` : '<div class="empty">还没有渠道被调用过。</div>'}
    </div>

    ${usage.users.length ? `
      <div class="panel">
        <h2>按用户</h2>
        <p class="hint">只在多用户模式下才有数据。这里能看到谁在用、用了多少，但看不到他生成了什么。</p>
        <table class="grid" style="margin-top:14px">
          <thead><tr><th>用户</th><th class="num">调用</th><th class="num">成功率</th><th>最近一次</th></tr></thead>
          <tbody>
            ${usage.users.map((item) => `
              <tr>
                <td>${esc(item.name)}${item.exists ? '' : ' <span class="tag idle">已删除</span>'}</td>
                <td class="num">${item.total}</td>
                <td class="num">${item.total ? pct(item.ok / item.total) : '—'}</td>
                <td class="muted">${esc(ago(item.lastAt))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : ''}

    <div class="panel">
      <h2>最近记录</h2>
      <p class="hint">标「不计入」的失败不会影响健康度：请求内容被拒、参数不合法、限流这些换渠道也一样失败，不是渠道的问题。</p>
      ${usage.events.length ? `
        <table class="grid" style="margin-top:14px">
          <thead><tr><th>时间</th><th>渠道</th><th>结果</th><th class="num">耗时</th><th>说明</th></tr></thead>
          <tbody>
            ${usage.events.map((item) => `
              <tr>
                <td class="muted">${esc(ago(item.at))}</td>
                <td>${esc(item.channelName)}${item.userName ? ` <span class="muted">· ${esc(item.userName)}</span>` : ''}</td>
                <td>
                  <span class="tag ${item.ok ? 'live' : item.fault ? 'alert' : 'warn'}">${item.ok ? '成功' : item.status ? `HTTP ${item.status}` : '失败'}</span>
                  ${!item.ok && !item.fault ? '<span class="tag idle">不计入</span>' : ''}
                </td>
                <td class="num">${item.latencyMs ? `${(item.latencyMs / 1000).toFixed(1)}s` : '—'}</td>
                <td class="muted">${esc(item.error.slice(0, 80))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : '<div class="empty">还没有记录。</div>'}
      <div class="btn-row">
        <button type="button" id="reload-usage">刷新</button>
        <span class="spacer"></span>
        <button class="danger" type="button" id="reset-usage">清空统计</button>
      </div>
    </div>
  `
}

// ===== Agent 模式 =====

function agentModeCard(mode, textChannels) {
  const selected = state.site.agentMode === mode.id
  // 没有 Responses 渠道时 native / hybrid 都点不了，直接在卡片上说清缺什么。
  const blocked = mode.id !== 'off' && textChannels.length === 0
  return `
    <label class="mode" data-selected="${selected}">
      <input type="radio" name="agentMode" value="${mode.id}"${selected ? ' checked' : ''}${blocked ? ' disabled' : ''} />
      <span>
        <strong>${esc(mode.title)}</strong>
        <small>${esc(mode.detail)}</small>
        ${blocked ? '<small class="warn">需要先在「渠道链路」加一条启用中的 OpenAI 兼容 + Responses API 渠道。</small>' : ''}
      </span>
    </label>
  `
}

function channelOptions(channels, selected) {
  return channels
    .map((item) => `<option value="${esc(item.id)}"${item.id === selected ? ' selected' : ''}>${esc(item.name)} · ${esc(item.model)}</option>`)
    .join('')
}

function renderAgentView() {
  const enabledChannels = state.channels.filter((item) => item.enabled && item.hasApiKey)
  const textChannels = enabledChannels.filter((item) => item.provider === 'openai' && item.apiMode === 'responses')
  const mode = state.site.agentMode
  return `
    <div class="page-head">
      <h1>Agent 模式</h1>
      <p>Agent 是前端的第二个标签页：用户可以像聊天一样让模型连续改图。在这里配好之后前端直接就能用，用户不需要自己填任何配置；关掉的话前端连 Agent 按钮都不会出现。</p>
    </div>

    ${textChannels.length === 0
      ? `<div class="alert">
          <div class="alert-body">
            <strong>还没有能跑 Agent 的渠道</strong>
            <p>Agent 需要一条「OpenAI 兼容」且 API 模式为「Responses API」的启用渠道——只有 Responses 才有对话和工具调用能力，Images API 只能出图。</p>
          </div>
          <button class="primary" type="button" data-view="channels">去加渠道</button>
        </div>`
      : ''}

    <div class="panel">
      <h2>接入方式</h2>
      <form id="agent-form" style="margin-top:14px">
        <div class="modes">${AGENT_MODES.map((item) => agentModeCard(item, textChannels)).join('')}</div>
        ${mode === 'off' ? '' : `
          <hr class="divider" />
          <div class="row">
            <label><span>对话用的文本渠道</span>
              <select name="agentTextChannelId">${channelOptions(textChannels, state.site.agentTextChannelId)}</select>
            </label>
            ${mode === 'hybrid' ? `
              <label><span>出图用的图像渠道</span>
                <select name="agentImageChannelId">${channelOptions(enabledChannels, state.site.agentImageChannelId)}</select>
              </label>
            ` : ''}
          </div>
          <p class="hint" style="margin:-4px 0 18px">这两条渠道不走故障转移：Agent 的对话是有状态的，中途换渠道会让上下文对不上。</p>
          <div class="row">
            <label><span>单轮最多工具调用次数</span>
              <input name="agentMaxToolRounds" type="number" min="1" max="100" value="${state.site.agentMaxToolRounds}" />
            </label>
          </div>
          <label class="check"><input type="checkbox" name="agentWebSearch"${state.site.agentWebSearch ? ' checked' : ''} /><span>允许联网搜索 <em>用 Responses 的 web_search 工具，每次调用有少量额外计费</em></span></label>
        `}
        <div class="btn-row"><button class="primary" type="submit">保存</button></div>
      </form>
    </div>
  `
}

// ===== 访问与安全 =====

function accessModeCard(mode) {
  const selected = state.site.accessMode === mode.id
  const blocked = (mode.id === 'passcode' && !state.guestPasswordSet)
    || (mode.id === 'accounts' && !(state.users ?? []).some((user) => user.enabled && user.hasPassword))
  return `
    <label class="mode" data-selected="${selected}">
      <input type="radio" name="accessMode" value="${mode.id}"${selected ? ' checked' : ''} />
      <span>
        <strong>${esc(mode.title)}</strong>
        <small>${esc(mode.detail)}</small>
        ${blocked ? `<small class="warn">${mode.id === 'passcode' ? '需要先在下方设置访客口令。' : '需要先在「用户」页创建至少一个启用的账号。'}</small>` : ''}
      </span>
    </label>
  `
}

function renderAccessView() {
  const min = minPasswordLength()
  return `
    <div class="page-head">
      <h1>访问与安全</h1>
      <p>决定谁能打开前端，以及大家的数据是共享还是隔离。</p>
    </div>

    ${state.site.accessMode === 'open'
      ? `<div class="alert">
          <div class="alert-body">
            <strong>当前是开放访问：前端不要求登录</strong>
            <p>任何拿到网址的人都能用你的渠道出图。在下面挑一种带口令的方式并保存即可关上这道门。</p>
          </div>
        </div>`
      : ''}
    ${credentialPanel()}

    <div class="panel">
      <h2>访问方式</h2>
      <form id="site-form" style="margin-top:14px">
        <div class="modes">${ACCESS_MODES.map(accessModeCard).join('')}</div>
        <hr class="divider" />
        <div class="row">
          <label><span>站点标题</span><input name="title" value="${esc(state.site.title)}" /></label>
          <label><span>最多尝试渠道数（0 = 全部尝试）</span><input name="failoverMaxAttempts" type="number" min="0" max="50" value="${state.site.failoverMaxAttempts}" /></label>
        </div>
        <p class="hint" style="margin:-4px 0 18px">站点标题会同时用在浏览器标签和前端顶部。</p>
        <label class="check"><input type="checkbox" name="failoverEnabled"${state.site.failoverEnabled ? ' checked' : ''} /><span>渠道失败时自动切换到下一条 <em>关掉后一次失败就直接报错</em></span></label>
        <label class="check"><input type="checkbox" name="allowGuestParamOverride"${state.site.allowGuestParamOverride ? ' checked' : ''} /><span>允许前端用户调整尺寸、质量等生成参数</span></label>
        <div class="btn-row"><button class="primary" type="submit">保存</button></div>
      </form>
    </div>

    <div class="panel">
      <h2>共享访客口令</h2>
      <p class="hint">只在「共享口令」模式下用到：所有人用同一个口令进来，共享同一份历史。多用户模式各自用自己的账号口令，与这里无关。</p>
      <form id="guest-password-form" style="margin-top:14px">
        <label><span>访客口令</span>
          <div class="with-action">
            <input name="password" type="text" autocomplete="off" minlength="${min}"
              placeholder="${state.guestPasswordSet ? `已设置，输入新值可覆盖（至少 ${min} 位）` : `未设置，至少 ${min} 位`}" />
            <button type="button" data-act="regenerate-guest">随机生成</button>
          </div>
        </label>
        <div class="btn-row">
          <button class="primary" type="submit">保存访客口令</button>
          ${state.guestPasswordSet && state.site.accessMode !== 'passcode'
            ? '<span class="spacer"></span><button class="danger" type="button" id="clear-guest-password">清除口令</button>'
            : ''}
        </div>
      </form>
    </div>

    <div class="panel">
      <h2>管理员口令</h2>
      <p class="hint">只用于登录这个后台，和前端访问口令是两码事。修改后其他设备上的后台登录立即失效，当前这台保持登录。</p>
      <form id="admin-password-form" style="margin-top:14px">
        <div class="row">
          <label><span>当前口令</span><input name="currentPassword" type="password" autocomplete="current-password" required /></label>
          <label><span>新口令（至少 8 个字符）</span><input name="password" type="password" autocomplete="new-password" required minlength="8" /></label>
        </div>
        <div class="btn-row"><button type="submit">修改管理员口令</button></div>
      </form>
    </div>
  `
}

// ===== 自定义服务商 =====

function renderProvidersView() {
  return `
    <div class="page-head">
      <h1>自定义服务商</h1>
      <p>粘贴 http-image 模板的 JSON 数组，用来对接非 OpenAI 格式的第三方接口。格式与前端「自定义服务商」一致，可以用仓库里的 docs/custom-provider-llm-prompt.md 让大模型帮你生成。</p>
    </div>
    <div class="panel">
      <form id="providers-form">
        <label style="margin-bottom:0"><span>http-image 模板 JSON</span>
          <textarea name="customProviders" spellcheck="false">${esc(JSON.stringify(state.customProviders ?? [], null, 2))}</textarea>
        </label>
        <div class="btn-row"><button class="primary" type="submit">保存</button></div>
      </form>
    </div>
  `
}

// ===== 骨架 =====

function render() {
  if (!state.authenticated) return renderLogin()

  const counts = {
    channels: state.channels.length,
    users: (state.users ?? []).length,
  }
  const body = view === 'users' ? renderUsersView()
    : view === 'usage' ? renderUsageView()
    : view === 'agent' ? renderAgentView()
    : view === 'access' ? renderAccessView()
    : view === 'providers' ? renderProvidersView()
    : view === 'channels' ? renderChannelsView()
    : renderOverviewView()

  app.className = ''
  app.innerHTML = `
    <div class="shell">
      <nav class="rail">
        ${brand(ACCESS_MODES.find((item) => item.id === state.site.accessMode)?.title ?? state.site.accessMode)}
        <button class="rail-toggle" id="rail-toggle" type="button" aria-expanded="false">菜单</button>
        <div class="rail-nav" data-open="false">
          ${NAV.map((item) => `
            <button class="nav-item" data-view="${item.id}" type="button" aria-current="${view === item.id}">
              ${esc(item.label)}
              ${counts[item.id] != null ? `<span class="count">${counts[item.id]}</span>` : ''}
            </button>
          `).join('')}
          <div class="rail-foot">
            <a href="/" target="_blank" rel="noreferrer"><button class="ghost" type="button" style="width:100%">打开前端 ↗</button></a>
            <button class="ghost" id="logout" type="button">退出登录</button>
          </div>
        </div>
      </nav>
      <main class="content">
        ${state.site.accessMode === 'open' && view !== 'users' && view !== 'access' ? `          <div class="alert">
            <div class="alert-body">
              <strong>前端目前不需要登录，任何人都能用你的渠道出图</strong>
              <p>拿到网址就能生图，账单记在你头上。改成「共享口令」让所有人用同一个口令，或「多用户账号」给每人一个账号、数据互相隔离。</p>
            </div>
            <button class="primary" type="button" data-view="access">去设置</button>
          </div>
        ` : ''}
        ${body}
      </main>
    </div>
  `

  bindEvents()
}

function bindEvents() {
  // 窄屏把导航折起来，点标题栏的「菜单」再展开——横排六项在手机上会挤成两行。
  const railNav = app.querySelector('.rail-nav')
  app.querySelector('#rail-toggle')?.addEventListener('click', (event) => {
    const open = railNav.dataset.open !== 'true'
    railNav.dataset.open = String(open)
    event.target.setAttribute('aria-expanded', String(open))
  })

  for (const button of app.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => {
      view = button.dataset.view
      expandedChannelId = null
      expandedUserId = null
      creatingUser = false
      freshCredential = null
      if (view === 'usage') return void loadUsage()
      if (view === 'overview') return void loadOverview()
      render()
    })
  }

  app.querySelector('#logout')?.addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' })
    expandedChannelId = null
    expandedUserId = null
    freshCredential = null
    await refresh()
  })

  // 凭据块在「用户」和「访问与安全」两个页面都会出现，所以放在共享的绑定里。
  app.querySelector('[data-act=copy-credential]')?.addEventListener('click', async (event) => {
    const lines = [
      `网址：${window.location.origin}`,
      ...(freshCredential.username ? [`用户名：${freshCredential.username}`] : []),
      `口令：${freshCredential.password}`,
    ]
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      showToast('登录信息已复制', 'good')
    } catch {
      // 非 HTTPS 下 clipboard API 不可用，退回让用户手动选中。
      event.target.closest('.credential').querySelector('.credential-grid').setAttribute('style', 'user-select:all')
      showToast('浏览器不允许自动复制，请手动选中上面的信息', 'bad')
    }
  })

  app.querySelector('[data-act=dismiss-credential]')?.addEventListener('click', () => {
    freshCredential = null
    render()
  })

  // 单选卡片的选中态：radio 的 :checked 影响不到祖先元素，只能手动同步 data-selected。
  // 访问方式与 Agent 接入方式共用这套卡片，所以放在共享绑定里。
  for (const input of app.querySelectorAll('.mode input[type=radio]')) {
    input.addEventListener('change', () => {
      for (const card of app.querySelectorAll('.mode')) {
        card.dataset.selected = String(card.querySelector('input').checked)
      }
    })
  }

  bindChannelEvents()
  bindAgentEvents()
  bindUserEvents()
  bindAccessEvents()
  bindUsageEvents()

  app.querySelector('#providers-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const text = new FormData(event.target).get('customProviders')
    let parsed
    try {
      parsed = JSON.parse(String(text || '[]'))
    } catch {
      return showToast('JSON 解析失败，请检查格式', 'bad')
    }
    if (!Array.isArray(parsed)) return showToast('内容必须是数组', 'bad')
    try {
      await api('/api/admin/custom-providers', { method: 'PUT', body: { customProviders: parsed } })
      await refresh()
      showToast('自定义服务商已保存', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })
}

function bindChannelEvents() {
  app.querySelector('#add-channel')?.addEventListener('click', async () => {
    try {
      const result = await api('/api/admin/channels', {
        method: 'POST',
        body: {
          name: `渠道 ${state.channels.length + 1}`,
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'PLACEHOLDER-REPLACE-ME',
          model: 'gpt-image-2',
          enabled: false,
        },
      })
      expandedChannelId = result.channel.id
      await refresh()
      showToast('已新增渠道，请填入真实 API Key 后启用', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })

  for (const button of app.querySelectorAll('[data-act=toggle-channel]')) {
    button.addEventListener('click', () => {
      expandedChannelId = expandedChannelId === button.dataset.id ? null : button.dataset.id
      render()
    })
  }

  for (const form of app.querySelectorAll('.channel-form')) {
    const id = form.dataset.id

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const body = readForm(form)
      if (!body.apiKey) delete body.apiKey
      try {
        await api(`/api/admin/channels/${encodeURIComponent(id)}`, { method: 'PUT', body })
        await refresh()
        showToast('已保存', 'good')
      } catch (err) {
        showToast(err.message, 'bad')
      }
    })

    form.querySelector('[data-act=test]').addEventListener('click', async (event) => {
      const target = form.querySelector('[data-role=probe]')
      event.target.disabled = true
      target.textContent = '正在探测…'
      target.className = 'probe'
      try {
        const result = await api('/api/admin/channels/test', { method: 'POST', body: { id } })
        target.textContent = `${result.ok ? '✓' : '✗'} ${result.message}${result.latencyMs != null ? `（${result.latencyMs}ms）` : ''}`
        target.className = `probe ${result.ok ? 'ok' : 'bad'}`
        // 探测通过时服务端会撤掉故障标记，但这里不能直接 refresh——会重渲染掉刚显示的探测结果。
        // 先把内存里的健康度改成正常，等下次渲染时自然一致。
        if (result.ok && result.health) {
          const channel = state.channels.find((item) => item.id === id)
          if (channel) channel.health = result.health
        }
      } catch (err) {
        target.textContent = `✗ ${err.message}`
        target.className = 'probe bad'
      } finally {
        event.target.disabled = false
      }
    })

    form.querySelector('[data-act=delete]').addEventListener('click', async () => {
      const channel = state.channels.find((item) => item.id === id)
      if (!await confirmDialog({
        title: `删除渠道「${channel?.name ?? id}」？`,
        message: '前端会立即失去这条渠道，正在排队的请求也会失败。密钥一并删除，无法找回，只能重新填一次。',
        confirmText: '删除渠道',
      })) return
      try {
        await api(`/api/admin/channels/${encodeURIComponent(id)}`, { method: 'DELETE' })
        expandedChannelId = null
        await refresh()
        showToast('已删除', 'good')
      } catch (err) {
        showToast(err.message, 'bad')
      }
    })

    const move = (delta) => {
      const order = state.channels.map((item) => item.id)
      const from = order.indexOf(id)
      const to = from + delta
      if (to < 0 || to >= order.length) return
      order.splice(to, 0, order.splice(from, 1)[0])
      void reorderChannels(order)
    }
    form.querySelector('[data-act=move-up]').addEventListener('click', () => move(-1))
    form.querySelector('[data-act=move-down]').addEventListener('click', () => move(1))
  }

  bindChannelDrag()

  app.querySelector('#test-all')?.addEventListener('click', async () => {
    probeAllRunning = true
    probeAll = null
    render()
    try {
      const result = await api('/api/admin/channels/test-all', { method: 'POST' })
      probeAll = Object.fromEntries(result.results.map((item) => [item.id, item]))
      const bad = result.results.filter((item) => !item.ok)
      showToast(bad.length ? `${bad.length} / ${result.results.length} 条渠道有问题` : `全部 ${result.results.length} 条渠道连通正常`, bad.length ? 'bad' : 'good')
      // 探测通过的渠道服务端已经撤掉故障标记，重新拉一次 state 让徽标同步。
      await refresh()
    } catch (err) {
      showToast(err.message, 'bad')
    } finally {
      probeAllRunning = false
      render()
    }
  })

  app.querySelector('#clear-probe')?.addEventListener('click', () => {
    probeAll = null
    render()
  })

  for (const button of app.querySelectorAll('[data-act=clear-fault]')) {
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        await api(`/api/admin/channels/${encodeURIComponent(button.dataset.id)}/clear-fault`, { method: 'POST' })
        await refresh()
        showToast('已消除故障标记。再出现渠道自身的失败会重新计数', 'good')
      } catch (err) {
        button.disabled = false
        showToast(err.message, 'bad')
      }
    })
  }
}

/**
 * 拖拽排序。用原生 HTML5 drag 而不是引第三方库——这里只需要"整块上下换位"，
 * 拖动时直接把节点插到目标前后，松手时把当前 DOM 顺序落库。
 */
function bindChannelDrag() {
  const chain = app.querySelector('#chain')
  if (!chain) return

  let dragging = null

  for (const node of chain.querySelectorAll('.node')) {
    node.addEventListener('dragstart', (event) => {
      // 在输入框里选文字时不该触发整卡拖动。
      if (event.target.closest('input, select, textarea, button')) return event.preventDefault()
      dragging = node
      node.dataset.dragging = 'true'
      event.dataTransfer.effectAllowed = 'move'
      // Firefox 不设 data 就不触发 drop。
      event.dataTransfer.setData('text/plain', node.dataset.id)
    })

    node.addEventListener('dragend', () => {
      if (!dragging) return
      delete dragging.dataset.dragging
      dragging = null
      const order = [...chain.querySelectorAll('.node')].map((item) => item.dataset.id)
      const current = state.channels.map((item) => item.id)
      if (order.join() !== current.join()) return void reorderChannels(order)
      render()
    })

    node.addEventListener('dragover', (event) => {
      if (!dragging || node === dragging) return
      event.preventDefault()
      const box = node.getBoundingClientRect()
      // 越过中线才换位，避免在边界上来回抖动。
      const after = event.clientY > box.top + box.height / 2
      chain.insertBefore(dragging, after ? node.nextSibling : node)
    })
  }

  chain.addEventListener('dragover', (event) => {
    if (dragging) event.preventDefault()
  })
}

function bindUsageEvents() {
  app.querySelector('#reload-usage')?.addEventListener('click', () => void loadUsage())
  app.querySelector('#reload-overview')?.addEventListener('click', () => void loadOverview())

  for (const button of app.querySelectorAll('[data-range]')) {
    button.addEventListener('click', () => {
      overviewRange = button.dataset.range
      void loadOverview()
    })
  }

  app.querySelector('#reset-usage')?.addEventListener('click', async () => {
    if (!await confirmDialog({
      title: '清空所有用量统计？',
      message: '所有渠道的调用次数、成功率和最近记录都会归零，渠道健康度也会退回「未使用」。渠道配置和用户账号不受影响。',
      confirmText: '清空统计',
    })) return
    try {
      await api('/api/admin/usage', { method: 'DELETE' })
      await loadUsage()
      showToast('统计已清空', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })
}

function bindUserEvents() {
  app.querySelector('#add-user')?.addEventListener('click', () => {
    creatingUser = true
    expandedUserId = null
    render()
  })

  app.querySelector('#switch-accounts')?.addEventListener('click', async () => {
    try {
      await api('/api/admin/site', { method: 'PUT', body: { accessMode: 'accounts' } })
      await refresh()
      showToast('已切到多用户模式，前端现在要求登录', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })

  for (const button of app.querySelectorAll('[data-act=toggle-user]')) {
    button.addEventListener('click', () => {
      expandedUserId = expandedUserId === button.dataset.id ? null : button.dataset.id
      creatingUser = false
      render()
    })
  }

  for (const form of app.querySelectorAll('.user-form')) {
    const id = form.dataset.id

    form.querySelector('[data-act=regenerate]').addEventListener('click', async (event) => {
      event.target.disabled = true
      try {
        const result = await api('/api/admin/passcode', { method: 'POST' })
        const input = form.querySelector('[name=password]')
        input.value = result.password
        input.focus()
        input.select()
      } catch (err) {
        showToast(err.message, 'bad')
      } finally {
        event.target.disabled = false
      }
    })

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const body = readForm(form)
      const password = body.password
      if (!password) delete body.password
      try {
        if (id) {
          const result = await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PUT', body })
          // 改了口令就把新凭据显示出来，方便直接转给对方。
          freshCredential = password
            ? { title: `「${result.user.username}」的口令已重置`, username: result.user.username, password }
            : null
          showToast('已保存', 'good')
        } else {
          const result = await api('/api/admin/users', { method: 'POST', body })
          creatingUser = false
          expandedUserId = null
          freshCredential = {
            title: `账号「${result.user.username}」已创建`,
            username: result.user.username,
            password: result.password,
          }
          showToast('已创建，把下面的登录信息发给对方', 'good')
        }
        await refresh()
      } catch (err) {
        showToast(err.message, 'bad')
      }
    })

    form.querySelector('[data-act=cancel-user]').addEventListener('click', () => {
      creatingUser = false
      expandedUserId = null
      render()
    })

    form.querySelector('[data-act=delete-user]')?.addEventListener('click', async () => {
      const user = (state.users ?? []).find((item) => item.id === id)
      if (!await confirmDialog({
        title: `删除账号「${user?.displayName || user?.username || id}」？`,
        message: '他所有设备会立即掉线，用户名可以被别人重新占用。他已经生成的图片留在他自己的浏览器里，你看不到也删不掉。',
        confirmText: '删除账号',
      })) return
      try {
        await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
        expandedUserId = null
        freshCredential = null
        await refresh()
        showToast('已删除', 'good')
      } catch (err) {
        showToast(err.message, 'bad')
      }
    })
  }

  bindInviteEvents()
}

function bindInviteEvents() {
  const form = app.querySelector('#invite-form')
  if (!form) return

  form.querySelector('[data-act=new-invite]')?.addEventListener('click', async (event) => {
    if (state.site.inviteCode && !await confirmDialog({
      title: '换一个新邀请码？',
      message: '旧邀请码立即失效，已经发出去但还没用的链接会打不开。已注册的账号不受影响。',
      confirmText: '换新码',
      tone: 'danger',
    })) return
    event.target.disabled = true
    try {
      await api('/api/admin/invite', { method: 'POST' })
      await refresh()
      showToast('邀请码已生成，记得开启自助注册', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
      event.target.disabled = false
    }
  })

  form.querySelector('[data-act=copy-invite]')?.addEventListener('click', async (event) => {
    const link = `${window.location.origin}/?invite=${encodeURIComponent(state.site.inviteCode)}`
    try {
      await navigator.clipboard.writeText(link)
      showToast('邀请链接已复制', 'good')
    } catch {
      // 非 HTTPS 下 clipboard API 不可用，退回让用户手动抄邀请码。
      const input = form.querySelector('[name=inviteCode]')
      input.focus()
      input.select()
      showToast('浏览器不允许自动复制，请手动抄下邀请码', 'bad')
      event.preventDefault()
    }
  })

  form.querySelector('[data-act=revoke-invite]')?.addEventListener('click', async () => {
    if (!await confirmDialog({
      title: '作废邀请码？',
      message: '自助注册会一起关掉，发出去的邀请链接全部失效。已注册的账号照常能登录。',
      confirmText: '作废',
    })) return
    try {
      await api('/api/admin/invite', { method: 'DELETE' })
      await refresh()
      showToast('邀请码已作废，自助注册已关闭', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const body = readForm(form)
    // datetime-local 给的是本地时间字符串，转成时间戳再存；留空表示不过期。
    body.inviteExpiresAt = body.inviteExpiresAtLocal ? new Date(body.inviteExpiresAtLocal).getTime() : 0
    delete body.inviteExpiresAtLocal
    // 邀请码本身是只读展示，不参与保存——换码走独立接口。
    delete body.inviteCode
    try {
      await api('/api/admin/site', { method: 'PUT', body })
      await refresh()
      showToast(state.site.registrationEnabled ? '自助注册已开启' : '已保存，自助注册当前关闭', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })
}

function bindAgentEvents() {
  const form = app.querySelector('#agent-form')
  if (!form) return

  // 换接入方式会改变下面要显示哪些字段（混合模式多一个图像渠道），先落库再重渲染。
  for (const input of form.querySelectorAll('input[name=agentMode]')) {
    input.addEventListener('change', async () => {
      try {
        await api('/api/admin/site', { method: 'PUT', body: { agentMode: input.value } })
        await refresh()
      } catch (err) {
        showToast(err.message, 'bad')
        await refresh()
      }
    })
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    try {
      await api('/api/admin/site', { method: 'PUT', body: readForm(event.target) })
      await refresh()
      showToast(state.site.agentMode === 'off' ? '已关闭 Agent 模式' : 'Agent 配置已保存，前端刷新后生效', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })
}

function bindAccessEvents() {
  app.querySelector('#site-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    try {
      await api('/api/admin/site', { method: 'PUT', body: readForm(event.target) })
      await refresh()
      showToast('已保存', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })

  app.querySelector('[data-act=regenerate-guest]')?.addEventListener('click', async (event) => {
    event.target.disabled = true
    try {
      const result = await api('/api/admin/passcode', { method: 'POST' })
      const input = app.querySelector('#guest-password-form [name=password]')
      input.value = result.password
      input.focus()
      input.select()
    } catch (err) {
      showToast(err.message, 'bad')
    } finally {
      event.target.disabled = false
    }
  })

  app.querySelector('#clear-guest-password')?.addEventListener('click', async () => {
    if (!await confirmDialog({
      title: '清除共享访客口令？',
      message: '清除后「共享口令」模式就不可用了，已经登录的访客也会掉线。你随时可以再设一个新的。',
      confirmText: '清除口令',
    })) return
    try {
      await api('/api/admin/password', { method: 'PUT', body: { target: 'guest', password: '' } })
      freshCredential = null
      await refresh()
      showToast('访客口令已清除', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })

  app.querySelector('#guest-password-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const password = String(new FormData(event.target).get('password') ?? '')
    if (!password) return showToast('请输入或随机生成一个口令', 'bad')
    if (password.length < minPasswordLength()) return showToast(`访客口令至少 ${minPasswordLength()} 个字符`, 'bad')
    try {
      await api('/api/admin/password', { method: 'PUT', body: { target: 'guest', password } })
      freshCredential = { title: '共享访客口令已更新', username: '', password }
      await refresh()
      showToast('访客口令已更新', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })

  app.querySelector('#admin-password-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(event.target)
    try {
      await api('/api/admin/password', {
        method: 'PUT',
        body: { target: 'admin', currentPassword: data.get('currentPassword'), password: data.get('password') },
      })
      event.target.reset()
      showToast('管理员口令已更新，其他设备的登录已失效', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })
}

refresh().catch((err) => {
  app.className = ''
  app.innerHTML = `<div class="login-shell"><div class="panel login-panel"><h1>加载失败</h1><p class="error" style="margin-top:8px">${esc(err.message)}</p></div></div>`
})
