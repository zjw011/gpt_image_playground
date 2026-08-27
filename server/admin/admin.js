// 后台管理页：无构建步骤的原生 ES module。
// 状态全部来自 /api/admin/state，写操作后重新拉取，避免本地与服务端不一致。

const app = document.getElementById('app')
const toastEl = document.getElementById('toast')

const BUILT_IN_PROVIDERS = [
  { id: 'openai', label: 'OpenAI 兼容（Images / Responses）' },
  { id: 'sb2api-async', label: 'sb2api 异步' },
  { id: 'fal', label: 'fal.ai' },
]

let state = null
let expandedId = null
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

// ===== 登录 / 初始化 =====

function renderLogin() {
  const first = !state.initialized
  app.className = ''
  app.innerHTML = `
    <div class="panel login-panel">
      <h1>${first ? '初始化管理员口令' : '后台登录'}</h1>
      <p class="hint">${first
        ? '这是首次启动，请设置管理员口令（至少 8 个字符）。设置后即以管理员身份登录。'
        : '请输入管理员口令。连续失败 10 次会临时锁定该 IP。'}</p>
      <form id="login-form">
        <label>
          <span>管理员口令</span>
          <input type="password" name="password" autocomplete="current-password" required minlength="${first ? 8 : 1}" />
        </label>
        <div class="btn-row">
          <button class="primary" type="submit">${first ? '设置并登录' : '登录'}</button>
        </div>
      </form>
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

// ===== 主界面 =====

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
      <div class="row">
        <label><span>渠道名称</span><input name="name" value="${esc(channel.name)}" required /></label>
        <label><span>服务商类型</span><select name="provider">${providerOptions(channel.provider)}</select></label>
      </div>
      <div class="row">
        <label><span>API 地址${isFal ? '（留空用 https://fal.run；填写则视为 fal 兼容网关）' : '（结尾带 / 表示直接拼接，否则自动补 /v1）'}</span>
          <input name="baseUrl" value="${esc(channel.baseUrl)}" placeholder="https://api.openai.com/v1" /></label>
        <label><span>模型 ID</span><input name="model" value="${esc(channel.model)}" required /></label>
      </div>
      <label><span>API Key${channel.hasApiKey ? `（当前 ${esc(channel.apiKeyMask)}，留空表示不修改）` : ''}</span>
        <input name="apiKey" type="password" autocomplete="off" placeholder="${channel.hasApiKey ? '不修改' : 'sk-...'}" /></label>
      <div class="row">
        <label><span>API 模式</span>
          <select name="apiMode">
            <option value="images"${channel.apiMode === 'images' ? ' selected' : ''}>Images API</option>
            <option value="responses"${channel.apiMode === 'responses' ? ' selected' : ''}>Responses API</option>
          </select></label>
        <label><span>超时（秒）</span><input name="timeout" type="number" min="10" max="3600" value="${channel.timeout}" /></label>
      </div>
      <label><span>备注（会显示给前端用户）</span><input name="description" value="${esc(channel.description)}" /></label>
      <label class="check"><input type="checkbox" name="enabled"${channel.enabled ? ' checked' : ''} /><span>启用此渠道</span></label>
      <label class="check"><input type="checkbox" name="codexCli"${channel.codexCli ? ' checked' : ''} /><span>Codex CLI 兼容模式（禁用质量参数，多图改并发）</span></label>
      <label class="check"><input type="checkbox" name="responseFormatB64Json"${channel.responseFormatB64Json ? ' checked' : ''} /><span>强制请求 b64_json 返回格式</span></label>
      <label class="check"><input type="checkbox" name="streamImages"${channel.streamImages ? ' checked' : ''} /><span>启用流式生成（仅 OpenAI + Responses 有效；故障转移期间会自动关闭）</span></label>
      <div class="row">
        <label><span>流式中间图数量</span><input name="streamPartialImages" type="number" min="0" max="3" value="${channel.streamPartialImages}" /></label>
        <label><span>透明背景实现</span>
          <select name="transparentBackgroundMethod">
            <option value="api"${channel.transparentBackgroundMethod === 'api' ? ' selected' : ''}>接口原生 background=transparent</option>
            <option value="local"${channel.transparentBackgroundMethod === 'local' ? ' selected' : ''}>本地色键抠除</option>
          </select></label>
      </div>
      <div class="btn-row">
        <button class="primary" type="submit">保存</button>
        <button type="button" data-act="test">连通测试</button>
        <button type="button" data-act="move-up"${idx === 0 ? ' disabled' : ''}>上移</button>
        <button type="button" data-act="move-down"${idx === state.channels.length - 1 ? ' disabled' : ''}>下移</button>
        <span class="spacer"></span>
        <button class="danger" type="button" data-act="delete">删除渠道</button>
      </div>
      <p class="test-result" data-role="test-result"></p>
    </form>
  `
}

function channelCard(channel, idx) {
  const open = expandedId === channel.id
  return `
    <div class="channel" data-id="${esc(channel.id)}">
      <div class="channel-head">
        <span class="badge order">#${idx + 1}</span>
        <span class="name">${esc(channel.name)}</span>
        <span class="badge ${channel.enabled ? 'on' : 'off'}">${channel.enabled ? '启用' : '停用'}</span>
        <span class="badge">${esc(channel.provider)}</span>
        <span class="badge">${esc(channel.model)}</span>
        ${channel.hasApiKey ? '' : '<span class="badge off">缺少 Key</span>'}
        <span class="spacer"></span>
        <button class="ghost" data-act="toggle" data-id="${esc(channel.id)}">${open ? '收起' : '编辑'}</button>
      </div>
      <p class="channel-meta">${esc(channel.baseUrl || '（未填地址）')}${channel.description ? ` · ${esc(channel.description)}` : ''}</p>
      ${open ? `<div class="channel-body">${channelForm(channel, idx)}</div>` : ''}
    </div>
  `
}

function render() {
  if (!state.authenticated) return renderLogin()

  app.className = ''
  app.innerHTML = `
    <div class="topbar">
      <h1>渠道管理</h1>
      <div class="btn-row">
        <a href="/" target="_blank" rel="noreferrer"><button class="ghost" type="button">打开前端</button></a>
        <button class="ghost" id="logout" type="button">退出登录</button>
      </div>
    </div>

    <div class="panel">
      <h2>渠道（共 ${state.channels.length} 条）</h2>
      <p class="hint">故障转移按下面的列表顺序依次尝试，用「上移／下移」调整。只有「启用」且「已配置 Key」的渠道会下发给前端。</p>
      ${state.channels.length ? state.channels.map(channelCard).join('') : '<p class="hint">还没有渠道，点下方按钮新增。</p>'}
      <div class="btn-row"><button class="primary" id="add-channel" type="button">新增渠道</button></div>
    </div>

    <div class="panel">
      <h2>站点设置</h2>
      <form id="site-form">
        <label><span>站点标题</span><input name="title" value="${esc(state.site.title)}" /></label>
        <label class="check"><input type="checkbox" name="guestGateEnabled"${state.site.guestGateEnabled ? ' checked' : ''} /><span>启用访客口令门禁${state.guestPasswordSet ? '' : '（尚未设置访客口令，启用后前端将无法进入）'}</span></label>
        <label class="check"><input type="checkbox" name="failoverEnabled"${state.site.failoverEnabled ? ' checked' : ''} /><span>渠道失败时自动切换到下一个渠道</span></label>
        <label class="check"><input type="checkbox" name="allowGuestParamOverride"${state.site.allowGuestParamOverride ? ' checked' : ''} /><span>允许前端用户调整尺寸/质量等生成参数</span></label>
        <label><span>最多尝试渠道数（0 = 全部尝试）</span><input name="failoverMaxAttempts" type="number" min="0" max="50" value="${state.site.failoverMaxAttempts}" /></label>
        <div class="btn-row"><button class="primary" type="submit">保存站点设置</button></div>
      </form>
    </div>

    <div class="panel">
      <h2>口令</h2>
      <form id="guest-password-form">
        <label><span>访客口令（前端进入口令，至少 8 个字符；留空并保存即清除）</span>
          <input name="password" type="password" autocomplete="new-password" placeholder="${state.guestPasswordSet ? '已设置，输入新值可覆盖' : '未设置'}" /></label>
        <div class="btn-row"><button type="submit">保存访客口令</button></div>
      </form>
      <hr style="border:none;border-top:1px solid var(--border);margin:16px 0" />
      <form id="admin-password-form">
        <div class="row">
          <label><span>当前管理员口令</span><input name="currentPassword" type="password" autocomplete="current-password" required /></label>
          <label><span>新管理员口令（至少 8 个字符）</span><input name="password" type="password" autocomplete="new-password" required minlength="8" /></label>
        </div>
        <div class="btn-row"><button type="submit">修改管理员口令</button></div>
      </form>
    </div>

    <div class="panel">
      <h2>自定义服务商</h2>
      <p class="hint">粘贴 http-image 模板的 JSON 数组，用于对接非 OpenAI 格式的第三方接口。格式与前端「自定义服务商」一致，可用项目 docs/custom-provider-llm-prompt.md 让大模型生成。</p>
      <form id="providers-form">
        <textarea name="customProviders" spellcheck="false">${esc(JSON.stringify(state.customProviders ?? [], null, 2))}</textarea>
        <div class="btn-row"><button class="primary" type="submit">保存自定义服务商</button></div>
      </form>
    </div>
  `

  bindEvents()
}

function readForm(form) {
  const data = new FormData(form)
  const value = {}
  for (const [key, raw] of data.entries()) value[key] = raw
  for (const input of form.querySelectorAll('input[type=checkbox]')) value[input.name] = input.checked
  for (const input of form.querySelectorAll('input[type=number]')) value[input.name] = Number(value[input.name])
  return value
}

function bindEvents() {
  app.querySelector('#logout')?.addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' })
    expandedId = null
    await refresh()
  })

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
      expandedId = result.channel.id
      await refresh()
      showToast('已新增渠道，请填入真实 API Key 后启用', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })

  for (const button of app.querySelectorAll('[data-act=toggle]')) {
    button.addEventListener('click', () => {
      expandedId = expandedId === button.dataset.id ? null : button.dataset.id
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
      const target = form.querySelector('[data-role=test-result]')
      event.target.disabled = true
      target.textContent = '正在探测…'
      target.className = 'test-result'
      try {
        const result = await api('/api/admin/channels/test', { method: 'POST', body: { id } })
        target.textContent = `${result.ok ? '✓' : '✗'} ${result.message}${result.latencyMs != null ? `（${result.latencyMs}ms）` : ''}`
        target.className = `test-result ${result.ok ? 'ok' : 'bad'}`
      } catch (err) {
        target.textContent = `✗ ${err.message}`
        target.className = 'test-result bad'
      } finally {
        event.target.disabled = false
      }
    })

    form.querySelector('[data-act=delete]').addEventListener('click', async () => {
      if (!confirm('确认删除这个渠道？前端将立即无法使用它。')) return
      try {
        await api(`/api/admin/channels/${encodeURIComponent(id)}`, { method: 'DELETE' })
        expandedId = null
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

  app.querySelector('#site-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    try {
      await api('/api/admin/site', { method: 'PUT', body: readForm(event.target) })
      await refresh()
      showToast('站点设置已保存', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })

  app.querySelector('#guest-password-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const password = new FormData(event.target).get('password')
    if (password && String(password).length < 8) return showToast('访客口令至少 8 个字符', 'bad')
    if (!password && !confirm('留空保存会清除访客口令，前端将无法通过口令进入（除非关闭门禁）。继续？')) return
    try {
      await api('/api/admin/password', { method: 'PUT', body: { target: 'guest', password } })
      await refresh()
      showToast(password ? '访客口令已更新' : '访客口令已清除', 'good')
    } catch (err) {
      showToast(err.message, 'bad')
    }
  })

  app.querySelector('#admin-password-form').addEventListener('submit', async (event) => {
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

  app.querySelector('#providers-form').addEventListener('submit', async (event) => {
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

refresh().catch((err) => {
  app.className = ''
  app.innerHTML = `<div class="panel"><h1>加载失败</h1><p class="error">${esc(err.message)}</p></div>`
})
