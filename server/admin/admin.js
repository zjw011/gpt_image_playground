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
  { id: 'channels', label: '渠道链路' },
  { id: 'agent', label: 'Agent 模式' },
  { id: 'users', label: '用户' },
  { id: 'access', label: '访问与安全' },
  { id: 'providers', label: '自定义服务商' },
]

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
let view = 'channels'
let expandedChannelId = null
let expandedUserId = null
let creatingUser = false
// 刚生成的明文口令：服务端只在创建/重置那一次回传，此后只剩哈希，所以必须留在页面上等管理员抄走。
let freshCredential = null
let toastTimer = 0

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
  render()
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
  return `
    <div class="node ${live ? 'live' : 'idle'}" data-id="${esc(channel.id)}">
      <span class="node-index">${idx + 1}</span>
      <div class="card">
        <div class="card-head">
          <span class="title">${esc(channel.name)}</span>
          ${live
            ? '<span class="tag live"><span class="dot"></span>在链路中</span>'
            : `<span class="tag ${channel.hasApiKey ? 'idle' : 'alert'}">${channel.enabled ? '缺少 API Key' : '已停用'}</span>`}
          <span class="tag">${esc(channel.provider)}</span>
          <span class="tag mono">${esc(channel.model)}</span>
          <span class="spacer"></span>
          <button class="ghost" data-act="toggle-channel" data-id="${esc(channel.id)}">${open ? '收起' : '编辑'}</button>
        </div>
        <p class="card-meta">${esc(channel.baseUrl || '（未填地址）')}${channel.description ? ` · ${esc(channel.description)}` : ''}</p>
        ${open ? `<div class="card-body">${channelForm(channel, idx)}</div>` : ''}
      </div>
    </div>
  `
}

function renderChannelsView() {
  const live = state.channels.filter((item) => item.enabled && item.hasApiKey).length
  return `
    <div class="page-head">
      <h1>渠道链路</h1>
      <p>生图请求从第 1 条开始，失败就自动往下一条走，直到成功或链路走完。用 ↑ ↓ 调整顺序，把最快最稳的放在前面。当前 ${live} / ${state.channels.length} 条在链路中。</p>
    </div>
    ${state.channels.length
      ? `<div class="chain">${state.channels.map(channelNode).join('')}</div>`
      : '<div class="empty">还没有渠道。新增一条并填入真实 API Key 后，前端才能出图。</div>'}
    <div class="btn-row"><button class="primary" id="add-channel" type="button">新增渠道</button></div>
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
    : view === 'agent' ? renderAgentView()
    : view === 'access' ? renderAccessView()
    : view === 'providers' ? renderProvidersView()
    : renderChannelsView()

  app.className = ''
  app.innerHTML = `
    <div class="shell">
      <nav class="rail">
        ${brand(ACCESS_MODES.find((item) => item.id === state.site.accessMode)?.title ?? state.site.accessMode)}
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
      </nav>
      <main class="content">
        ${state.site.accessMode === 'open' && view !== 'users' && view !== 'access' ? `
          <div class="alert">
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
  for (const button of app.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => {
      view = button.dataset.view
      expandedChannelId = null
      expandedUserId = null
      creatingUser = false
      freshCredential = null
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

    const move = async (delta) => {
      const order = state.channels.map((item) => item.id)
      const from = order.indexOf(id)
      const to = from + delta
      if (to < 0 || to >= order.length) return
      order.splice(to, 0, order.splice(from, 1)[0])
      try {
        await api('/api/admin/channels/reorder', { method: 'POST', body: { order } })
        await refresh()
      } catch (err) {
        showToast(err.message, 'bad')
      }
    }
    form.querySelector('[data-act=move-up]').addEventListener('click', () => move(-1))
    form.querySelector('[data-act=move-down]').addEventListener('click', () => move(1))
  }
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
