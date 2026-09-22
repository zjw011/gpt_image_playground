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
  { id: 'credits', label: '积分与卡密' },
  { id: 'wechat', label: '微信登录' },
  { id: 'smtp', label: '邮件发信' },
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

/** 深度自检的判定展示。文案落在"这条渠道到底还能不能用"上。 */
const AUDIT_LABELS = {
  ok: { tone: 'live', text: '✓ 能出图', hint: '真出了一张图，余额和密钥都正常。' },
  'no-balance': { tone: 'alert', text: '✗ 没余额', hint: '上游明确回了额度/余额不足，充值前这条渠道每次都会失败。' },
  auth: { tone: 'alert', text: '✗ 密钥无效', hint: '密钥错了、过期了或被封了，跟余额无关，重填密钥才能用。' },
  model: { tone: 'warn', text: '✗ 模型不可用', hint: '密钥能用，但这个模型 ID 在该渠道下取不到，改模型或换分组。' },
  'rate-limit': { tone: 'warn', text: '限流', hint: '被上游限流了，说明密钥有效。过一会儿再测才能确认余额。' },
  unreachable: { tone: 'alert', text: '✗ 连不上', hint: '地址打不通或超时，先确认 baseUrl 和网络。' },
  error: { tone: 'alert', text: '✗ 出错', hint: '出图失败但不属于上面任何一类，看具体错误。' },
  skipped: { tone: 'idle', text: '未检测', hint: '这条渠道没法用自检判断，需要手动确认。' },
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
  {
    id: 'wechat',
    title: '微信扫码登录',
    detail: '扫码关注公众号即自动建号登录，不用发账号也不用记口令。每个微信号一份独立记录，适合对外公开运营。',
  },
]

/** 微信登录方式的展示映射。两种方式的差别是"需不需要用户回一条消息"。 */
const WECHAT_LOGIN_MODES = [
  {
    id: 'code',
    title: '验证码（推荐）',
    detail: '网页显示公众号二维码和一串 6 位数字，用户扫码关注后在公众号里回复这串数字即可登录。未认证订阅号也能用，不需要 IP 白名单。',
  },
  {
    id: 'qrcode',
    title: '带参数二维码',
    detail: '生成一张临时二维码，扫码即登录，用户不用回消息。但「生成带参数的二维码」接口只对微信认证的<b>服务号</b>开放，个人主体的订阅号即使做完认证也调不了（个人注册不了服务号）；调用失败会自动退回验证码方式。',
  },
]

/** 卡密状态的展示映射。 */
const CARD_STATUS_LABELS = {
  unused: { tone: 'accent', text: '未使用' },
  used: { tone: 'live', text: '已兑换' },
  void: { tone: 'idle', text: '已作废' },
}

/** 积分流水的类型映射。文案要说清"分从哪来、到哪去"。 */
const LEDGER_TYPE_LABELS = {
  signup: { tone: 'accent', text: '注册赠送' },
  redeem: { tone: 'live', text: '卡密兑换' },
  spend: { tone: 'idle', text: '生图扣费' },
  refund: { tone: 'warn', text: '失败退回' },
  admin: { tone: 'warn', text: '管理员调账' },
}

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
// 深度自检的结果，按渠道 id 存；null 表示还没自检过。
let auditResults = null
let auditRunning = false
// 正在自检的渠道名，用来在按钮上显示进度。
let auditProgress = ''
let toastTimer = 0

// 积分页的数据。/api/admin/credits 与 /api/admin/cards 分开拉，
// 因为卡密列表要按状态/批次过滤，重拉一次不该把整份流水也带上。
let creditsPanel = null
let cardsData = null
// 卡密列表的筛选条件，切页回来要保持住。
let cardFilter = { status: '', batch: '', keyword: '' }
// 刚生成的一批卡密：只在这一次响应里回传，之后要导出就得走导出接口。
let freshCards = null
// 微信连通性测试的结果；null 表示没测过。
let wechatProbe = null
let wechatTesting = false

/** 邮件发信面板的临时状态：探测结果与"正在发"标记，刷新页面即丢。 */
let smtpProbe = null
let smtpTesting = false
let smtpTestTo = ''

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

/** 千分位。积分动辄五位数，不加分隔符读起来要一位一位数。 */
function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '0'
}

/** 日期时间。后台表格里的时间要能直接抄下来对账，不能用"3 小时前"。 */
function stamp(at) {
  if (!at) return '—'
  return new Date(at).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
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

/**
 * 带一个输入框的确认弹窗。用于"调整余额"这类需要用户填一个值的操作。
 * 返回用户填的字符串，取消返回 null。
 */
function promptDialog({ title, message = '', label = '数值', value = '', type = 'text', confirmText = '确认', tone = 'primary' }) {
  return new Promise((resolve) => {
    modalEl.innerHTML = `
      <div class="modal">
        <div class="modal-box" data-tone="${esc(tone)}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <h2>${esc(title)}</h2>
          ${message ? `<p>${esc(message)}</p>` : ''}
          <label>
            <span>${esc(label)}</span>
            <input name="value" type="${esc(type)}" value="${esc(value)}" autocomplete="off" />
          </label>
          <div class="btn-row">
            <span class="spacer"></span>
            <button type="button" data-act="cancel">取消</button>
            <button class="primary confirm" type="button" data-act="confirm">${esc(confirmText)}</button>
          </div>
        </div>
      </div>
    `

    const input = modalEl.querySelector('input[name=value]')
    const close = (result) => {
      document.removeEventListener('keydown', onKey)
      modalEl.innerHTML = ''
      resolve(result)
    }
    const submit = () => close(input.value.trim())
    const onKey = (event) => {
      if (event.key === 'Escape') close(null)
      if (event.key === 'Enter') submit()
    }

    document.addEventListener('keydown', onKey)
    modalEl.querySelector('[data-act=cancel]').addEventListener('click', () => close(null))
    modalEl.querySelector('[data-act=confirm]').addEventListener('click', submit)
    modalEl.querySelector('.modal').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) close(null)
    })
    input.focus()
    input.select()
  })
}

/**
 * 复制到剪贴板，失败时降级成让用户手动选中。
 * 非 HTTPS 下 clipboard API 直接不存在，后台常常跑在内网 http 上，这条降级路径会真的走到。
 */
async function copyText(text, fallbackEl) {
  try {
    await navigator.clipboard.writeText(text)
    showToast('已复制', 'good')
  } catch {
    if (fallbackEl) {
      fallbackEl.setAttribute('style', `${fallbackEl.getAttribute('style') ?? ''};user-select:all`)
      showToast('浏览器不允许自动复制，请手动选中', 'bad')
      return
    }
    showToast('浏览器不允许自动复制，请手动选中', 'bad')
  }
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

/**
 * 积分页的数据。两个接口各管一块，失败时互不拖累：
 * 余额与流水挂了，卡密列表照常显示，管理员至少还能发卡。
 */
async function loadCreditsPanel() {
  const results = await Promise.allSettled([
    api('/api/admin/credits'),
    api(`/api/admin/cards?${new URLSearchParams({ ...cardFilter, limit: '100' })}`),
  ])

  if (results[0].status === 'fulfilled') creditsPanel = results[0].value
  else {
    creditsPanel = null
    showToast(results[0].reason.message, 'bad')
  }

  if (results[1].status === 'fulfilled') cardsData = results[1].value
  else {
    cardsData = null
    showToast(results[1].reason.message, 'bad')
  }

  render()
}

/** 只重拉卡密列表，用在切筛选条件时——不必连积分流水一起拉。 */
async function loadCards(options = {}) {
  try {
    cardsData = await api(`/api/admin/cards?${new URLSearchParams({ ...cardFilter, limit: '100' })}`)
  } catch (err) {
    showToast(err.message, 'bad')
  }
  render()
  // 重渲染会把整页 innerHTML 换掉，正在敲的搜索框会失焦。
  // 边打字边搜的体验全靠这一步补回来，否则每输一个字光标就飞走。
  if (options.keepKeywordFocus) {
    const input = app.querySelector('#card-keyword')
    if (input) {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    }
  }
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
  const audit = auditResults?.[channel.id]
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
          ${audit ? `<span class="tag ${(AUDIT_LABELS[audit.verdict] ?? AUDIT_LABELS.error).tone}" title="${esc(audit.message)}">${(AUDIT_LABELS[audit.verdict] ?? AUDIT_LABELS.error).text}</span>` : ''}
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

/** 深度自检结果面板。真出图才能区分"没余额"和"密钥错"，所以结果单独列出来，不挤在卡片徽标里。 */
function auditPanel() {
  if (!auditResults) return ''

  // enabled 取当前 state 而不是自检时的快照——停用之后这张表要立刻反映出来。
  const rows = state.channels
    .filter((channel) => auditResults[channel.id])
    .map((channel) => ({ ...auditResults[channel.id], enabled: channel.enabled }))
  if (!rows.length) return ''
  const noBalance = rows.filter((item) => item.verdict === 'no-balance')
  const ok = rows.filter((item) => item.verdict === 'ok')
  const actionable = noBalance.filter((item) => item.enabled)

  return `
    <div class="panel">
      <div class="card-head" style="margin-bottom:12px">
        <h2 style="margin:0">自检结果</h2>
        <span class="spacer"></span>
        ${auditRunning ? `<span class="tag warn">正在测 ${esc(auditProgress)}（${rows.length} / ${state.channels.length}）</span>` : '<button class="ghost" id="clear-audit" type="button">收起</button>'}
      </div>
      <p class="hint" style="margin-bottom:14px">${ok.length} 条能出图，${noBalance.length} 条没余额，已测 ${rows.length} 条。判定来自上游对一次真实出图请求的回复，比连通测试可靠。</p>
      ${actionable.length && !auditRunning
        ? `<div class="alert">
            <div class="alert-body">
              <strong>${actionable.length} 条渠道没余额</strong>
              <p>${actionable.map((item) => esc(item.name)).join('、')}。留在链路里只会让每次出图都先失败一轮再转移，拖慢所有人。建议停用——密钥保留，充值后重新启用即可。</p>
            </div>
            <button class="primary" id="disable-no-balance" type="button">停用这 ${actionable.length} 条</button>
          </div>`
        : noBalance.length && !auditRunning
          ? `<div class="alert">
              <div class="alert-body">
                <strong>${noBalance.length} 条没余额的渠道已经是停用状态</strong>
                <p>${noBalance.map((item) => esc(item.name)).join('、')}。它们已经不在出图链路里，不影响出图。充值后回到卡片里重新勾上「启用此渠道」。</p>
              </div>
            </div>`
          : ''}
      <table class="grid">
        <thead><tr><th>渠道</th><th>判定</th><th>说明</th><th class="num">耗时</th></tr></thead>
        <tbody>
          ${rows.map((item) => {
            const label = AUDIT_LABELS[item.verdict] ?? AUDIT_LABELS.error
            return `
              <tr>
                <td>${esc(item.name)}${item.enabled ? '' : ' <span class="tag idle">已停用</span>'}</td>
                <td><span class="tag ${label.tone}" title="${esc(label.hint)}">${label.text}</span></td>
                <td class="muted">${esc(item.message)}</td>
                <td class="num">${item.latencyMs ? `${(item.latencyMs / 1000).toFixed(1)}s` : '—'}</td>
              </tr>
            `
          }).join('')}
        </tbody>
      </table>
    </div>
  `
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
    ${auditPanel()}
    ${state.channels.length
      ? `<div class="chain" id="chain">${state.channels.map(channelNode).join('')}</div>`
      : '<div class="empty">还没有渠道。新增一条并填入真实 API Key 后，前端才能出图。</div>'}
    <div class="btn-row">
      <button class="primary" id="add-channel" type="button">新增渠道</button>
      ${state.channels.length
        ? `<button id="test-all" type="button"${probeAllRunning || auditRunning ? ' disabled' : ''}>${probeAllRunning ? '正在探测…' : '一键测全部'}</button>
           <button id="audit-all" type="button"${probeAllRunning || auditRunning ? ' disabled' : ''}>${auditRunning ? `正在自检 ${esc(auditProgress)}…` : '深度自检（会真出图）'}</button>`
        : ''}
      ${probeAll ? '<button class="ghost" id="clear-probe" type="button">清除探测结果</button>' : ''}
    </div>
    ${state.channels.length
      ? '<p class="hint" style="margin-top:10px">「一键测全部」只看端点通不通，欠费的渠道照样显示正常。要查出到底哪条没余额，用「深度自检」——它给每条渠道真发一次 1024×1024 低质量出图请求，会消耗一点额度。</p>'
      : ''}
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
  const creditsOn = state.site.credits?.enabled === true
  return `
    <div class="person" data-id="${esc(user.id)}" data-open="${open}" data-enabled="${user.enabled}">
      <div class="person-main">
        <span class="avatar">${user.wechatAvatar
          ? `<img src="${esc(user.wechatAvatar)}" alt="" referrerpolicy="no-referrer" />`
          : esc(label.slice(0, 1))}</span>
        <span class="person-id">
          <strong>${esc(label)}</strong>
          <span>${esc(user.username)}${user.email ? ` · ${esc(user.email)}` : ''} · ${esc(seen)}${user.note ? ` · ${esc(user.note)}` : ''}</span>
        </span>
        <span class="person-side">
          ${user.wechat ? '<span class="tag accent">微信</span>' : ''}
          ${user.createdVia === 'email' ? '<span class="tag accent">邮箱注册</span>' : ''}
          ${user.createdVia === 'invite' ? '<span class="tag">邀请码注册</span>' : ''}
          ${user.email && !user.emailVerified ? '<span class="tag alert">邮箱未验证</span>' : ''}
          ${creditsOn ? `<span class="tag ${user.balance > 0 ? 'live' : 'idle'}">${num(user.balance)} 积分</span>` : ''}
          ${user.enabled
            ? '<span class="tag live"><span class="dot"></span>可登录</span>'
            : '<span class="tag idle">已停用</span>'}
          ${user.hasPassword ? '' : '<span class="tag alert">未设口令</span>'}
          ${creditsOn ? `<button class="ghost" type="button" data-act="set-balance" data-id="${esc(user.id)}" data-name="${esc(label)}" data-balance="${Number(user.balance) || 0}" title="调整这个用户的积分余额">调分</button>` : ''}
          <button class="ghost" data-act="toggle-user" data-id="${esc(user.id)}">${open ? '收起' : '编辑'}</button>
        </span>
      </div>
      ${open ? `<div class="person-body">${userForm(user)}</div>` : ''}
    </div>
  `
}

/**
 * 自助注册面板。
 *
 * 注册的主关卡从「邀请码」换成了「邮箱验证码」，所以这块的重点也变了：
 * 不再是"先生成邀请码"，而是"先把发信配通"。邀请码降级成一个可选开关。
 */
function invitePanel() {
  const site = state.site
  const smtp = state.smtp ?? {}
  const accounts = site.accessMode === 'accounts'
  const expired = site.inviteExpiresAt && Date.now() > site.inviteExpiresAt
  const exhausted = site.inviteMaxUses && site.inviteUsedCount >= site.inviteMaxUses
  const needsInvite = site.requireInviteCode === true
  const mailReady = Boolean(smtp.enabled && smtp.host && smtp.user && smtp.hasPassword)
  // 开着注册但发不出信，是最容易让管理员困惑的状态：用户点注册只会看到报错。
  const broken = site.registrationEnabled && !mailReady
  const expiryValue = site.inviteExpiresAt
    // datetime-local 要本地时间且不带时区后缀，所以减掉偏移再截断到分钟。
    ? new Date(site.inviteExpiresAt - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    : ''

  return `
    <div class="panel">
      <h2>自助注册</h2>
      <p class="hint">${accounts
        ? '开启后，别人可以用邮箱验证码自己注册账号，你不用逐个建号发口令。邮箱验证码由「邮件发信」里配置的邮箱发出。'
        : '只在「多用户账号」模式下可用——别的模式下前端没有账号这个概念。'}</p>

      ${!accounts ? '' : broken ? `
        <div class="alert" data-tone="warn" style="margin-top:16px">
          <div class="alert-body">
            <strong>注册开着，但验证码发不出去</strong>
            <p>用户点「获取验证码」会直接看到报错。先去「邮件发信」把发信配通，或先把下面的开关关掉。</p>
          </div>
          <button class="primary" type="button" data-view="smtp">去配置邮件发信</button>
        </div>` : !mailReady ? `
        <div class="alert" style="margin-top:16px">
          <div class="alert-body">
            <strong>还没配置邮件发信</strong>
            <p>邮箱验证码需要先有一个能发信的邮箱。配好之后再回来打开注册开关。</p>
          </div>
          <button class="primary" type="button" data-view="smtp">去配置邮件发信</button>
        </div>` : ''}

      ${accounts ? `
        <form id="invite-form" style="margin-top:16px">
          <div class="row">
            <label><span>注册成功后赠送积分</span>
              <input value="${num(site.credits?.signupBonus ?? 0)} 分" readonly />
            </label>
            <label><span>每张图扣费</span>
              <input value="${num(site.credits?.costPerImage ?? 0)} 分" readonly />
            </label>
          </div>
          <p class="hint" style="margin:-4px 0 16px">
            这两项在「积分与卡密」里改。赠送积分只在建号时发一次，老用户重新登录不会重复领。
            ${site.credits?.enabled ? '' : '<span class="warn">注意：积分制当前是关闭的，赠送和扣费都不会生效。</span>'}
          </p>

          <label class="check"><input type="checkbox" name="registrationEnabled"${site.registrationEnabled ? ' checked' : ''} /><span>开放自助注册 <em>关掉后注册入口立即从登录页消失，已注册的账号照常能登录</em></span></label>

          <label class="check" style="margin-top:4px"><input type="checkbox" name="requireInviteCode"${needsInvite ? ' checked' : ''} /><span>额外要求邀请码 <em>默认不要求。打开后邮箱验证码和邀请码都要对，适合先小范围放量</em></span></label>

          <div id="invite-extra" style="display:${needsInvite ? 'block' : 'none'}">
            <label style="margin-top:12px"><span>邀请码</span>
              <div class="with-action">
                <input name="inviteCode" value="${esc(site.inviteCode)}" readonly placeholder="还没有邀请码" style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:0.06em" />
                <button type="button" data-act="new-invite">${site.inviteCode ? '换一个' : '生成'}</button>
                ${site.inviteCode ? '<button type="button" data-act="copy-invite">复制邀请链接</button>' : ''}
              </div>
            </label>
            <p class="hint" style="margin:-4px 0 16px">${site.inviteCode
              ? '换新码会立即作废旧码，已用次数一起归零。已经注册的账号不受影响。'
              : '生成后把邀请链接发给对方，他还要自己收邮箱验证码。'}</p>
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
          </div>

          <div class="btn-row">
            <button class="primary" type="submit">保存</button>
            ${needsInvite && site.inviteCode ? '<span class="spacer"></span><button class="danger" type="button" data-act="revoke-invite">作废邀请码</button>' : ''}
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
    // 微信登录要三样凭据齐全才算"配好了"。缺一样就点了保存也只会得到一个全员登不进来的站点。
    || (mode.id === 'wechat' && !state.wechat?.configured)
  const blockedHint = {
    passcode: '需要先在下方设置访客口令。',
    accounts: '需要先在「用户」页创建至少一个启用的账号。',
    wechat: '需要先在「微信登录」页填好 AppID、AppSecret 与 Token。',
  }[mode.id]
  return `
    <label class="mode" data-selected="${selected}">
      <input type="radio" name="accessMode" value="${mode.id}"${selected ? ' checked' : ''} />
      <span>
        <strong>${esc(mode.title)}</strong>
        <small>${esc(mode.detail)}</small>
        ${blocked && blockedHint ? `<small class="warn">${esc(blockedHint)}</small>` : ''}
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

// ===== 积分与卡密 =====

/** 套餐行。名称/价格/积分三列，纯展示用，但要让管理员能一眼改完一整批。 */
function packRow(pack = { name: '', price: '', credits: '' }) {
  return `
    <div class="pack-row" data-pack>
      <input name="packName" value="${esc(pack.name)}" placeholder="名称（如 月卡）" />
      <input name="packPrice" value="${esc(pack.price)}" placeholder="价格（如 ¥30）" />
      <input name="packCredits" type="number" min="0" step="1" value="${esc(pack.credits)}" placeholder="积分" />
      <button class="ghost" type="button" data-act="remove-pack" title="删除这一行">✕</button>
    </div>
  `
}

/** 渠道倍率行。100% 是原价，200% 表示这条渠道出的图算两倍积分。 */
function channelRateRow(channel, rates) {
  const value = Number(rates?.[channel.id] ?? 100)
  return `
    <label>
      <span>${esc(channel.name)}</span>
      <input name="rate:${esc(channel.id)}" type="number" min="1" max="1000" step="1" value="${Number.isFinite(value) ? value : 100}" />
    </label>
  `
}

/** 刚生成的一批卡密：只在生成那一次回传明文，之后要拿就得走导出接口。 */
function freshCardsPanel() {
  if (!freshCards) return ''
  const codes = freshCards.codes ?? []
  return `
    <div class="credential">
      <strong>已生成 ${codes.length} 张卡密，每张 ${num(freshCards.credits)} 积分</strong>
      <p>卡密只在这一次响应里返回明文，离开这个页面就查不到了（但随时可以导出，列表里也看得到）。批次：${esc(freshCards.batchId)}</p>
      <textarea class="short" id="fresh-codes" readonly spellcheck="false" style="margin-top:12px;min-height:140px">${esc(codes.join('\n'))}</textarea>
      <div class="btn-row" style="margin-top:14px">
        <button class="primary" type="button" data-act="copy-fresh">复制全部</button>
        <button type="button" data-act="export-batch" data-batch="${esc(freshCards.batchId)}">下载为 txt</button>
        <button class="ghost" type="button" data-act="dismiss-fresh">我记下了</button>
      </div>
    </div>
  `
}

/** 用户 id → 显示名。卡密表里记录的是 id，直接展示对管理员没意义。 */
function userNameOf(id) {
  if (!id) return '—'
  const user = (state.users ?? []).find((item) => item.id === id)
  return user ? (user.displayName || user.username) : '（已删除的用户）'
}

function renderCreditsView() {
  const site = state.site
  const settings = creditsPanel?.settings ?? site.credits ?? {}
  const enabled = settings.enabled === true
  const overview = creditsPanel?.overview ?? state.credits ?? {}
  const cardStats = cardsData?.overview ?? state.credits?.cards ?? {}
  const accounts = (creditsPanel?.users ?? []).filter((item) => item.exists)
  const wechatMode = site.accessMode === 'wechat'

  return `
    <div class="page-head">
      <h1>积分与卡密</h1>
      <p>积分制把"谁能出图"变成"谁还有分"。用户不能自助充值——他先从你这里买到卡密，再在网页上兑换成积分；每成功出一张图扣一次分，失败的尝试一分不扣。</p>
    </div>

    ${!enabled
      ? `<div class="alert" data-tone="warn">
          <div class="alert-body">
            <strong>积分制还没开启</strong>
            <p>现在所有人不花积分就能出图。在下面的「计费设置」里勾上「启用积分制」并保存，前端才会出现余额和充值入口。</p>
          </div>
        </div>`
      : ''}
    ${enabled && !wechatMode
      ? `<div class="alert" data-tone="warn">
          <div class="alert-body">
            <strong>当前访问方式扣不了分</strong>
            <p>积分要挂在一个"人"身上才有意义，而现在的前端没有账号。把「访问与安全」里的访问方式改成「微信扫码登录」或「多用户账号」，扣费才会生效。</p>
          </div>
          <button class="primary" type="button" data-view="access">去设置</button>
        </div>`
      : ''}

    <div class="panel">
      <h2>今日
        <span class="spacer" style="flex:1"></span>
        <button class="ghost" type="button" data-act="clear-credit-stats">清空统计</button>
      </h2>
      <p class="hint">所有数字都是积分，不是人民币。日期口径按服务器本地时区。「清空统计」只清聚合数字与流水，余额和卡密一分不动。</p>
      <div class="stats">
        <div class="stat"><strong class="bad">${num(overview.todaySpend ?? 0)}</strong><span>今日消耗</span></div>
        <div class="stat"><strong class="accent">${num(overview.todayRecharge ?? 0)}</strong><span>今日到账</span></div>
        <div class="stat"><strong>${num(overview.todayImages ?? 0)}</strong><span>今日出图（张）</span></div>
        <div class="stat"><strong>${num(overview.todayRedeemCount ?? 0)}</strong><span>今日兑换（张卡）</span></div>
        <div class="stat"><strong>${num(overview.balances ?? 0)}</strong><span>未消耗总额</span></div>
        <div class="stat"><strong>${num(overview.holders ?? 0)}</strong><span>有余额的用户</span></div>
      </div>
      <div class="stats">
        <div class="stat"><strong class="warn">${num(cardStats.unused ?? 0)}</strong><span>未使用的卡密</span></div>
        <div class="stat"><strong class="ok">${num(cardStats.used ?? 0)}</strong><span>已兑换的卡密</span></div>
        <div class="stat"><strong>${num(cardStats.void ?? 0)}</strong><span>已作废</span></div>
        <div class="stat"><strong>${num(cardStats.unusedCredits ?? 0)}</strong><span>未兑换的余额总额</span></div>
      </div>
    </div>

    <div class="panel">
      <h2>计费设置</h2>
      <p class="hint">「每张图消耗积分」是基准价，实际扣费还要乘上各条渠道的倍率——贵的渠道出的图扣得多，便宜的就少。</p>
      <form id="credits-form" style="margin-top:14px">
        <label class="check"><input type="checkbox" name="enabled"${enabled ? ' checked' : ''} /><span>启用积分制 <em>关掉后前端不显示余额，也不再扣费</em></span></label>
        <div class="row thirds">
          <label><span>每张图消耗积分</span><input name="costPerImage" type="number" min="0" max="100000" value="${Number(settings.costPerImage ?? 1)}" /></label>
          <label><span>新用户注册赠送</span><input name="signupBonus" type="number" min="0" max="1000000" value="${Number(settings.signupBonus ?? 0)}" /></label>
          <label><span>卡密购买链接</span><input name="purchaseUrl" value="${esc(settings.purchaseUrl ?? '')}" placeholder="https://你的发卡网/商品页" /></label>
        </div>
        <p class="hint" style="margin:-4px 0 18px">购买链接会出现在前端的充值弹窗里。用户点它去你指定的地方买卡密，换不换得到分只由卡密决定，与你卖多少钱无关。</p>

        <fieldset class="group">
          <legend>渠道倍率（百分比，100 = 原价）</legend>
          ${state.channels.length
            ? `<div class="row thirds">${state.channels.map((channel) => channelRateRow(channel, settings.channelRates)).join('')}</div>`
            : '<p class="hint">还没有渠道。倍率要在有渠道之后才有意义。</p>'}
        </fieldset>

        <fieldset class="group">
          <legend>充值套餐（只在前端展示，可不填）</legend>
          ${settings.packs?.length ? '' : '<p class="hint" style="margin-bottom:10px">套餐只是价目表，用来告诉用户"买多少分大概多少钱"。真正的兑换仍然靠卡密。</p>'}
          <div class="pack-rows" id="pack-rows">${(settings.packs ?? []).map(packRow).join('')}</div>
          <div class="btn-row" style="margin-top:10px">
            <button class="ghost" type="button" data-act="add-pack">+ 加一个套餐</button>
          </div>
        </fieldset>

        <div class="btn-row">
          <button class="primary" type="submit">保存</button>
        </div>
      </form>
    </div>

    <div class="panel">
      <h2>生成卡密</h2>
      <p class="hint">生成后把卡密发到你的发卡网（或直接发给客户）。一码一用，兑换时立即绑定到那个账号上。</p>
      <form id="card-gen-form" style="margin-top:14px">
        <div class="row thirds">
          <label><span>每张面额（积分）</span><input name="credits" type="number" min="1" max="1000000" step="1" value="100" required /></label>
          <label><span>生成数量</span><input name="count" type="number" min="1" max="2000" step="1" value="10" required /></label>
          <label><span>备注（只有你能看到）</span><input name="note" placeholder="如：某宝渠道 3 月批次" /></label>
        </div>
        <div class="btn-row"><button class="primary" type="submit">生成</button></div>
      </form>
    </div>

    ${freshCardsPanel()}

    ${batchesPanel()}
    ${cardsPanel()}
    ${redeemPanel()}
    ${balancePanel(accounts)}
  `
}

/** 批次表。同一批卡一起作废/一起导出，比在几百行里挑码要实际得多。 */
function batchesPanel() {
  const batches = cardsData?.batches ?? []
  if (!batches.length) return ''
  return `
    <div class="panel">
      <h2>批次</h2>
      <p class="hint">按生成批次管理。导出时只用选批次就能拿到整批码。</p>
      <div class="table-wrap scroll-x">
        <table class="grid">
          <thead><tr><th>批次号</th><th class="num">面额</th><th class="num">总数</th><th class="num">未使用</th><th class="num">已兑换</th><th class="num">作废</th><th>生成时间</th><th>备注</th><th></th></tr></thead>
          <tbody>
            ${batches.map((batch) => `
              <tr>
                <td class="code">${esc(batch.id)}</td>
                <td class="num">${num(batch.credits)}</td>
                <td class="num">${num(batch.total)}</td>
                <td class="num">${num(batch.unused)}</td>
                <td class="num">${num(batch.used)}</td>
                <td class="num">${batch.voided ? `<span class="bad">${num(batch.voided)}</span>` : '0'}</td>
                <td class="muted">${esc(stamp(batch.createdAt))}</td>
                <td class="muted">${esc(batch.note ?? '')}</td>
                <td>
                  <div class="actions">
                    <button type="button" data-act="filter-batch" data-batch="${esc(batch.id)}">只看这批</button>
                    <button type="button" data-act="export-batch" data-batch="${esc(batch.id)}">导出未用</button>
                    <button class="danger plain" type="button" data-act="void-batch" data-batch="${esc(batch.id)}" data-unused="${batch.unused}"${batch.unused ? '' : ' disabled'}>作废未用</button>
                    <button class="danger plain" type="button" data-act="delete-batch" data-batch="${esc(batch.id)}" data-total="${batch.total}"${batch.used ? ' disabled' : ''}>删除整批</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `
}

/** 卡密明细。筛选条件放在顶栏，切条件只重拉列表。 */
function cardsPanel() {
  if (!cardsData) return '<div class="panel"><h2>卡密明细</h2><div class="empty" style="margin-top:14px">正在加载…</div></div>'
  const rows = cardsData.cards ?? []
  const statuses = [
    { id: '', label: '全部' },
    { id: 'unused', label: '未使用' },
    { id: 'used', label: '已兑换' },
    { id: 'void', label: '已作废' },
  ]
  return `
    <div class="panel">
      <h2>卡密明细 <span class="tag">${num(cardsData.total)} 条符合条件</span></h2>
      <div class="range-row" style="margin-top:14px">
        <div class="range">
          ${statuses.map((item) => `
            <button class="range-item" type="button" data-act="card-status" data-status="${item.id}" aria-current="${cardFilter.status === item.id}">${esc(item.label)}</button>
          `).join('')}
        </div>
        <input id="card-keyword" type="text" placeholder="搜索卡密…" value="${esc(cardFilter.keyword)}" style="max-width:220px" />
        ${cardFilter.batch ? `<span class="tag accent">批次 ${esc(cardFilter.batch)}<button class="link" type="button" data-act="card-status" data-status-reset="1" style="margin-left:6px">清除</button></span>` : ''}
        <button class="ghost" type="button" data-act="export-filtered">导出当前筛选</button>
      </div>
      ${rows.length ? `
        <div class="table-wrap scroll-x">
          <table class="grid">
            <thead><tr><th>卡密</th><th class="num">积分</th><th>状态</th><th>备注</th><th>兑换人</th><th>兑换时间</th><th></th></tr></thead>
            <tbody>
              ${rows.map((card) => {
                const label = CARD_STATUS_LABELS[card.status] ?? CARD_STATUS_LABELS.unused
                return `
                  <tr>
                    <td class="code">${esc(card.code)}</td>
                    <td class="num">${num(card.credits)}</td>
                    <td><span class="tag ${label.tone}">${label.text}</span></td>
                    <td class="muted">${esc(card.note ?? '')}</td>
                    <td class="muted">${card.status === 'used' ? esc(userNameOf(card.usedBy)) : '—'}</td>
                    <td class="muted">${card.status === 'used' ? esc(stamp(card.usedAt)) : '—'}</td>
                    <td>
                      <div class="actions">
                        ${card.status === 'unused' ? `<button class="danger plain" type="button" data-act="void-card" data-code="${esc(card.code)}">作废</button>` : ''}
                        ${card.status === 'void' ? `<button type="button" data-act="restore-card" data-code="${esc(card.code)}">恢复</button>` : ''}
                        ${card.status === 'used' ? '<span class="muted">已兑换不可删</span>' : `<button class="danger plain" type="button" data-act="delete-card" data-code="${esc(card.code)}">删除</button>`}
                      </div>
                    </td>
                  </tr>
                `
              }).join('')}
            </tbody>
          </table>
        </div>
        ${cardsData.total > rows.length ? `<p class="hint" style="margin-top:12px">只显示最新 ${rows.length} 条，共 ${num(cardsData.total)} 条。用上面的筛选缩小范围，或直接导出。</p>` : ''}
      ` : '<div class="empty" style="margin-top:14px">没有符合条件的卡密。</div>'}
    </div>
  `
}

function redeemPanel() {
  const rows = cardsData?.recentRedeems ?? []
  if (!rows.length) return ''
  return `
    <div class="panel">
      <h2>最近的兑换</h2>
      <p class="hint">卡密换到哪个账号上一目了然，遇到"我明明买了"的纠纷先看这里。</p>
      <div class="table-wrap scroll-x">
        <table class="grid">
          <thead><tr><th>时间</th><th>卡密</th><th class="num">积分</th><th>兑换人</th><th>批次</th></tr></thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                <td class="muted">${esc(stamp(row.usedAt))}</td>
                <td class="code">${esc(row.code)}</td>
                <td class="num">${num(row.credits)}</td>
                <td>${esc(row.userName)}</td>
                <td class="muted">${esc(row.batch)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `
}

/** 用户余额表。余额是用户资产，所以只提供"设为某个数"而不是加法，做错了能一眼看出来。 */
function balancePanel(accounts) {
  const ledger = creditsPanel?.ledger ?? []
  return `
    <div class="panel">
      <h2>用户余额</h2>
      <p class="hint">调整余额会写一条流水，备注里记明是管理员操作。这里填的是调整后的余额，不是增量。</p>
      ${accounts.length ? `
        <div class="table-wrap scroll-x">
          <table class="grid">
            <thead><tr><th>用户</th><th class="num">当前余额</th><th class="num">累计到账</th><th class="num">累计消耗</th><th>最近变动</th><th></th></tr></thead>
            <tbody>
              ${accounts.map((item) => `
                <tr>
                  <td>${esc(item.name)}</td>
                  <td class="num"><strong>${num(item.balance)}</strong></td>
                  <td class="num">${num(item.totalIn)}</td>
                  <td class="num">${num(item.totalOut)}</td>
                  <td class="muted">${esc(item.updatedAt ? ago(item.updatedAt) : '—')}</td>
                  <td>
                    <div class="actions">
                      <button type="button" data-act="set-balance" data-id="${esc(item.id)}" data-name="${esc(item.name)}" data-balance="${item.balance}">调整</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="empty" style="margin-top:14px">还没有人持有积分。</div>'}

      ${ledger.length ? `
        <fieldset class="group" style="margin-top:20px">
          <legend>最近流水</legend>
          <div class="table-wrap scroll-x">
            <table class="grid">
              <thead><tr><th>时间</th><th>用户</th><th>类型</th><th class="num">变动</th><th class="num">变动后余额</th><th>说明</th></tr></thead>
              <tbody>
                ${ledger.slice(0, 60).map((entry) => {
                  const label = LEDGER_TYPE_LABELS[entry.type] ?? LEDGER_TYPE_LABELS.admin
                  const signed = entry.type === 'spend' ? -entry.amount : entry.amount
                  return `
                    <tr>
                      <td class="muted">${esc(stamp(entry.at))}</td>
                      <td>${esc(entry.userName)}</td>
                      <td><span class="tag ${label.tone}">${label.text}</span></td>
                      <td class="num ${signed < 0 ? 'bad' : ''}">${signed > 0 ? '+' : ''}${num(signed)}</td>
                      <td class="num">${num(entry.balanceAfter)}</td>
                      <td class="muted">${esc(entry.note ?? entry.ref ?? '')}</td>
                    </tr>
                  `
                }).join('')}
              </tbody>
            </table>
          </div>
        </fieldset>
      ` : ''}
    </div>
  `
}

// ===== 微信登录 =====

function renderWechatView() {
  const wechat = state.wechat ?? {}
  const callbackUrl = `${window.location.origin}${wechat.callbackPath ?? '/api/wechat/callback'}`
  const ready = Boolean(wechat.appId && wechat.hasAppSecret && wechat.hasToken)
  const qrPreview = wechat.hasQrcodeImage
    // 带上 updatedAt 做缓存击穿，不然换图之后浏览器还在放旧的那张。
    ? `<img src="/api/wechat/qr-image?v=${Number(state.updatedAt) || 0}" alt="公众号二维码" />`
    : '<span>还没有上传<br />公众号二维码</span>'

  return `
    <div class="page-head">
      <h1>微信登录</h1>
      <p>把公众号变成你的登录入口：用户扫码关注后自动建号，不用发账号、不用记口令。用户在建号时会一次性拿到注册赠送的积分。</p>
    </div>

    ${!wechat.enabled
      ? `<div class="alert" data-tone="warn">
          <div class="alert-body">
            <strong>微信登录还没生效</strong>
            <p>${ready
              ? '参数都齐了，但「启用微信登录」没勾上——勾上并保存，再去「访问与安全」把访问方式切到「微信扫码登录」。'
              : '需要先填好 AppID、AppSecret 和 Token 三项，缺一不可。填完保存后勾上「启用微信登录」。'}</p>
          </div>
          <button class="primary" type="button" data-view="access">去设置访问方式</button>
        </div>`
      : ''}

    <div class="panel">
      <h2>公众号类型</h2>
      <p class="hint">不同类型能调的接口差别很大，先确认你是哪一种，再选登录方式。</p>
      <div class="stats">
        <div class="stat"><strong class="accent">验证码</strong><span>任何类型都能用</span></div>
        <div class="stat"><strong class="bad">带参数二维码</strong><span>仅限认证服务号</span></div>
        <div class="stat"><strong class="ok">昵称头像</strong><span>认证订阅号即可</span></div>
      </div>
      <p class="hint" style="margin-top:14px">本方案对<b>未认证订阅号</b>同样可用：验证码方式只需要"用户能给你发消息"这一件事，不碰任何需要认证的接口，也不需要配置 IP 白名单。拉取昵称头像失败时会退成「微信用户 1234」这样的占位名，不影响登录。</p>
      <p class="hint">注意<b>带参数二维码</b>那条路对个人主体是走不通的：该接口只对微信认证服务号开放，而个人主体只能注册订阅号、注册不了服务号，两种类型还不可互转——<b>去做个人认证也解锁不了它</b>。个人认证真正能给到本站点的好处是「获取用户基本信息」，也就是能存下真实昵称和头像。想用扫码自动登录，只能另注册一个企业主体的服务号。</p>
    </div>

    <div class="panel">
      <h2>登录设置</h2>
      <form id="wechat-form" style="margin-top:14px">
        <label class="check"><input type="checkbox" name="enabled"${wechat.enabled ? ' checked' : ''} /><span>启用微信登录 <em>关掉后登录页直接报"本站未启用微信登录"</em></span></label>

        <fieldset class="group">
          <legend>登录方式</legend>
          <div class="modes two">${WECHAT_LOGIN_MODES.map((mode) => `
            <label class="mode" data-selected="${(wechat.loginMode ?? 'code') === mode.id}">
              <input type="radio" name="loginMode" value="${mode.id}"${(wechat.loginMode ?? 'code') === mode.id ? ' checked' : ''} />
              <span>
                <strong>${esc(mode.title)}</strong>
                <small>${esc(mode.detail)}</small>
              </span>
            </label>
          `).join('')}</div>
        </fieldset>

        <fieldset class="group">
          <legend>公众号凭据</legend>
          <div class="row">
            <label><span>AppID</span><input name="appId" value="${esc(wechat.appId ?? '')}" placeholder="wx1234567890abcdef" /></label>
            <label><span>Token（服务器配置里那个）</span>
              <input name="token" placeholder="${wechat.hasToken ? `当前 ${esc(wechat.tokenMask)}，留空表示不修改` : '自己随便定一个，填进公众号后台'}" autocomplete="off" />
            </label>
          </div>
          <div class="row">
            <label><span>AppSecret</span>
              <input name="appSecret" type="password" autocomplete="off" placeholder="${wechat.hasAppSecret ? `当前 ${esc(wechat.appSecretMask)}，留空表示不修改` : '公众号后台「基本配置」里获取'}" />
            </label>
            <label><span>EncodingAESKey（安全模式必填）</span>
              <input name="encodingAesKey" autocomplete="off" placeholder="${wechat.hasEncodingAesKey ? `当前 ${esc(wechat.encodingAesKeyMask)}，留空表示不修改` : '43 位字符，明文/兼容模式可留空'}" />
            </label>
          </div>
          <p class="hint" style="margin:-4px 0 16px">
            AppSecret 只在公众号后台显示一次，忘了只能重置。如果后台的「消息加解密方式」是<b>安全模式</b>（新版默认），
            必须把 43 位的 EncodingAESKey 一起填进来，否则收到的推送解不开。
          </p>
          <label class="check"><input type="checkbox" name="fetchProfile"${wechat.fetchProfile !== false ? ' checked' : ''} /><span>尝试拉取用户昵称与头像 <em>未认证订阅号会失败，会自动退回占位昵称，不影响登录</em></span></label>
          <label><span>关注后的回复文案</span>
            <textarea name="replyText" class="short" style="min-height:76px;font-family:inherit;font-size:13px" placeholder="留空使用默认：欢迎关注！请把电脑网页上显示的 6 位数字发给我，即可完成登录。">${esc(wechat.replyText ?? '')}</textarea>
          </label>
        </fieldset>

        <div class="btn-row">
          <button class="primary" type="submit">保存</button>
          <button type="button" id="wechat-test"${wechatTesting ? ' disabled' : ''}>${wechatTesting ? '正在测试…' : '测试凭据'}</button>
        </div>
        <p class="probe ${wechatProbe ? (wechatProbe.ok ? 'ok' : 'bad') : ''}" id="wechat-probe">${wechatProbe
          ? `${wechatProbe.ok ? '✓' : '✗'} ${esc(wechatProbe.message)}`
          : ''}</p>
        <p class="hint" style="margin-top:10px">「测试凭据」会去换一次 access_token。它同时验证三件事：AppID、AppSecret 是否正确，以及服务器的公网 IP 是否加进了公众号后台的 IP 白名单。<b>验证码方式其实不需要 access_token</b>，所以这一步失败也不代表登录用不了。</p>
      </form>
    </div>

    <div class="panel">
      <h2>公众号二维码</h2>
      <p class="hint">验证码方式下，网页要把这张图显示给用户扫。用公众号后台「设置与开发 → 公众号设置 → 账号详情」里那张二维码，或自己用微信生成都行。</p>
      <div class="qr-row" style="margin-top:16px">
        <div class="qr-box" id="qr-preview">${qrPreview}</div>
        <div>
          <label><span>上传图片（PNG / JPG，建议正方形）</span>
            <input type="file" id="qr-upload" accept="image/png,image/jpeg,image/webp,image/gif" />
          </label>
          <p class="hint" style="margin:-4px 0 14px">图片会以 base64 存进配置文件，建议压到 200KB 以内。存的是内联图，换服务器不用重新上传。</p>
          <div class="btn-row">
            ${wechat.hasQrcodeImage ? '<button class="danger plain" type="button" id="qr-clear">清除二维码</button>' : ''}
            <button class="ghost" type="button" id="qr-view"${wechat.hasQrcodeImage ? '' : ' disabled'}>在新窗口查看</button>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <h2>公众号后台要填什么</h2>
      <p class="hint">下面是这个后台算好的地址，原样复制到公众号后台即可。改动这里的配置不会自动同步过去，两边必须一致。</p>

      <label style="margin-top:16px"><span>服务器配置 → URL</span></label>
      <div class="copy-field">
        <code id="callback-url">${esc(callbackUrl)}</code>
        <button type="button" data-act="copy-callback">复制</button>
      </div>

      <div class="row" style="margin-top:16px">
        <label><span>服务器配置 → Token</span>
          <input value="${wechat.hasToken ? '已配置（就是上面填的那个）' : '还没配置'}" readonly />
        </label>
        <label><span>服务器配置 → EncodingAESKey</span>
          <input value="${wechat.hasEncodingAesKey ? '已配置（43 位）' : '未配置'}" readonly />
        </label>
      </div>

      <fieldset class="group">
        <legend>配置步骤</legend>
        <ol class="steps">
          <li>登录 <strong>mp.weixin.qq.com</strong>，进入「设置与开发 → 基本配置」。</li>
          <li>在「服务器配置」里把 <strong>URL</strong> 填成上面的地址，<strong>Token</strong> 填成本页填过的那个值，<strong>EncodingAESKey</strong> 若为安全模式则点「随机生成」后把结果复制回本页。</li>
          <li>「消息加解密方式」建议选<strong>安全模式</strong>（默认），选完把 EncodingAESKey 一并填回本页并保存。</li>
          <li>点「提交」。微信会立刻请求上面那个 URL 做校验——这一步要求这个服务已经部署在<strong>公网 80 / 443</strong> 上，且能被动访问。</li>
          <li>提交成功后点「启用」。之后把「IP 白名单」加上服务器的公网出口 IP（「基本配置」页会显示这个 IP）。</li>
          <li>回到前端打开登录页，扫一下二维码，在公众号里回复网页上的 6 位数字试试。</li>
        </ol>
      </fieldset>
    </div>
  `
}

// ===== 邮件发信 =====

/**
 * SMTP 服务商预设下拉。选中后自动把 host / port / 加密方式填进表单。
 * 预设列表由服务端下发（smtp.mjs 里的 SMTP_PRESETS），这里不重复维护一份，
 * 免得两边加服务商时漏改。
 */
function smtpPresetOptions(presets, currentHost, currentPort) {
  const list = Array.isArray(presets) ? presets : []
  const matched = list.find((preset) => preset.host && preset.host === currentHost)
  return [
    `<option value="">手动填写</option>`,
    ...list.map((preset) => {
      const selected = preset.host === currentHost && (!preset.port || preset.port === Number(currentPort))
      // note 挂在 option 上，选中时直接显示给管理员——"密码要填授权码"这类提醒
      // 放在选服务商的那一刻最有用。
      return `<option value="${esc(preset.id)}" data-note="${esc(preset.note ?? '')}"${selected ? ' selected' : ''}>${esc(preset.label)}</option>`
    }),
  ].join('')
}

function renderSmtpView() {
  const smtp = state.smtp ?? {}
  const site = state.site ?? {}
  const configured = Boolean(smtp.host && smtp.user && smtp.hasPassword)
  const registrationOn = site.registrationEnabled === true
  const ttlMinutes = Math.round((smtp.codeTtlSeconds ?? 600) / 60)
  const presets = smtp.presets ?? []
  const encryptions = [
    { id: 'ssl', label: 'SSL（465）', detail: '连上去就是加密的。QQ、163、腾讯企业邮都用这个。' },
    { id: 'starttls', label: 'STARTTLS（587）', detail: '先明文握手再升级加密。Gmail、多数自建邮局用这个。' },
    { id: 'none', label: '不加密（25）', detail: '只给同机或内网中继用。选它等于授权码明文过网。' },
  ]

  // 当前选中的预设说明，用来说明"这个服务商该怎么填"。
  const activePreset = presets.find((preset) => preset.host && preset.host === smtp.host)

  return `
    <div class="page-head">
      <h1>邮件发信</h1>
      <p>注册要验证邮箱，验证码就从这里发出去。填好并测通之后，用户才能在登录页自助注册。</p>
    </div>

    ${!smtp.enabled
      ? `<div class="alert" data-tone="warn">
          <div class="alert-body">
            <strong>邮件发信还没生效</strong>
            <p>${configured
              ? '参数都齐了，但「启用邮件发信」没勾上——勾上并保存，用户才能收到注册验证码。'
              : '需要先填好服务器地址、登录账号和授权码三项，缺一不可。填完保存后勾上「启用邮件发信」。'}</p>
          </div>
        </div>`
      : registrationOn
        ? ''
        : `<div class="alert">
            <div class="alert-body">
              <strong>发信通道已就绪，但自助注册还没开</strong>
              <p>去「访问与安全」把访问方式切到多用户账号模式，然后在「自助注册」里打开开关。</p>
            </div>
            <button class="primary" type="button" data-view="access">去开启注册</button>
          </div>`}

    <div class="panel">
      <h2>关键前提：这里填的是「授权码」，不是邮箱密码</h2>
      <p class="hint">
        QQ、163、腾讯企业邮这类邮箱都<b>不接受网页登录密码</b>去发信。必须先在邮箱后台开启 SMTP 服务，
        系统会给你一串 16 位的<b>授权码 / 客户端专用密码</b>，把它填到下面的「授权码」栏。
        这是本站最容易卡住的一步，填错会一直报 535。
      </p>
      <div class="stats" style="margin-top:16px">
        <div class="stat"><strong class="ok">1. 开启 SMTP</strong><span>邮箱设置里打开收发服务</span></div>
        <div class="stat"><strong class="ok">2. 拿授权码</strong><span>16 位，只显示一次</span></div>
        <div class="stat"><strong class="ok">3. 填进本页</strong><span>然后点「测试连接」</span></div>
      </div>
    </div>

    <div class="panel">
      <h2>发信设置</h2>
      <form id="smtp-form" style="margin-top:14px">
        <label class="check"><input type="checkbox" name="enabled"${smtp.enabled ? ' checked' : ''} /><span>启用邮件发信 <em>关掉后注册页会提示"本站还没配置邮件发信"</em></span></label>

        <fieldset class="group">
          <legend>服务器</legend>
          <label><span>快速预设</span>
            <select id="smtp-preset">${smtpPresetOptions(presets, smtp.host ?? '', smtp.port ?? 0)}</select>
          </label>
          <p class="hint" style="margin:-4px 0 16px" id="smtp-preset-note">${esc(activePreset?.note ?? '选一个预设会自动填好服务器地址、端口和加密方式，也可以自己填。')}</p>
          <div class="row">
            <label><span>SMTP 服务器</span><input name="host" value="${esc(smtp.host ?? '')}" placeholder="smtp.qq.com" /></label>
            <label><span>端口</span><input name="port" type="number" min="1" max="65535" value="${esc(smtp.port ?? 465)}" /></label>
          </div>
          <div class="modes three" style="margin-top:6px">${encryptions.map((mode) => `
            <label class="mode" data-selected="${(smtp.encryption ?? 'ssl') === mode.id}">
              <input type="radio" name="encryption" value="${mode.id}"${(smtp.encryption ?? 'ssl') === mode.id ? ' checked' : ''} />
              <span>
                <strong>${esc(mode.label)}</strong>
                <small>${esc(mode.detail)}</small>
              </span>
            </label>
          `).join('')}</div>
        </fieldset>

        <fieldset class="group">
          <legend>账号与凭据</legend>
          <div class="row">
            <label><span>登录账号（完整邮箱地址）</span><input name="user" value="${esc(smtp.user ?? '')}" placeholder="you@qq.com" autocomplete="off" /></label>
            <label><span>授权码 / 客户端专用密码</span>
              <input name="password" type="password" autocomplete="new-password" placeholder="${smtp.hasPassword ? `当前 ${esc(smtp.passwordMask)}，留空表示不修改` : '不是邮箱登录密码，是邮箱后台生成的授权码'}" />
            </label>
          </div>
          <div class="row">
            <label><span>发件人地址</span><input name="from" value="${esc(smtp.from ?? '')}" placeholder="留空 = 用上面的登录账号" /></label>
            <label><span>发件人显示名</span><input name="fromName" value="${esc(smtp.fromName ?? '')}" placeholder="留空 = 用站点标题" /></label>
          </div>
          <p class="hint" style="margin:-4px 0 16px">
            QQ、163 等邮箱<b>强制要求发件人地址和登录账号是同一个</b>，不一致会被 550 拒投，所以这里留空最省事。
          </p>
          <label class="check"><input type="checkbox" name="allowUnauthorized"${smtp.allowUnauthorized ? ' checked' : ''} /><span>跳过 TLS 证书校验 <em>只给用自签证书的自建邮局用，公网服务商千万别勾</em></span></label>
        </fieldset>

        <fieldset class="group">
          <legend>发信限流</legend>
          <div class="row">
            <label><span>同一邮箱每天最多</span><input name="dailyLimitPerEmail" type="number" min="1" max="200" value="${esc(smtp.dailyLimitPerEmail ?? 8)}" /></label>
            <label><span>同一 IP 每小时最多</span><input name="hourlyLimitPerIp" type="number" min="1" max="2000" value="${esc(smtp.hourlyLimitPerIp ?? 20)}" /></label>
          </div>
          <p class="hint" style="margin:-4px 0 16px">
            两道限制护的是不同的东西：前者防止有人拿本站去骚扰别人的邮箱，后者防止有人换着一堆邮箱把你的发信额度刷爆。
            QQ 个人邮箱每天的发信量有硬上限，被刷爆之后全站都注册不了。验证码 ${ttlMinutes} 分钟有效，同一邮箱 60 秒内只能要一次。
          </p>
        </fieldset>

        <div class="btn-row">
          <button class="primary" type="submit">保存</button>
          <button type="button" id="smtp-test"${smtpTesting ? ' disabled' : ''}>${smtpTesting ? '正在测试…' : '测试连接'}</button>
        </div>
        <p class="probe ${smtpProbe ? (smtpProbe.ok ? 'ok' : 'bad') : ''}" id="smtp-probe">${smtpProbe
          ? `${smtpProbe.ok ? '✓' : '✗'} ${esc(smtpProbe.message)}`
          : ''}</p>
        <p class="hint" style="margin-top:10px">「测试连接」只握手和认证，不发信、不消耗额度。它验证四件事：服务器地址、端口、加密方式、授权码。</p>
      </form>
    </div>

    <div class="panel">
      <h2>真发一封试试</h2>
      <p class="hint">
        连接测试通过只能说明"能登录"，证明不了"信能进收件箱"。域名信誉、内容是否被判垃圾邮件，
        都只有真发一封才看得出来。这里发的是一封测试邮件，不占用任何用户的额度。
      </p>
      <form id="smtp-send-form" style="margin-top:16px">
        <label><span>收件地址</span>
          <div class="with-action">
            <input name="to" value="${esc(smtpTestTo || smtp.user || '')}" placeholder="留空 = 发给自己（登录账号）" />
            <button type="button" id="smtp-send"${smtpTesting ? ' disabled' : ''}>发送测试邮件</button>
          </div>
        </label>
        <p class="hint" style="margin:6px 0 0">如果没收到，先翻<b>垃圾邮件</b>文件夹。个人邮箱刚配好时，第一封很容易被拦。</p>
      </form>
    </div>

    <div class="panel">
      <h2>常见故障</h2>
      <div class="stats" style="margin-top:14px">
        <div class="stat"><strong class="bad">535</strong><span>账号或授权码错。九成是填了邮箱登录密码。</span></div>
        <div class="stat"><strong class="bad">550</strong><span>发件地址和登录账号不是同一个邮箱。</span></div>
        <div class="stat"><strong class="bad">连接超时</strong><span>端口或加密方式不匹配，或服务器出网被拦。</span></div>
        <div class="stat"><strong class="bad">421</strong><span>触发了邮箱服务商的每日发信上限。</span></div>
      </div>
    </div>
  `
}

// ===== 骨架 =====

function render() {
  if (!state.authenticated) return renderLogin()

  const counts = {
    channels: state.channels.length,
    users: (state.users ?? []).length,
    // 用未使用的卡密张数当角标：管理员最关心"还有多少货没卖出去"。
    credits: (state.credits?.cards?.unused ?? 0) || null,
  }
  const body = view === 'users' ? renderUsersView()
    : view === 'usage' ? renderUsageView()
    : view === 'agent' ? renderAgentView()
    : view === 'credits' ? renderCreditsView()
    : view === 'wechat' ? renderWechatView()
    : view === 'smtp' ? renderSmtpView()
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
      // 积分页要两份数据，多拉一次接口但换来"数字和明细在同一次渲染里对齐"。
      if (view === 'credits') return void loadCreditsPanel()
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
  bindCreditsEvents()
  bindWechatEvents()
  bindSmtpEvents()

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

  app.querySelector('#audit-all')?.addEventListener('click', async () => {
    if (!await confirmDialog({
      title: `给 ${state.channels.length} 条渠道各发一次真实出图请求？`,
      message: '自检会真的出图，每条渠道消耗一张 1024×1024 低质量图的额度。这是区分「没余额」和「密钥错」的唯一办法——只列模型的连通测试对欠费账号一律显示正常。逐条进行，几十条渠道可能要等几分钟。',
      confirmText: '开始自检',
    })) return

    auditRunning = true
    auditResults = {}
    render()
    // 一条一条请求，而不是让服务端在一个请求里跑完全部：单次 HTTP 挂几分钟
    // 很容易被反代掐断，而且中途失败就什么结果都拿不到。这样还能边测边出结果。
    for (const channel of [...state.channels]) {
      auditProgress = channel.name
      render()
      try {
        const result = await api('/api/admin/channels/audit', { method: 'POST', body: { ids: [channel.id] } })
        if (result.results[0]) auditResults[channel.id] = result.results[0]
      } catch (err) {
        auditResults[channel.id] = { id: channel.id, name: channel.name, verdict: 'error', message: err.message, latencyMs: 0 }
      }
      render()
    }

    auditProgress = ''
    auditRunning = false
    const rows = Object.values(auditResults)
    const noBalance = rows.filter((item) => item.verdict === 'no-balance').length
    const ok = rows.filter((item) => item.verdict === 'ok').length
    // 自检成功的渠道服务端已撤掉故障标记，重新拉一次 state 让徽标同步。
    await refresh()
    showToast(noBalance ? `${noBalance} 条渠道没余额，${ok} 条正常` : `自检完成：${ok} / ${rows.length} 条能出图`, noBalance ? 'bad' : 'good')
  })

  app.querySelector('#clear-audit')?.addEventListener('click', () => {
    auditResults = null
    render()
  })

  app.querySelector('#disable-no-balance')?.addEventListener('click', async () => {
    const targets = state.channels
      .filter((channel) => channel.enabled && auditResults?.[channel.id]?.verdict === 'no-balance')
      .map((channel) => ({ id: channel.id, name: channel.name }))
    if (!targets.length) return showToast('这些渠道已经都是停用状态了', 'good')

    if (!await confirmDialog({
      title: `停用 ${targets.length} 条没余额的渠道？`,
      message: `${targets.map((item) => item.name).join('、')} 会从出图链路里移除，前端立刻看不到它们。密钥和其他配置都保留——充值后回到卡片里重新勾上「启用此渠道」就能继续用。`,
      confirmText: `停用这 ${targets.length} 条`,
    })) return

    try {
      const result = await api('/api/admin/channels/bulk-disable', { method: 'POST', body: { ids: targets.map((item) => item.id) } })
      await refresh()
      showToast(`已停用 ${result.disabled.length} 条：${result.disabled.join('、')}`, 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
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

  // 只有勾了"额外要求邀请码"才展开邀请码那一块——默认不要求，展开只会让人以为必填。
  const requireInput = form.querySelector('[name=requireInviteCode]')
  const extra = form.querySelector('#invite-extra')
  requireInput?.addEventListener('change', () => {
    if (extra) extra.style.display = requireInput.checked ? 'block' : 'none'
  })

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
      showToast('邀请码已生成', 'good')
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
      message: '发出去的邀请链接全部失效，已用次数归零。已注册的账号照常能登录。如果你还勾着「额外要求邀请码」，自助注册会一起停掉。',
      confirmText: '作废',
    })) return
    try {
      await api('/api/admin/invite', { method: 'DELETE' })
      await refresh()
      showToast('邀请码已作废', 'good')
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

// ===== 积分与卡密的事件 =====

/** 同源下载。用 <a download> 而不是 window.open：后者会被弹窗拦截器挡掉。 */
function downloadFile(url) {
  const link = document.createElement('a')
  link.href = url
  link.download = ''
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function bindCreditsEvents() {
  // ---- 计费设置 ----
  const packRows = app.querySelector('#pack-rows')
  packRows?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-act=remove-pack]')
    if (button) button.closest('[data-pack]').remove()
  })

  app.querySelector('[data-act=add-pack]')?.addEventListener('click', () => {
    packRows.insertAdjacentHTML('beforeend', packRow())
  })

  app.querySelector('#credits-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(event.target)

    // 套餐与倍率不在 FormData 的自然形状里（一个是动态行、一个是按渠道 id 命名的），
    // 所以这两块直接从 DOM 读，比强行给每行编个名字再解包更清楚。
    const packs = [...event.target.querySelectorAll('[data-pack]')]
      .map((row) => ({
        name: row.querySelector('[name=packName]').value.trim(),
        price: row.querySelector('[name=packPrice]').value.trim(),
        credits: Number(row.querySelector('[name=packCredits]').value) || 0,
      }))
      // 面额为 0 的行在服务端会被丢掉，这里先丢免得用户以为存上了。
      .filter((pack) => pack.credits > 0)

    const channelRates = {}
    for (const input of event.target.querySelectorAll('input[name^="rate:"]')) {
      const id = input.name.slice('rate:'.length)
      const value = Number(input.value)
      if (id && Number.isFinite(value) && value > 0) channelRates[id] = Math.trunc(value)
    }

    try {
      await api('/api/admin/credits', {
        method: 'PUT',
        body: {
          credits: {
            enabled: data.get('enabled') === 'on',
            costPerImage: Number(data.get('costPerImage')) || 0,
            signupBonus: Number(data.get('signupBonus')) || 0,
            purchaseUrl: String(data.get('purchaseUrl') ?? '').trim(),
            packs,
            channelRates,
          },
        },
      })
      await loadCreditsPanel()
      showToast('计费设置已保存', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })

  // ---- 生成卡密 ----
  app.querySelector('#card-gen-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(event.target)
    try {
      const result = await api('/api/admin/cards', {
        method: 'POST',
        body: {
          credits: Number(data.get('credits')),
          count: Number(data.get('count')),
          note: String(data.get('note') ?? ''),
        },
      })
      freshCards = result
      // 生成后立刻跳到积分页的顶部：明文卡密就在那里等着被抄走。
      await loadCreditsPanel()
      showToast(`已生成 ${result.count} 张卡密`, 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })

  app.querySelector('[data-act=copy-fresh]')?.addEventListener('click', (event) => {
    const textarea = app.querySelector('#fresh-codes')
    void copyText(textarea.value, textarea)
  })

  app.querySelector('[data-act=dismiss-fresh]')?.addEventListener('click', () => {
    freshCards = null
    render()
  })

  // ---- 卡密筛选 ----
  for (const button of app.querySelectorAll('[data-act=card-status]')) {
    button.addEventListener('click', () => {
      // 「清除批次」与状态切换共用一个处理器：两者都是对筛选条件的改动。
      if (button.dataset.statusReset) cardFilter.batch = ''
      else {
        cardFilter.status = button.dataset.status
        cardFilter.batch = ''
      }
      void loadCards()
    })
  }

  const keywordInput = app.querySelector('#card-keyword')
  if (keywordInput) {
    let timer = 0
    keywordInput.addEventListener('input', () => {
      // 防抖：每敲一个字就打一次接口，几百张卡也经不起这么问。
      clearTimeout(timer)
      timer = setTimeout(() => {
        cardFilter.keyword = keywordInput.value.trim()
        void loadCards({ keepKeywordFocus: true })
      }, 350)
    })
  }

  // ---- 卡密操作 ----
  for (const button of app.querySelectorAll('[data-act=void-card],[data-act=restore-card],[data-act=delete-card]')) {
    button.addEventListener('click', async () => {
      const code = button.dataset.code
      const action = button.dataset.act
      if (action === 'delete-card') {
        if (!await confirmDialog({
          title: '删除这张卡密？',
          message: `${code} 会被彻底抹掉，卡密库容量是有限的，删掉能腾出位置。已兑换的卡不允许删除。`,
          confirmText: '删除',
        })) return
        try {
          const result = await api('/api/admin/cards/delete', { method: 'POST', body: { codes: [code] } })
          await loadCards()
          showToast(result.skipped ? '这张卡已兑换，不能删除' : '卡密已删除', result.skipped ? 'bad' : 'good')
        } catch (err) {
          showToast(err.message, 'bad')
        }
        return
      }

      try {
        await api(`/api/admin/cards/${action === 'void-card' ? 'void' : 'restore'}`, {
          method: 'POST',
          body: { codes: [code] },
        })
        await loadCards()
        showToast(action === 'void-card' ? '卡密已作废，兑换时会提示无效' : '卡密已恢复可用', 'good')
      } catch (err) {
        showToast(err.message, 'bad')
      }
    })
  }

  // ---- 批次操作 ----
  for (const button of app.querySelectorAll('[data-act=void-batch],[data-act=delete-batch],[data-act=filter-batch],[data-act=export-batch]')) {
    button.addEventListener('click', async () => {
      const batch = button.dataset.batch
      const action = button.dataset.act

      if (action === 'filter-batch') {
        cardFilter.batch = batch
        cardFilter.status = ''
        return void loadCards()
      }
      if (action === 'export-batch') {
        return downloadFile(`/api/admin/cards/export?batch=${encodeURIComponent(batch)}&status=unused&with-credits=1`)
      }

      const isDelete = action === 'delete-batch'
      const count = isDelete ? Number(button.dataset.total) : Number(button.dataset.unused)
      if (!await confirmDialog({
        title: isDelete ? '删除整批卡密？' : `作废这 ${count} 张未使用的卡密？`,
        message: isDelete
          ? `这一批共 ${count} 张会从卡密库里移除（已兑换的会被保留，它们是对账凭证）。`
          : '作废后这些卡在兑换时会提示"已作废"，但你随时可以把单张恢复回来。',
        confirmText: isDelete ? '删除整批' : '作废',
      })) return

      try {
        const result = await api(isDelete ? '/api/admin/cards/delete' : '/api/admin/cards/void', {
          method: 'POST',
          body: { batch },
        })
        await loadCards()
        if (isDelete && result.skipped) showToast(`已删除 ${result.removed} 张，保留 ${result.skipped} 张已兑换的`, 'good')
        else showToast(isDelete ? '整批已删除' : `已作废 ${result.changed ?? count} 张`, 'good')
      } catch (err) {
        showToast(err.message, 'bad')
      }
    })
  }

  // ---- 导出与余额调整 ----
  app.querySelector('[data-act=export-filtered]')?.addEventListener('click', () => {
    const query = new URLSearchParams({ 'with-credits': '1' })
    if (cardFilter.status) query.set('status', cardFilter.status)
    if (cardFilter.batch) query.set('batch', cardFilter.batch)
    downloadFile(`/api/admin/cards/export?${query}`)
  })

  for (const button of app.querySelectorAll('[data-act=set-balance]')) {
    button.addEventListener('click', async () => {
      const id = button.dataset.id
      const name = button.dataset.name
      const current = Number(button.dataset.balance) || 0
      const value = await promptDialog({
        title: `调整「${name}」的积分`,
        message: `现在是 ${num(current)} 分。填调整后的余额，会记一条"管理员调账"流水。`,
        label: '调整后的余额',
        value: String(current),
        type: 'number',
        confirmText: '保存',
      })
      if (value == null || value === '') return

      const next = Number(value)
      if (!Number.isFinite(next) || next < 0) return showToast('请填一个不小于 0 的数字', 'bad')
      try {
        await api(`/api/admin/credits/users/${encodeURIComponent(id)}`, { method: 'PUT', body: { balance: next } })
        // 这个按钮在「用户」和「积分与卡密」两页都会出现，各自要用自己的数据源刷新。
        if (view === 'credits') await loadCreditsPanel()
        else await refresh()
        showToast(`余额已调整为 ${num(next)}`, 'good')
      } catch (err) {
        showToast(err.message, 'bad')
      }
    })
  }

  app.querySelector('[data-act=clear-credit-stats]')?.addEventListener('click', async () => {
    if (!await confirmDialog({
      title: '清空积分统计？',
      message: '只会清掉"今日/按天"的聚合数字和明细流水，用户的余额一分不动，卡密记录也保留。',
      confirmText: '清空统计',
    })) return
    try {
      await api('/api/admin/credits/stats', { method: 'DELETE' })
      await loadCreditsPanel()
      showToast('统计已清空，余额未受影响', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })
}

// ===== 微信登录的事件 =====

/** 上传的二维码转成内联 data URL。存内联图是为了换服务器时不用重新上传。 */
function readImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

function bindSmtpEvents() {
  const form = app.querySelector('#smtp-form')
  if (!form) return

  // 预设只负责填表单，保存仍然走常规路径——这样管理员选完还能手动微调。
  form.querySelector('#smtp-preset')?.addEventListener('change', (event) => {
    const option = event.target.selectedOptions?.[0]
    const preset = (state.smtp?.presets ?? []).find((item) => item.id === event.target.value)
    const note = app.querySelector('#smtp-preset-note')
    if (note) note.textContent = option?.dataset.note || '按服务商文档填写服务器地址、端口和加密方式。'
    if (!preset) return
    if (preset.host) form.querySelector('[name=host]').value = preset.host
    if (preset.port) form.querySelector('[name=port]').value = preset.port
    if (preset.encryption) {
      const radio = form.querySelector(`[name=encryption][value=${preset.encryption}]`)
      if (radio) {
        radio.checked = true
        // radio 的 :checked 影响不到祖先卡片，选中态得手动同步。
        for (const card of form.querySelectorAll('.mode')) {
          card.dataset.selected = String(card.querySelector('input').checked)
        }
      }
    }
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    const body = {
      enabled: data.get('enabled') === 'on',
      host: String(data.get('host') ?? '').trim(),
      port: Number(data.get('port')) || 0,
      encryption: String(data.get('encryption') ?? 'ssl'),
      user: String(data.get('user') ?? '').trim(),
      from: String(data.get('from') ?? '').trim(),
      fromName: String(data.get('fromName') ?? '').trim(),
      allowUnauthorized: data.get('allowUnauthorized') === 'on',
      dailyLimitPerEmail: Number(data.get('dailyLimitPerEmail')) || 8,
      hourlyLimitPerIp: Number(data.get('hourlyLimitPerIp')) || 20,
    }
    // 授权码遵循"留空 = 不修改"：后台每次保存都重填一遍授权码太反人类。
    const password = String(data.get('password') ?? '').trim()
    if (password) body.password = password

    try {
      await api('/api/admin/smtp', { method: 'PUT', body })
      smtpProbe = null
      await refresh()
      showToast('邮件设置已保存', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })

  form.querySelector('#smtp-test')?.addEventListener('click', async () => {
    smtpTesting = true
    smtpProbe = null
    render()
    try {
      smtpProbe = await api('/api/admin/smtp/test', { method: 'POST' })
    } catch (err) {
      smtpProbe = { ok: false, message: err.message }
    } finally {
      smtpTesting = false
    }
    render()
  })

  app.querySelector('#smtp-send')?.addEventListener('click', async (event) => {
    const input = app.querySelector('#smtp-send-form [name=to]')
    smtpTestTo = String(input?.value ?? '').trim()
    event.target.disabled = true
    smtpProbe = null
    try {
      smtpProbe = await api('/api/admin/smtp/send-test', { method: 'POST', body: { to: smtpTestTo } })
    } catch (err) {
      smtpProbe = { ok: false, message: err.message }
    } finally {
      event.target.disabled = false
    }
    render()
  })
}

function bindWechatEvents() {
  app.querySelector('#wechat-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(event.target)
    const body = {
      enabled: data.get('enabled') === 'on',
      loginMode: String(data.get('loginMode') ?? 'code'),
      appId: String(data.get('appId') ?? '').trim(),
      fetchProfile: data.get('fetchProfile') === 'on',
      replyText: String(data.get('replyText') ?? ''),
    }

    // 三个凭据都遵循"留空 = 不修改"：后台每次保存都重填一遍 AppSecret 太反人类。
    for (const key of ['appSecret', 'token', 'encodingAesKey']) {
      const value = String(data.get(key) ?? '').trim()
      if (value) body[key] = value
    }

    if (body.encodingAesKey && body.encodingAesKey.length !== 43) {
      return showToast('EncodingAESKey 必须是 43 位字符，请从公众号后台原样复制', 'bad')
    }

    try {
      await api('/api/admin/wechat', { method: 'PUT', body })
      await refresh()
      showToast('微信设置已保存', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })

  app.querySelector('#wechat-test')?.addEventListener('click', async () => {
    wechatTesting = true
    wechatProbe = null
    render()
    try {
      wechatProbe = await api('/api/admin/wechat/test', { method: 'POST' })
    } catch (err) {
      wechatProbe = { ok: false, message: err.message }
    } finally {
      wechatTesting = false
    }
    render()
  })

  app.querySelector('#qr-upload')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const dataUrl = await readImageAsDataUrl(file)
      // 服务端按 40 万字符截断，超了会被悄悄切掉半张图，所以这里先拦下来。
      if (dataUrl.length > 400_000) {
        return showToast(`图片太大了（约 ${Math.round(file.size / 1024)}KB），请压到 200KB 以内再上传`, 'bad')
      }
      await api('/api/admin/wechat', { method: 'PUT', body: { qrcodeImage: dataUrl } })
      await refresh()
      showToast('二维码已上传', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })

  app.querySelector('#qr-clear')?.addEventListener('click', async () => {
    if (!await confirmDialog({
      title: '清除公众号二维码？',
      message: '登录页将不再显示二维码。已经关注过公众号的用户仍然可以用验证码登录，新用户则无从下手。',
      confirmText: '清除',
    })) return
    try {
      await api('/api/admin/wechat', { method: 'PUT', body: { qrcodeImage: '' } })
      await refresh()
      showToast('二维码已清除', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })

  app.querySelector('#qr-view')?.addEventListener('click', () => {
    window.open('/api/wechat/qr-image', '_blank', 'noopener')
  })

  app.querySelector('[data-act=copy-callback]')?.addEventListener('click', (event) => {
    const code = app.querySelector('#callback-url')
    void copyText(code.textContent, code)
  })
}

refresh().catch((err) => {
  app.className = ''
  app.innerHTML = `<div class="login-shell"><div class="panel login-panel"><h1>加载失败</h1><p class="error" style="margin-top:8px">${esc(err.message)}</p></div></div>`
})
