/* ==========================================================================
   得物整点抢兑助手 · Web 版   前端（零构建，原生 JS）

   界面结构
   --------
     桌面：左侧固定导航 + 顶栏 + 分视图（概览 / 商品 / 任务 / 日志 / 设置）
     手机：顶栏 + 分视图 + 底部标签栏
   只有 #view 会随视图切换重建；数据由 2 秒轮询 paint() 就地刷新，
   这样搜索框、设置表单的输入不会被刷新冲掉。
   ========================================================================== */
const APP = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const S = {
    view: 'overview',
    me: null, cfg: null, global: null, state: null, login: null,
    admin: null, adminTab: 'overview', adminData: {},
    sel: null, timer: null, tickTimer: null, lastPSig: '', lastTSig: '',
    filter: { q: '', stock: 'all', sort: 'default' },
  };

  /* ============================================================ 图标 */
  const P = {
    grid: '<rect x="3.2" y="3.2" width="7.4" height="7.4" rx="1.8"/><rect x="13.4" y="3.2" width="7.4" height="7.4" rx="1.8"/><rect x="3.2" y="13.4" width="7.4" height="7.4" rx="1.8"/><rect x="13.4" y="13.4" width="7.4" height="7.4" rx="1.8"/>',
    bag: '<path d="M5.8 7.2h12.4l1 12.3a1.2 1.2 0 0 1-1.2 1.3H6a1.2 1.2 0 0 1-1.2-1.3z"/><path d="M9 7.2V5.6a3 3 0 0 1 6 0v1.6"/>',
    clock: '<circle cx="12" cy="12" r="8.8"/><path d="M12 7.2V12l3.2 2"/>',
    terminal: '<rect x="3" y="4.2" width="18" height="15.6" rx="2.6"/><path d="M7 9.4l3 2.9-3 2.9"/><path d="M13 15.2h4"/>',
    sliders: '<path d="M4 7.5h9"/><path d="M18.5 7.5h1.5"/><circle cx="15.7" cy="7.5" r="2.2"/><path d="M4 16.5h5"/><path d="M14.5 16.5h5.5"/><circle cx="11.2" cy="16.5" r="2.2"/>',
    coin: '<circle cx="12" cy="12" r="8.8"/><path d="M12 7.2l3.6 4.8L12 16.8l-3.6-4.8z"/>',
    refresh: '<path d="M20.4 12a8.4 8.4 0 1 1-2.6-6.1"/><path d="M20.4 3.8v5.4h-5.4"/>',
    bell: '<path d="M18 9.6a6 6 0 1 0-12 0c0 4.6-1.9 5.7-1.9 5.7h15.8S18 14.2 18 9.6z"/><path d="M10.4 18.9a2 2 0 0 0 3.2 0"/>',
    send: '<path d="M21.4 2.6L10.8 13.2"/><path d="M21.4 2.6l-6.7 18.8-3.9-8.2-8.2-3.9z"/>',
    help: '<circle cx="12" cy="12" r="8.8"/><path d="M9.6 9.5a2.6 2.6 0 0 1 5 .9c0 1.7-2.6 2.1-2.6 3.7"/><path d="M12 17.3h.02"/>',
    pulse: '<path d="M2.6 12h3.9l2.5-6.6L12.6 19l2.6-7h6.2"/>',
    ticket: '<path d="M3 8.7A2.6 2.6 0 0 1 5.6 6.1h12.8A2.6 2.6 0 0 1 21 8.7v1.1a2.3 2.3 0 0 0 0 4.4v1.1a2.6 2.6 0 0 1-2.6 2.6H5.6A2.6 2.6 0 0 1 3 15.3v-1.1a2.3 2.3 0 0 0 0-4.4z"/><path d="M12 8.6v6.8" stroke-dasharray="2 2.6"/>',
    users: '<path d="M15.6 20v-1.6a4 4 0 0 0-4-4H7.4a4 4 0 0 0-4 4V20"/><circle cx="9.5" cy="7.4" r="3.4"/><path d="M21 20v-1.6a4 4 0 0 0-3-3.86"/><path d="M15.6 4.06a4 4 0 0 1 0 7.68"/>',
    shield: '<path d="M12 3.2l7.4 2.9v5.3c0 4.4-2.9 7.9-7.4 9.4-4.5-1.5-7.4-5-7.4-9.4V6.1z"/>',
    logout: '<path d="M15 16.8l4.8-4.8L15 7.2"/><path d="M19.8 12H9.2"/><path d="M12 4.2H6.4a2 2 0 0 0-2 2v11.6a2 2 0 0 0 2 2H12"/>',
    search: '<circle cx="11" cy="11" r="6.6"/><path d="M15.9 15.9l4.6 4.6"/>',
    trash: '<path d="M4 7h16"/><path d="M9.2 7V5.6a1.6 1.6 0 0 1 1.6-1.6h2.4a1.6 1.6 0 0 1 1.6 1.6V7"/><path d="M6.4 7l1 12.4A1.6 1.6 0 0 0 9 21h6a1.6 1.6 0 0 0 1.6-1.6L17.6 7"/>',
    play: '<path d="M7.2 4.6l12 7.4-12 7.4z"/>',
    check: '<path d="M4.6 12.6l4.9 4.9L19.4 6.6"/>',
    alert: '<path d="M12 3.6L21 19.6H3z"/><path d="M12 10v4"/><path d="M12 17h.02"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    zap: '<path d="M13.4 2.6L4.2 14h6.6l-1 7.4L19.6 10h-6.6z"/>',
    right: '<path d="M9 5.2l6.8 6.8L9 18.8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    power: '<path d="M12 3.8v7.4"/><path d="M7.6 6.8a6.6 6.6 0 1 0 8.8 0"/>',
    key: '<circle cx="8.4" cy="15.4" r="3.6"/><path d="M10.9 12.8L20 3.8"/><path d="M17.4 6.4L20 9"/><path d="M15 8.8l2.6 2.6"/>',
    download: '<path d="M12 4v10.8"/><path d="M7.6 10.6L12 15l4.4-4.4"/><path d="M4.6 19.8h14.8"/>',
    info: '<circle cx="12" cy="12" r="8.8"/><path d="M12 11.2v5.4"/><path d="M12 7.8h.02"/>',
    eye: '<path d="M2.6 12S6.2 5.6 12 5.6 21.4 12 21.4 12 17.8 18.4 12 18.4 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="3"/>',
    inbox: '<path d="M3 13.2h4.6l1.4 2.8h6l1.4-2.8H21"/><path d="M5.6 4.8h12.8L21 13.2v4.4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4.4z"/>',
    gift: '<rect x="3.4" y="8.4" width="17.2" height="4" rx="1.2"/><path d="M5 12.4v7.2A1.4 1.4 0 0 0 6.4 21h11.2a1.4 1.4 0 0 0 1.4-1.4v-7.2"/><path d="M12 8.4V21"/><path d="M12 8.4S10.9 3.4 8.6 3.4a2.4 2.4 0 0 0 0 4.9z"/><path d="M12 8.4s1.1-5 3.4-5a2.4 2.4 0 0 1 0 4.9z"/>',
    broom: '<path d="M16.5 3.5l4 4"/><path d="M14.8 5.2l4 4-4.6 4.6-4-4z"/><path d="M10.2 9.8l-6.4 6.4a2 2 0 0 0 0 2.8l1.2 1.2a2 2 0 0 0 2.8 0l6.4-6.4z"/>',
    filter: '<path d="M3.4 5.4h17.2"/><path d="M6.6 12h10.8"/><path d="M10 18.6h4"/>',
    box: '<path d="M20.6 7.6L12 3 3.4 7.6v8.8L12 21l8.6-4.6z"/><path d="M3.4 7.6L12 12.2l8.6-4.6"/><path d="M12 12.2V21"/>',
    user: '<circle cx="12" cy="8" r="3.8"/><path d="M4.8 20.4a7.2 7.2 0 0 1 14.4 0"/>',
  };
  const ic = (n, cls) => `<svg class="i${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || P.info}</svg>`;

  /* ============================================================ 网络 */
  async function api(path, body, method) {
    const init = { credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      init.method = method || 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body || {});
    } else if (method) {
      init.method = method;
    }
    const r = await fetch(path, init);
    let j = null;
    try { j = await r.json(); } catch (e) { /* 可能没有 body */ }
    if (r.status === 401) { const e = new Error((j && j.msg) || '未登录'); e.status = 401; throw e; }
    if (!j) throw new Error('HTTP ' + r.status);
    return j;
  }

  /* ============================================================ 小工具 */
  function toast(msg, kind = '') {
    const box = $('#toast');
    const d = document.createElement('div');
    d.className = 'toast ' + kind;
    d.innerHTML = (kind ? ic(kind === 'ok' ? 'check' : 'alert') : '') + '<span>' + esc(msg) + '</span>';
    box.appendChild(d);
    setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .3s'; }, 2400);
    setTimeout(() => d.remove(), 2800);
  }
  const yuan = (fen) => (fen == null ? '—' : '¥' + (fen / 100).toFixed(2).replace(/\.00$/, ''));
  const IMG_PH = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='%23f2f4f8'/><path d='M28 40h44v32H28z' fill='none' stroke='%23d3d9e2' stroke-width='3'/><path d='M38 40v-6a12 12 0 0 1 24 0v6' fill='none' stroke='%23d3d9e2' stroke-width='3'/></svg>";

  window.addEventListener('error', (e) => {
    // 收集页面错误，截图脚本/排查时读 window.__errs 就能看到
    window.__errs = window.__errs || [];
    window.__errs.push(String(e.message));
    const box = document.getElementById('app');
    if (box && /加载中/.test(box.textContent)) {
      box.innerHTML = '<div class="login-wrap"><div class="login-card">' +
        '<div class="brand"><div class="logo">' + ic('alert') + '</div><div><h1>页面出错了</h1>' +
        '<p>请把下面这行截图给管理员</p></div></div>' +
        '<div class="msg err show">' + esc(e.message) + '</div>' +
        '<button class="btn btn-p btn-block" onclick="location.reload()">重新加载</button>' +
        '</div></div>';
    }
  });

  function closeModal() { $('#modal').innerHTML = ''; }
  function modal(html, wide) {
    $('#modal').innerHTML = '<div class="backdrop" onclick="if(event.target===this)APP.closeModal()">' +
      '<div class="modal' + (wide ? ' wide' : '') + '">' + html + '</div></div>';
  }
  const busy = (btn, on, text) => {
    if (!btn) return;
    btn.disabled = !!on;
    if (on) { btn.dataset.old = btn.innerHTML; btn.textContent = text || '处理中…'; }
    else if (btn.dataset.old) { btn.innerHTML = btn.dataset.old; delete btn.dataset.old; }
  };
  const setMsg = (sel, text, kind) => {
    const m = $(sel); if (!m) return;
    m.className = 'msg show ' + (kind || 'err'); m.textContent = text || '';
  };

  const pad = (n) => String(n).padStart(2, '0');
  function nextTarget(tstr) {
    const p = String(tstr || '10:00:00').split(':').map(Number);
    const now = new Date();
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
      p[0] || 0, p[1] || 0, p[2] || 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return t;
  }
  function fmtLeft(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60);
  }

  /* ============================================================ 登录页 */
  function renderLogin(msg) {
    $('#app').innerHTML = `
    <div class="login-wrap"><div class="login-card">
      <div class="brand">
        <div class="logo">${ic('zap')}</div>
        <div><h1>得物整点抢兑助手</h1>
          <p>Web 版 · 填账号密码即可，<b>现在不用登录</b></p></div>
      </div>
      <div class="msg err ${msg ? 'show' : ''}" id="lgMsg">${esc(msg || '')}</div>
      <label class="fld"><span>得物手机号</span>
        <input id="phone" placeholder="11 位手机号" inputmode="numeric" autocomplete="username"></label>
      <label class="fld"><span>得物账号密码</span>
        <input id="pwd" type="password" placeholder="得物账号密码" autocomplete="current-password">
        <div class="hint" style="line-height:1.7">
          <b>请确保账号密码正确。</b>创建任务后、<b>开抢的前 2 分钟</b>才会进行登录操作 ——
          到那时才提一个短效 IP，用同一个 IP 完成「登录 + 兑换」，一个号只用一个出口。
        </div></label>
      <button class="btn btn-p btn-block" id="lgBtn">${ic('shield')}保存并进入</button>

      <div class="msg ok show" style="background:#f3f9f5;border-color:#d6ebdd;color:#1d7a45;
        font-size:12.5px;line-height:1.7;margin-top:2px">
        ${ic('shield')} 这样做是为了保护你的账号：密码只用于「开抢前自动登录」，
        平时不登录、不占用登录设备，降低账号被盗与被风控的风险。
      </div>

      <details class="adv">
        <summary>想用抓包 token（不存密码）？点这里</summary>
        <textarea id="curl" placeholder="在得物 App 进入「金币兑换」页，抓包复制带 x-auth-token 的那条 curl，粘贴到这里"></textarea>
        <button class="btn btn-s btn-block btn-sm" style="margin-top:8px" id="curlBtn">用这段 curl 登录</button>
        <div class="hint muted" style="margin-top:7px">
          这种方式不经过密码接口，最稳；但它是**即时登录**的，
          不会在开抢前提 IP —— 缺点是要先从手机上抓一次包，token 过期也要重抓。
        </div>
      </details>

      <div class="login-foot">
        <span>数据只存在本服务器，账号之间完全隔离</span>
        <a href="/admin" id="adminLink">管理员入口</a>
      </div>
    </div></div>`;

    const doLogin = async (payload, btn) => {
      const m = $('#lgMsg'); m.className = 'msg err'; m.textContent = '';
      busy(btn, true, '处理中…');
      try {
        const j = await api('/api/login', payload);
        if (!j.ok) { m.className = 'msg err show'; m.textContent = j.msg || '登录失败'; busy(btn, false); return; }
        if (j.lazy) {
          toast('账号密码已保存 · 开抢前 2 分钟才会自动登录', 'ok');
        } else {
          toast('登录成功，正在拉取商品列表…', 'ok');
        }
        await boot();
      } catch (e) {
        m.className = 'msg err show'; m.textContent = e.message || '网络错误';
        busy(btn, false);
      }
    };
    $('#lgBtn').onclick = () => doLogin({ phone: $('#phone').value.trim(), password: $('#pwd').value }, $('#lgBtn'));
    $('#curlBtn').onclick = () => doLogin({ curl: $('#curl').value.trim() }, $('#curlBtn'));
    $('#pwd').onkeydown = (e) => { if (e.key === 'Enter') $('#lgBtn').click(); };
  }

  function renderAdminLogin(msg) {
    $('#app').innerHTML = `
    <div class="login-wrap"><div class="login-card">
      <div class="brand">
        <div class="logo">${ic('shield')}</div>
        <div><h1>管理后台</h1><p>兑换码 · 用户 · 全局设置</p></div>
      </div>
      <div class="msg err ${msg ? 'show' : ''}" id="lgMsg">${esc(msg || '')}</div>
      <label class="fld"><span>管理员账号</span><input id="au" placeholder="用户名" autocomplete="username"></label>
      <label class="fld"><span>密码</span><input id="ap" type="password" autocomplete="current-password"></label>
      <button class="btn btn-p btn-block" id="ab">${ic('shield')}登录后台</button>
      <div class="login-foot"><span></span><a href="/">← 返回用户登录</a></div>
    </div></div>`;
    const go = async () => {
      const m = $('#lgMsg'); m.className = 'msg err'; m.textContent = '';
      busy($('#ab'), true, '登录中…');
      try {
        const j = await api('/api/admin/login', { username: $('#au').value.trim(), password: $('#ap').value });
        if (!j.ok) { m.className = 'msg err show'; m.textContent = j.msg || '登录失败'; busy($('#ab'), false); return; }
        S.admin = j.admin; bootAdmin();
      } catch (e) { m.className = 'msg err show'; m.textContent = e.message; busy($('#ab'), false); }
    };
    $('#ab').onclick = go;
    $('#ap').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }

  /* ============================================================ 视图定义 */
  const VIEWS = {
    overview: { t: '概览', s: '账号状态、下一个任务与快捷操作', n: 'grid' },
    products: { t: '商品列表', s: '点任意商品即可创建定时兑换任务', n: 'bag' },
    tasks:    { t: '我的任务', s: '到点自动抢兑，结果推送到微信', n: 'clock' },
    logs:     { t: '运行日志', s: '本账号的全部操作记录', n: 'terminal' },
    settings: { t: '设置', s: '公告 / 微信推送 / 自动降级 / 任务默认值', n: 'sliders' },
  };
  const NAV = ['overview', 'products', 'tasks', 'logs', 'settings'];

  /* ---------------------------------------------------------- 壳 */
  function renderShell() {
    const navItems = NAV.map((k) => {
      const v = VIEWS[k];
      const bd = k === 'products' ? '<span class="bd" id="bd-products">0</span>'
        : k === 'tasks' ? '<span class="bd" id="bd-tasks">0</span>' : '';
      return `<a class="nav-item" data-nav="${k}" onclick="APP.go('${k}')">${ic(v.n)}
        <span class="lb">${v.t}</span>${bd}</a>`;
    }).join('');

    $('#app').innerHTML = `
    <div class="app">
      <aside class="side">
        <div class="brand">
          <div class="logo">${ic('zap')}</div>
          <div><h1>抢兑助手</h1><p>DEWU WEB</p></div>
        </div>
        <nav class="nav">
          <div class="nav-h">工作台</div>
          ${navItems}
          <div class="nav-h">系统</div>
          <a class="nav-item" href="/admin">${ic('shield')}<span class="lb">管理后台</span></a>
        </nav>
        <div class="side-foot">
          <div class="whoami">
            <div class="av" id="sideAv">--</div>
            <div class="t"><b id="sidePhone">—</b><span id="sideSub">—</span></div>
            <button class="icon-btn" title="退出登录" onclick="APP.logout()">${ic('logout')}</button>
          </div>
        </div>
      </aside>

      <div class="main">
        <header class="head"><div class="head-in">
          <div class="ttl"><h2 id="headT">概览</h2><p id="headS"></p></div>
          <div class="acts">
            <span class="pill coin" id="pillCoin" title="当前金币余额">${ic('coin')}<b>—</b></span>
            <span class="pill off hide-sm" id="pillIp" title="抢兑时自动登录用的出口 IP 归属地">
              ${ic('pulse')}<span id="ipTx">未登录</span></span>
            <span class="pill hide-sm" id="pillClock" title="本机时间">
              ${ic('clock')}<span id="clock">--:--:--</span></span>
            <button class="btn btn-s btn-sm hide-sm" onclick="APP.refreshList(this)" title="重新拉取商品列表">
              ${ic('refresh')}刷新</button>
          </div>
        </div></header>
        <div class="view" id="view"></div>
      </div>

      <nav class="tabbar">
        ${NAV.map((k) => `<button data-tab="${k}" onclick="APP.go('${k}')">${ic(VIEWS[k].n)}
          <span>${VIEWS[k].t}</span>${
            k === 'products' ? '<span class="bd" id="tbd-products">0</span>'
              : k === 'tasks' ? '<span class="bd" id="tbd-tasks">0</span>' : ''}</button>`).join('')}
      </nav>
    </div>`;
    tick();
    // 每秒走一次钟 + 倒数（boot 可能被调多次，所以定时器要自己管好）
    if (S.tickTimer) clearInterval(S.tickTimer);
    S.tickTimer = setInterval(tick, 1000);
  }

  /* ---------------------------------------------------------- 路由 */
  function go(v) {
    if (!VIEWS[v]) v = 'overview';
    S.view = v;
    $$('.nav-item').forEach((a) => a.classList.toggle('on', a.dataset.nav === v));
    $$('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === v));
    const V = VIEWS[v];
    $('#headT').innerHTML = ic(V.n) + V.t;
    $('#headS').textContent = V.s;
    $('#view').innerHTML = VIEWS_HTML[v]();
    BIND[v] && BIND[v]();
    paint(true);
    window.scrollTo({ top: 0 });
  }

  /* ============================================================ 概览 */
  const VIEWS_HTML = {};
  const BIND = {};

  VIEWS_HTML.overview = () => `
    <div class="hero">
      <div>
        <div class="lbl">${ic('coin')}金币余额</div>
        <div class="big" id="ovBal">—<em>金币</em></div>
        <div class="tip" id="ovBalTip">拉取商品列表时同步更新</div>
      </div>
      <div class="div"></div>
      <div class="mini">
        <div class="m"><div class="n" id="ovM1">0</div><div class="t">商品总数</div></div>
        <div class="m"><div class="n g" id="ovM2">0</div><div class="t">当前有货</div></div>
        <div class="m"><div class="n r" id="ovM3">0</div><div class="t">进行中任务</div></div>
      </div>
      <div class="sp"></div>
      <button class="btn btn-p" onclick="APP.refreshList(this)">${ic('refresh')}刷新商品列表</button>
    </div>

    <div class="workflow" aria-label="任务执行流程">
      <div><span>01</span><b>保存账号</b><small>仅加密保存，不立即登录</small></div>
      <div><span>02</span><b>选商品 · 填授权码</b><small>创建任务后可关闭网页</small></div>
      <div><span>03</span><b>提前两分钟准备</b><small>提取 3 分钟代理并登录</small></div>
      <div><span>04</span><b>整点兑换 · 成功推送</b><small>同一代理，本轮最多 50 秒</small></div>
    </div>
    <div class="msg warn show" id="setupHint" hidden></div>
    <div class="stats" id="ovStats"></div>

    <div class="card">
      <div class="card-h"><h3>${ic('clock')}下一个任务</h3><div class="sp"></div>
        <button class="btn btn-s btn-sm" onclick="APP.go('products')">${ic('plus')}新建任务</button></div>
      <div class="card-b" id="ovNext"></div>
    </div>

    <div class="card">
      <div class="card-h"><h3>${ic('zap')}快捷操作</h3><div class="sp"></div>
        <span class="sub">活动 id <span class="mono" id="ovAct">—</span></span></div>
      <div class="card-b">
        <div class="tiles" id="ovTiles"></div>
        <div class="msg err" id="listErr"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-h"><h3>${ic('pulse')}最近事件</h3><div class="sp"></div>
        <button class="btn btn-s btn-sm" onclick="APP.go('logs')">查看全部</button></div>
      <div class="card-b tight"><div class="events" id="ovEvents"></div></div>
    </div>`;

  function paintOverview() {
    const st = S.state || {};
    const ps = st.products || [];
    const ts = st.tasks || [];
    // ★ 用户设置只有 S.cfg 一份（/api/me 的顶层 settings），不是 S.me.settings
    const push = (S.cfg || {}).push || {};
    const bal = st.balance;
    const hint = $('#setupHint');
    const missing = [];
    if (S.login?.lazy && !S.global?.public_list) missing.push('公共商品账号尚未配置，请联系管理员');
    if (S.login?.lazy && !S.global?.auto_ip) missing.push('自动代理尚未配置，暂时不能创建密码模式任务');
    hint.hidden = !missing.length;
    hint.textContent = missing.join('；');

    $('#ovBal').innerHTML = (bal == null ? '—' : esc(bal)) + '<em>金币</em>';
    const at = st.list_at || st.refreshed_at;
    const lg0 = S.login || {};
    $('#ovBalTip').textContent = [
      at ? ('列表更新于 ' + at) : '还没有拉到列表，点右边按钮刷新',
      st.list_source === 'public' ? '由管理员统一提供' : '',
      (bal == null && lg0.lazy)
        ? ('抢前 ' + Math.round((((S.global || {}).lead_login_sec) || 120) / 60) + ' 分钟自动登录后才有余额')
        : '',
    ].filter(Boolean).join(' · ');
    $('#ovM1').textContent = ps.length;
    $('#ovM2').textContent = ps.filter((p) => !p.outOfStock).length;
    const running = ts.filter((t) => ['等待', '兑换中'].includes(t.status)).length;
    const m3 = $('#ovM3');
    m3.textContent = running;
    m3.className = 'n' + (running ? ' r' : '');     // 0 就别标红了
    $('#ovAct').textContent = (S.me && S.me.activity) || '—';

    const ok = ts.filter((t) => t.status === '成功').length;
    const bad = ts.filter((t) => t.status === '失败').length;
    $('#ovStats').innerHTML = [
      { i: 'inbox', c: 'blue', n: ts.length, l: '全部任务' },
      { i: 'check', c: ok ? 'green' : '', n: ok, l: '抢兑成功' },
      { i: 'zap', c: running ? 'red' : '', n: running, l: '进行中' },
      { i: 'alert', c: bad ? 'red' : '', n: bad, l: '抢兑失败' },
      { i: 'send', c: push.enabled ? 'green' : '', n: push.enabled ? '开' : '关',
        l: '微信推送' },
    ].map((s) => `<div class="stat"><div class="si ${s.c}">${ic(s.i, 'i-l')}</div>
      <div class="b"><div class="n">${esc(s.n)}</div><div class="l">${esc(s.l)}</div></div></div>`).join('');

    // 下一个任务
    const live = ts.filter((t) => ['等待', '兑换中'].includes(t.status))
      .sort((a, b) => nextTarget(a.time) - nextTarget(b.time));
    const t = live[0];
    if (!t) {
      $('#ovNext').innerHTML = `<div class="empty" style="padding:34px 12px">
        <div class="ico">${ic('inbox')}</div>
        <b>没有等待中的任务</b>去商品列表点一件商品，就能创建定时兑换任务
        <div style="margin-top:14px"><button class="btn btn-p btn-sm" onclick="APP.go('products')">
          ${ic('bag')}去挑商品</button></div></div>`;
    } else {
      $('#ovNext').innerHTML = `<div class="next">
        <img class="im" src="${esc(t.picture || IMG_PH)}" onerror="this.src='${IMG_PH}'" alt="">
        <div class="info">
          <h4>${esc(t.cName)}</h4>
          <div class="metas">
            <span>${ic('ticket')} #${t.id}</span>
            <span>金币 <b>${t.cost == null ? '—' : esc(t.cost)}</b></span>
            <span>${yuan(t.price)}</span>
            <span class="tag ${tagCls(t.status)}">${esc(t.status)}</span>
            ${t.repeat_daily ? '<span class="tag wait">每天</span>' : ''}
            ${t.fallback ? '<span class="tag warn">自动降级</span>' : ''}
          </div>
        </div>
        <div class="cd">
          <div class="t" data-cd="${esc(t.time)}">--:--:--</div>
          <div class="k">距离开始抢兑</div>
          <div class="at">目标 ${esc(t.time)}</div>
        </div>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn btn-p btn-sm" onclick="APP.runNow(${t.id})">${ic('play')}立即执行一次</button>
        <button class="btn btn-s btn-sm" onclick="APP.go('tasks')">${ic('clock')}全部任务</button>
      </div>`;
    }

    // 快捷磁贴
    $('#ovTiles').innerHTML = [
      { i: 'refresh', n: '刷新商品', s: '重新拉列表', fn: 'APP.refreshList(this)' },
      { i: 'send', n: '微信推送', s: push.enabled ? '已开启' : '未开启', on: !!push.enabled, fn: "APP.sec('push')" },
      { i: 'bell', n: '加群 · 库存提醒', s: '扫码加入组织', fn: "APP.sec('notice')" },
      { i: 'pulse', n: '链路诊断', s: '不扣金币', fn: 'APP.probe(this)' },
      { i: 'sliders', n: '全部设置', s: '兜底/默认值', fn: "APP.go('settings')" },
    ].filter((t) => !(lg0.lazy && t.i === 'pulse')).map((t) => `<div class="tile ${t.on ? 'on' : ''}" onclick="${t.fn}">
      <div class="ti">${ic(t.i)}</div><div class="tn">${t.n}</div><div class="ts">${t.s}</div></div>`).join('');

    // 最近事件
    const logs = (st.logs || []).slice(0, 8);
    $('#ovEvents').innerHTML = logs.length ? logs.map((l) => `<div class="ev ${esc(l.level || 'info')}">
      <span class="d"></span><span class="tx">${esc(l.line || l.msg)}</span></div>`).join('')
      : '<div class="empty" style="padding:28px 12px">还没有日志</div>';
  }

  /* ============================================================ 商品 */
  VIEWS_HTML.products = () => `
    <div class="card">
      <div class="card-h">
        <h3>${ic('bag')}全部商品 <span class="num" id="pCount">0</span></h3>
        <div class="sp"></div>
        <span class="sub" id="pSum"></span>
      </div>
      <div class="card-b">
        <div class="filterbar">
          <input class="grow" id="fq" placeholder="搜索商品名…">
          <div class="seg" id="fseg">
            <button data-stock="all">全部</button>
            <button data-stock="in">有货</button>
            <button data-stock="out">缺货</button>
          </div>
          <select id="fsort" style="width:auto">
            <option value="default">默认排序</option>
            <option value="coinAsc">金币 少 → 多</option>
            <option value="coinDesc">金币 多 → 少</option>
            <option value="priceDesc">价格 高 → 低</option>
          </select>
        </div>
        <div class="pgrid" id="pgrid"></div>
      </div>
    </div>`;

  BIND.products = function () {
    const q = $('#fq');
    q.value = S.filter.q;
    let t = null;
    q.oninput = () => {
      S.filter.q = q.value.trim();
      clearTimeout(t);
      t = setTimeout(() => { S.lastPSig = ''; paintProducts(); }, 180);
    };
    const seg = $('#fseg');
    $$('button', seg).forEach((b) => {
      b.classList.toggle('on', b.dataset.stock === S.filter.stock);
      b.onclick = () => {
        S.filter.stock = b.dataset.stock;
        $$('button', seg).forEach((x) => x.classList.toggle('on', x === b));
        S.lastPSig = ''; paintProducts();
      };
    });
    const so = $('#fsort');
    so.value = S.filter.sort;
    so.onchange = () => { S.filter.sort = so.value; S.lastPSig = ''; paintProducts(); };
  };

  function filteredProducts() {
    const all = (S.state || {}).products || [];
    let list = all.slice();
    const f = S.filter;
    if (f.q) {
      const k = f.q.toLowerCase();
      list = list.filter((p) => (p.cName || '').toLowerCase().includes(k)
        || (p.subName || '').toLowerCase().includes(k));
    }
    if (f.stock === 'in') list = list.filter((p) => !p.outOfStock);
    if (f.stock === 'out') list = list.filter((p) => p.outOfStock);
    if (f.sort === 'coinAsc') list.sort((a, b) => (a.cost || 0) - (b.cost || 0));
    if (f.sort === 'coinDesc') list.sort((a, b) => (b.cost || 0) - (a.cost || 0));
    if (f.sort === 'priceDesc') list.sort((a, b) => (b.price || 0) - (a.price || 0));
    return { list, total: all.length };
  }

  function paintProducts() {
    const st = S.state || {};
    const grid = $('#pgrid');
    if (!grid) return;
    const sig = [st.refreshed_at, st.products.length, S.filter.q, S.filter.stock, S.filter.sort].join('|');
    if (sig === S.lastPSig) return;
    S.lastPSig = sig;

    const { list, total } = filteredProducts();
    $('#pCount').textContent = total;
    const srcTag = st.list_source === 'public' ? ' · 管理员统一提供' : '';
    $('#pSum').textContent = (list.length === total
      ? '点任意商品即可创建定时兑换任务'
      : '筛选出 ' + list.length + ' / ' + total + ' 个') + srcTag;
    const le = $('#listErr');
    if (le) { le.className = 'msg err' + (st.list_error ? ' show' : ''); le.textContent = st.list_error || ''; }

    if (!total) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="ico">${ic('bag')}</div>
        <b>还没有商品数据</b>点右上角「刷新商品列表」拉一次</div>`;
      return;
    }
    if (!list.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="ico">${ic('search')}</div>
        <b>没有符合条件的商品</b>换个关键词或筛选条件试试</div>`;
      return;
    }
    grid.innerHTML = list.map((p) => {
      const oos = p.outOfStock;
      const low = !oos && Number(p.stock) > 0 && Number(p.stock) <= 10;
      return `<div class="pcard ${oos ? 'oos' : ''} ${S.sel === p.cId ? 'sel' : ''}"
                   onclick="APP.pick(${p.cId})" title="${esc(p.cName)}">
        <div class="thumb">
          <img loading="lazy" src="${esc(p.picture || IMG_PH)}" alt="" onerror="this.src='${IMG_PH}'">
          ${p.label ? `<span class="lbl">${esc(p.label)}</span>` : ''}
          ${oos ? '<div class="oos-mask">已售罄</div>' : ''}
        </div>
        <div class="body">
          <div class="name" title="${esc(p.cName)}">${esc(p.cName)}</div>
          <div class="row2">
            <span class="price">${yuan(p.price)}</span>
            <span class="coin">${ic('coin')}${p.cost == null ? '—' : esc(p.cost)}</span>
          </div>
          <div class="stock ${oos ? 'no' : low ? 'low' : ''}">${ic('box')}
            库存 ${p.stock == null ? '—' : esc(p.stock)}${p.typeDesc ? ' · ' + esc(p.typeDesc) : ''}
          </div>
        </div>
      </div>`;
    }).join('');
  }

  /* ============================================================ 任务 */
  VIEWS_HTML.tasks = () => `
    <div class="card">
      <div class="card-h">
        <h3>${ic('clock')}我的任务 <span class="num" id="tCount">0</span></h3>
        <div class="sp"></div>
        <button class="btn btn-s btn-sm" onclick="APP.clearDone()">${ic('broom')}清理已结束</button>
      </div>
      <div class="card-b"><div class="tlist" id="tasks"></div></div>
    </div>`;

  const tagCls = (s) => ({ '成功': 'ok', '失败': 'bad', '等待': 'wait',
    '兑换中': 'run', '已取消': 'wait' }[s] || 'wait');
  const taskCls = (s) => ({ '成功': 'win', '失败': 'lose', '兑换中': 'live' }[s] || '');

  function paintTasks() {
    const ts = (S.state || {}).tasks || [];
    const box = $('#tasks');
    if (!box) return;
    $('#tCount').textContent = ts.length;
    const sig = JSON.stringify(ts.map((t) => [t.id, t.status, t.attempts, t.detail]));
    if (sig === S.lastTSig) return;
    S.lastTSig = sig;

    if (!ts.length) {
      box.innerHTML = `<div class="empty"><div class="ico">${ic('inbox')}</div>
        <b>还没有任务</b>去商品列表点任意商品，就能创建定时兑换任务
        <div style="margin-top:14px"><button class="btn btn-p btn-sm" onclick="APP.go('products')">
          ${ic('bag')}去挑商品</button></div></div>`;
      return;
    }
    box.innerHTML = ts.map((t) => {
      const done = ['成功', '失败', '已取消'].includes(t.status);
      return `<div class="task ${taskCls(t.status)}">
      <div class="t-top">
        <img class="t-img" src="${esc(t.picture || IMG_PH)}" onerror="this.src='${IMG_PH}'" alt="">
        <div class="t-main">
          <div class="t-name" title="${esc(t.cName)}">${esc(t.cName)}</div>
          <div class="t-sub">
            <span class="id">#${t.id}</span>
            <span>金币 <b>${t.cost == null ? '—' : esc(t.cost)}</b></span>
            <span>${yuan(t.price)}</span>
            ${t.repeat_daily ? '<span>每天重复</span>' : ''}
            ${t.fallback ? '<span>自动降级</span>' : ''}
            ${t.created ? '<span>建于 ' + esc(t.created) + '</span>' : ''}
          </div>
        </div>
        <div class="t-acts">
          <button class="btn btn-s btn-sm" onclick="APP.runNow(${t.id})">${ic('play')}立即执行</button>
          <button class="btn btn-danger btn-sm" onclick="APP.delTask(${t.id})">${ic('trash')}删除</button>
        </div>
      </div>
      <div class="t-bar">
        <span class="tag ${tagCls(t.status)}">${esc(t.status)}</span>
        ${t.attempts ? `<span class="k">已尝试 <b>${t.attempts}</b> 次</span>` : ''}
        <span class="k">目标时间</span><span class="v mono">${esc(t.time)}</span>
        ${done ? '' : `<span class="k">倒计时</span><span class="t-cd" data-cd="${esc(t.time)}">--:--:--</span>`}
        ${t.last_run ? `<span class="k">上次执行</span><span class="v mono">${esc(t.last_run)}</span>` : ''}
        ${t.finished ? `<span class="k">结束于</span><span class="v mono">${esc(t.finished)}</span>` : ''}
        ${t.detail ? `<span class="t-note">${esc(t.detail)}</span>` : ''}
      </div>
    </div>`;
    }).join('');
  }

  /* ============================================================ 日志 */
  VIEWS_HTML.logs = () => `
    <div class="term">
      <div class="term-bar">
        <span class="dot d1"></span><span class="dot d2"></span><span class="dot d3"></span>
        <span class="t">dewu-web · 运行日志（最新在最上）</span>
        <div class="sp"></div>
        <button class="btn btn-sm" onclick="APP.clearLogView()">${ic('broom')}清屏</button>
      </div>
      <div id="log"></div>
    </div>`;

  function paintLogs() {
    const box = $('#log');
    if (!box) return;
    const atTop = box.scrollTop < 40;
    const lines = (S.state || {}).logs || [];
    box.innerHTML = lines.map((l) => `<div class="ln l-${esc(l.level || 'info')}">${esc(l.line || l.msg)}</div>`).join('')
      || '<div class="ln l-info">还没有日志</div>';
    if (atTop) box.scrollTop = 0;
  }

  /* ============================================================ 设置 */
  /* ★ 用户设置只有一份：boot() 里放的 S.cfg（= /api/me 顶层的 settings）。
     /api/me 的结构是 {user, settings, proxy, global} —— settings 是 user 的**兄弟**，
     不在 user 里面。早先这里写成 S.me.settings，等于永远取到空对象：
     设置页所有输入框都会显示默认值，而且点「保存」会把用户的真实配置覆盖成默认值。 */
  const SEC = (k, id) => (S.cfg || {})[k] || {};

  VIEWS_HTML.settings = () => `
    <div class="set-grid">
      <div class="card" id="sec-notice" style="margin:0">
        <div class="sec-t"><span class="si">${ic('bell')}</span>公告 · 库存实时监听
          <span class="sp"></span><span class="state on">服务端在跑</span></div>
        <div class="card-b">
          <div class="desc" style="font-size:12.5px;color:var(--ink3);margin-bottom:14px;line-height:1.7">
            库存实时监听由<b>服务端统一监控</b>（走公共账号拉商品，<b>不占用你的账号</b>），
            有新上架 / 补货就会推给你。Web 端不再单独跑监听，你的账号只在抢兑前 2 分钟被用到。
            想第一时间收到提醒，<b>扫码加入组织群</b>。</div>
          <div style="text-align:center">
            <img src="/qr_group.png" alt="扫码加入组织群" loading="lazy"
              style="width:210px;height:210px;border-radius:12px;border:1px solid var(--line);background:#fff;padding:6px">
            <div class="muted" style="margin-top:10px;font-size:12px">
              微信扫码加入组织群 · 库存变化第一时间推送</div>
          </div>
        </div>
      </div>

      <div class="card" id="sec-push" style="margin:0">
        <div class="sec-t"><span class="si">${ic('send')}</span>微信推送
          <span class="sp"></span><span class="state off" id="stPush">未开启</span></div>
        <div class="card-b">
          <div class="desc" style="font-size:12.5px;color:var(--ink3);margin-bottom:14px;line-height:1.65">
            抢兑结果、库存变化推到微信。没填 token 就只能在本页看结果。先去
            <a href="https://www.pushplus.plus/" target="_blank" rel="noopener">PushPlus 官网（pushplus.plus）</a>
            用微信扫码登录，复制 token 填到下面。</div>
          <label class="chk"><input type="checkbox" id="pEn"> 开启推送</label>
          <label class="fld"><span>PushPlus token</span>
            <input id="pToken" placeholder="32 位 token"></label>
          <label class="chk"><input type="checkbox" id="pFail"> 抢兑失败也推送</label>
          <div class="sect" style="border-top:1px solid var(--line);margin-top:14px;padding-top:14px">
            <div class="muted" style="font-weight:600;color:var(--ink2);margin-bottom:10px">群发到群组（只发库存变化）</div>
            <label class="fld"><span>群组编码 topic</span>
              <input id="pTopic" placeholder="留空 = 只私发给你自己"></label>
            <label class="chk"><input type="checkbox" id="pGs"> 库存变化也群发到群组</label>
            <label class="chk"><input type="checkbox" id="pGst"> 群发之外，再私发我一份</label>
            <div class="muted" style="font-size:11.5px">抢兑成功 / 失败<b>永远不会</b>发到群里（卡片里带账号信息）。</div>
          </div>
          <div class="msg" id="pMsg"></div>
          <div class="row" style="margin-top:14px">
            <button class="btn btn-p btn-sm" onclick="APP.savePush(this)">${ic('check')}保存</button>
            <button class="btn btn-s btn-sm" onclick="APP.testPush(this)">${ic('send')}发送测试</button>
          </div>
        </div>
      </div>

      <div class="card" id="sec-fallback" style="margin:0">
        <div class="sec-t"><span class="si">${ic('shield')}</span>自动降级兜底
          <span class="sp"></span><span class="state off" id="stFb">—</span></div>
        <div class="card-b">
          <div class="desc" style="font-size:12.5px;color:var(--ink3);margin-bottom:14px;line-height:1.65">
            抢不到原商品时，自动换一个<b>买得起且有货</b>的商品去抢，免得空手而归。</div>
          <label class="chk"><input type="checkbox" id="fEn"> 开启自动降级（可被单个任务覆盖）</label>
          <label class="chk"><input type="checkbox" id="fGone"> 原商品下架时降级</label>
          <label class="chk"><input type="checkbox" id="fSold"> 原商品售罄时降级</label>
          <label class="chk"><input type="checkbox" id="fPoor"> 金币不够时也降级（可能换到更差的）</label>
          <label class="fld" style="margin-top:6px"><span>价格不低于原价的百分比（0 = 不限）</span>
            <input id="fMin" type="number" min="0" max="100" placeholder="0"></label>
          <div class="msg" id="fMsg"></div>
          <button class="btn btn-p btn-sm" style="margin-top:14px" onclick="APP.saveFallback(this)">
            ${ic('check')}保存</button>
        </div>
      </div>

      <div class="card" id="sec-task" style="margin:0">
        <div class="sec-t"><span class="si">${ic('clock')}</span>任务默认值</div>
        <div class="card-b">
          <div class="desc" style="font-size:12.5px;color:var(--ink3);margin-bottom:14px;line-height:1.65">
            创建任务时表单的默认值，改完只影响以后新建的任务。</div>
          <label class="fld"><span>目标时间</span><input id="dTime" placeholder="10:00:00"></label>
          <div class="grid2">
            <label class="fld"><span>提前起抢 (ms)</span><input id="dLead" type="number" placeholder="300"></label>
            <label class="fld"><span>每次间隔 (ms)</span><input id="dInt" type="number" placeholder="200"></label>
          </div>
          <label class="fld"><span>最多尝试次数</span><input id="dMax" type="number" placeholder="600"></label>
          <div class="msg" id="dMsg"></div>
          <button class="btn btn-p btn-sm" style="margin-top:14px" onclick="APP.saveDefaults(this)">
            ${ic('check')}保存</button>
        </div>
      </div>

      <div class="card" style="margin:0">
        <div class="sec-t"><span class="si">${ic('key')}</span>账号</div>
        <div class="card-b">
          <div class="kv"><span class="k">手机号</span><span class="v mono" id="acPhone">—</span></div>
          <div class="kv"><span class="k">得物用户 id</span><span class="v mono" id="acUid">—</span></div>
          <div class="kv"><span class="k">当前活动 id</span><span class="v mono" id="acAct">—</span></div>
          <div class="kv"><span class="k">注册时间</span><span class="v mono" id="acCreated">—</span></div>
          <div class="row" style="margin-top:14px">
            <button class="btn btn-s btn-sm" onclick="APP.probe(this)">${ic('pulse')}链路诊断</button>
            <button class="btn btn-danger btn-sm" onclick="APP.logout()">${ic('logout')}退出登录</button>
          </div>
        </div>
      </div>
    </div>`;

  BIND.settings = function () {
    const p = SEC('push'), f = SEC('fallback'), d = SEC('task_defaults');
    const ck = (id, v) => { const e = $(id); if (e) e.checked = v !== false && !!v; };
    const val = (id, v) => { const e = $(id); if (e) e.value = v == null ? '' : v; };
    ck('#pEn', p.enabled); val('#pToken', p.token); ck('#pFail', p.on_fail);
    val('#pTopic', p.topic); ck('#pGs', p.group_stock); ck('#pGst', p.group_self_too);

    ck('#fEn', f.enabled); ck('#fGone', f.on_gone); ck('#fSold', f.on_soldout);
    ck('#fPoor', f.on_poor); val('#fMin', Math.round((f.min_ratio || 0) * 100));

    val('#dTime', d.time || '10:00:00'); val('#dLead', d.lead_ms);
    val('#dInt', d.interval_ms); val('#dMax', d.max_attempts);

    // 账号卡里的这几项是 <span>，要用 textContent（用 val() 写 value 是写不进去的）
    const txt = (id, v) => { const e = $(id); if (e) e.textContent = (v == null || v === '') ? '—' : v; };
    txt('#acPhone', (S.me || {}).phone); txt('#acUid', (S.me || {}).dewu_user_id);
    txt('#acAct', (S.me || {}).activity); txt('#acCreated', (S.me || {}).created_at);

    paintSettings();
  };

  function paintSettings() {
    const e1 = $('#stPush');
    if (e1) {
      const en = !!SEC('push').enabled;
      e1.className = 'state ' + (en ? 'on' : 'off');
      e1.textContent = en ? '已开启' : '未开启';
    }
    const e3 = $('#stFb');
    if (e3) {
      const en = SEC('fallback').enabled !== false;
      e3.className = 'state ' + (en ? 'on' : 'off');
      e3.textContent = en ? '已开启' : '已关闭';
    }
  }

  /* ============================================================ 用户动作 */
  async function refreshState() {
    try {
      const st = await api('/api/state');
      S.state = st;
      paint();
    } catch (e) {
      if (e.status === 401) { stopPoll(); renderLogin('登录已过期，请重新登录'); }
    }
  }
  function startPoll() { stopPoll(); S.timer = setInterval(refreshState, 2000); }
  function stopPoll() { if (S.timer) clearInterval(S.timer); S.timer = null; }

  function paintHead() {
    const st = S.state || {};
    const coin = $('#pillCoin b');
    if (coin) coin.textContent = st.balance == null ? '—' : st.balance;
    const nP = (st.products || []).length;
    const nT = (st.tasks || []).filter((t) => ['等待', '兑换中'].includes(t.status)).length;
    ['bd-products', 'tbd-products'].forEach((id) => {
      const e = document.getElementById(id); if (e) { e.textContent = nP; e.style.display = nP ? '' : 'none'; }
    });
    ['bd-tasks', 'tbd-tasks'].forEach((id) => {
      const e = document.getElementById(id); if (e) { e.textContent = nT; e.style.display = nT ? '' : 'none'; }
    });
    if (S.me) {
      const ph = S.me.phone || '—';
      const av = $('#sideAv'); if (av) av.textContent = String(ph).slice(0, 2);
      const sp = $('#sidePhone'); if (sp) sp.textContent = ph;
      const ss = $('#sideSub');
      if (ss) {
        const lg = S.login || {};
        if (lg.where) ss.textContent = '出口 ' + lg.where;
        else if (lg.lazy) ss.textContent = '未登录 · 抢前自动登录';
        else ss.textContent = '活动 ' + (S.me.activity || '—');
      }
    }
    // 抢兑自动登录用的出口 IP 归属地（登录前显示「抢前 N 分钟自动登录」）
    const pip = $('#pillIp');
    if (pip && S.me) {
      const lg = S.login || {};
      const gg = S.global || {};
      const mins = Math.round((gg.lead_login_sec || 120) / 60);
      if (lg.where) {
        pip.className = 'pill live hide-sm';
        $('#ipTx').textContent = lg.where + (lg.at ? ' · ' + lg.at : '');
        pip.title = '登录出口 IP ' + (lg.ip || '—') + '（' + lg.where + '）'
          + (gg.auto_ip ? ' · 开抢前自动提 IP' : ' · 直连登录（天启IP 未配置）');
      } else if (lg.lazy) {
        pip.className = 'pill off hide-sm';
        $('#ipTx').textContent = '抢前 ' + mins + ' 分钟自动登录';
        pip.title = '还没登录（按设计）。创建任务后，开抢前 ' + mins + ' 分钟会自动提 IP 登录';
      } else if (lg.logged_in) {
        pip.className = 'pill hide-sm';
        $('#ipTx').textContent = '抓包 token 模式';
        pip.title = '用抓包 token 登录，不会自动提 IP';
      } else {
        pip.className = 'pill err hide-sm';
        $('#ipTx').textContent = '无登录凭据';
        pip.title = '还没有可用的登录凭据，请重新提交账号密码';
      }
    }
  }

  function paint(force) {
    paintHead();
    if (S.view === 'overview') paintOverview();
    else if (S.view === 'products') { if (force) S.lastPSig = ''; paintProducts(); }
    else if (S.view === 'tasks') { if (force) S.lastTSig = ''; paintTasks(); }
    else if (S.view === 'logs') paintLogs();
    else if (S.view === 'settings') paintSettings();
  }

  function tick() {
    const d = new Date();
    const c = $('#clock');
    if (c) c.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    $$('[data-cd]').forEach((el) => {
      const left = nextTarget(el.dataset.cd) - d;
      el.textContent = fmtLeft(left);
      el.classList.toggle('soon', left > 0 && left < 60000);
    });
  }

  async function refreshList(btn) {
    busy(btn, true, '刷新中…');
    try {
      const j = await api('/api/products/refresh', {});
      toast(j.msg, j.ok ? 'ok' : 'err');
      S.lastPSig = ''; await refreshState();
    } catch (e) { toast(e.message, 'err'); }
    busy(btn, false);
  }

  async function probe(btn) {
    busy(btn, true, '诊断中…');
    try { const j = await api('/api/probe', {}); toast(j.msg, j.ok ? 'ok' : 'err'); }
    catch (e) { toast(e.message, 'err'); }
    busy(btn, false);
  }

  async function clearDone() {
    await api('/api/tasks/clear_done', {});
    toast('已清理结束的任务', 'ok'); S.lastTSig = ''; refreshState();
  }
  async function delTask(id) {
    if (!confirm('确定删除任务 #' + id + '？')) return;
    await api(`/api/tasks/${id}/delete`, {});
    toast('已删除', 'ok'); S.lastTSig = ''; refreshState();
  }
  async function runNow(id) {
    const j = await api(`/api/tasks/${id}/run_now`, {});
    toast(j.msg || '已开始', j.ok ? 'ok' : 'err'); S.lastTSig = ''; refreshState();
  }
  function clearLogView() { const b = $('#log'); if (b) b.innerHTML = '<div class="ln l-info">已清屏</div>'; }

  function pick(cId) {
    const p = (S.state.products || []).find((x) => x.cId === cId);
    if (!p) return;
    S.sel = cId; S.lastPSig = ''; paintProducts();
    taskModal(p);
  }

  /* 跳到设置页并高亮某一段 */
  function sec(name) {
    if (S.view !== 'settings') go('settings');
    const el = $('#sec-' + name);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ============================================================ 弹窗：创建任务 */
  function taskModal(p) {
    const g = S.global || {};
    const fd = SEC('task_defaults');
    const fbDefault = SEC('fallback').enabled !== false;
    modal(`
      <h3>${ic('plus')}创建定时兑换任务</h3>
      <div class="desc">到点自动抢兑。默认整点开始；提前两分钟登录，同一代理最多兑换 50 秒。</div>
      <div class="preview">
        <img src="${esc(p.picture || IMG_PH)}" onerror="this.src='${IMG_PH}'" alt="">
        <div class="info">
          <b>${esc(p.cName)}</b>
          <div class="meta">
            <span class="p">${yuan(p.price)}</span>
            <span>需要 <b>${esc(p.cost)}</b> 金币</span>
            <span>库存 <b>${p.stock == null ? '—' : esc(p.stock)}</b></span>
            ${p.outOfStock ? '<span style="color:#e6243f">当前已售罄</span>' : ''}
          </div>
        </div>
      </div>
      ${g.require_code ? `<label class="fld"><span>兑换码（必填 · 一个码只能创建一个任务）</span>
        <input id="tCode" placeholder="例如 DW-XXXX-XXXX" style="text-transform:uppercase"
          autocomplete="off"></label>` : ''}
      <div class="grid2">
        <label class="fld"><span>目标时间</span>
          <input id="tTime" value="${esc(fd.time || '10:00:00')}" placeholder="10:00:00"></label>
        <label class="fld"><span>提前起抢 (ms)</span>
          <input id="tLead" type="number" value="${esc(fd.lead_ms ?? 0)}"></label>
      </div>
      <div class="grid2">
        <label class="fld"><span>每次间隔 (ms)</span>
          <input id="tInt" type="number" value="${esc(fd.interval_ms || 200)}"></label>
        <label class="fld"><span>最多尝试次数</span>
          <input id="tMax" type="number" value="${esc(fd.max_attempts || 600)}"></label>
      </div>
      <label class="chk"><input type="checkbox" id="tRep"> 每天重复（本轮结束后第二天继续）</label>
      <label class="chk"><input type="checkbox" id="tFb" ${fbDefault ? 'checked' : ''}>
        自动降级兜底（原商品下架 / 抢不到时，自动换一个买得起的有货商品）</label>
      <label class="chk"><input type="checkbox" id="tNow"> 创建后立即执行（会真实登录、兑换并消耗代理额度）</label>
      <div class="msg err" id="tMsg"></div>
      <div class="foot">
        <span class="muted">金币余额 ${S.state && S.state.balance != null ? esc(S.state.balance) : '—'}</span>
        <span class="sp"></span>
        <button class="btn btn-s" onclick="APP.closeModal()">取消</button>
        <button class="btn btn-p" id="tOk">${ic('check')}创建任务</button>
      </div>`);
    $('#tOk').onclick = async () => {
      $('#tMsg').className = 'msg err'; $('#tMsg').textContent = '';
      const body = {
        cId: p.cId, time: $('#tTime').value.trim(),
        lead_ms: +$('#tLead').value, interval_ms: +$('#tInt').value,
        max_attempts: +$('#tMax').value,
        repeat_daily: $('#tRep').checked, fallback: $('#tFb').checked,
        run_now: $('#tNow').checked,
        code: g.require_code ? ($('#tCode').value.trim()) : '',
      };
      busy($('#tOk'), true, '创建中…');
      try {
        const j = await api('/api/tasks', body);
        if (!j.ok) { setMsg('#tMsg', j.msg, 'err'); busy($('#tOk'), false); return; }
        closeModal(); toast('任务 #' + j.task_id + ' 已创建', 'ok');
        S.lastTSig = ''; refreshState();
      } catch (e) { setMsg('#tMsg', e.message, 'err'); busy($('#tOk'), false); }
    };
  }


  /* ============================================================ 设置保存 */
  async function savePush(btn) {
    busy(btn, true, '保存中…');
    try {
      const j = await api('/api/settings', {
        push: {
          enabled: $('#pEn').checked, token: $('#pToken').value.trim(),
          on_fail: $('#pFail').checked, topic: $('#pTopic').value.trim(),
          group_stock: $('#pGs').checked, group_self_too: $('#pGst').checked,
        },
      });
      if (j.ok) { S.cfg = j.settings; setMsg('#pMsg', '已保存', 'ok'); paintSettings(); }
    } catch (e) { setMsg('#pMsg', e.message, 'err'); }
    busy(btn, false);
  }
  async function testPush(btn) {
    busy(btn, true, '发送中…');
    try {
      await savePush(null);
      const j = await api('/api/push/test', {});
      setMsg('#pMsg', j.msg, j.ok ? 'ok' : 'err');
    } catch (e) { setMsg('#pMsg', e.message, 'err'); }
    busy(btn, false);
  }
  async function saveFallback(btn) {
    busy(btn, true, '保存中…');
    try {
      const j = await api('/api/settings', {
        fallback: {
          enabled: $('#fEn').checked, on_gone: $('#fGone').checked,
          on_soldout: $('#fSold').checked, on_poor: $('#fPoor').checked,
          min_ratio: Math.max(0, Math.min(100, +$('#fMin').value || 0)) / 100,
        },
      });
      if (j.ok) { S.cfg = j.settings; setMsg('#fMsg', '已保存', 'ok'); paintSettings(); }
    } catch (e) { setMsg('#fMsg', e.message, 'err'); }
    busy(btn, false);
  }
  async function saveDefaults(btn) {
    busy(btn, true, '保存中…');
    try {
      const j = await api('/api/settings', {
        task_defaults: {
          time: $('#dTime').value.trim() || '10:00:00',
          lead_ms: +$('#dLead').value || 0,
          interval_ms: +$('#dInt').value || 200,
          max_attempts: +$('#dMax').value || 600,
        },
      });
      if (j.ok) { S.cfg = j.settings; setMsg('#dMsg', '已保存', 'ok'); }
    } catch (e) { setMsg('#dMsg', e.message, 'err'); }
    busy(btn, false);
  }

  /* ============================================================ 管理后台 */
  const AV = {
    overview: { t: '概览', s: '整体数据与最近动态', n: 'grid' },
    codes:    { t: '兑换码', s: '批量生成、作废、导出', n: 'ticket' },
    users:    { t: '用户', s: '禁用、踢下线、删除', n: 'users' },
    proxies:  { t: '代理 IP', s: '导入 IP 池、探测、按用户分配', n: 'pulse' },
    settings: { t: '全局设置', s: '活动 id / sign / 注册开关', n: 'sliders' },
  };

  function renderAdminShell() {
    $('#app').innerHTML = `
    <div class="app">
      <aside class="side">
        <div class="brand">
          <div class="logo">${ic('shield')}</div>
          <div><h1>管理后台</h1><p>DEWU ADMIN</p></div>
        </div>
        <nav class="nav">
          <div class="nav-h">管理</div>
          ${Object.keys(AV).map((k) => `<a class="nav-item" data-anav="${k}" onclick="APP.adminGo('${k}')">
            ${ic(AV[k].n)}<span class="lb">${AV[k].t}</span></a>`).join('')}
          <div class="nav-h">系统</div>
          <a class="nav-item" href="/">${ic('user')}<span class="lb">用户端</span></a>
        </nav>
        <div class="side-foot">
          <div class="whoami">
            <div class="av">${ic('shield')}</div>
            <div class="t"><b id="adName">admin</b><span>管理员</span></div>
            <button class="icon-btn" title="退出登录" onclick="APP.adminLogout()">${ic('logout')}</button>
          </div>
        </div>
      </aside>
      <div class="main">
        <header class="head"><div class="head-in">
          <div class="ttl"><h2 id="adT">概览</h2><p id="adS"></p></div>
          <div class="acts">
            <span class="pill hide-sm">${ic('users')}<span id="adUsers">0</span> 用户</span>
            <span class="pill hide-sm">${ic('clock')}<span id="adClock">--:--:--</span></span>
            <button class="btn btn-s btn-sm" onclick="APP.adminRefresh(this)">${ic('refresh')}刷新</button>
          </div>
        </div></header>
        <div class="view" id="view"></div>
      </div>
      <nav class="tabbar">
        ${Object.keys(AV).map((k) => `<button data-atab="${k}" onclick="APP.adminGo('${k}')">
          ${ic(AV[k].n)}<span>${AV[k].t}</span></button>`).join('')}
      </nav>
    </div>`;
    const nm = $('#adName');
    if (nm) nm.textContent = (S.admin || {}).username || 'admin';
    if (S.tickTimer) clearInterval(S.tickTimer);
    S.tickTimer = setInterval(() => {
      const d = new Date(), c = $('#adClock');
      if (c) c.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }, 1000);
  }

  async function bootAdmin() {
    try {
      const me = await api('/api/admin/me');
      S.admin = me.admin;
    } catch (e) {
      if (e.status === 401) return renderAdminLogin();
      throw e;
    }
    renderAdminShell();
    adminGo(S.adminTab || 'overview');
  }

  function adminGo(k) {
    S.adminTab = k;
    $$('.nav-item[data-anav]').forEach((a) => a.classList.toggle('on', a.dataset.anav === k));
    $$('.tabbar button[data-atab]').forEach((a) => a.classList.toggle('on', a.dataset.atab === k));
    $('#adT').innerHTML = ic(AV[k].n) + AV[k].t;
    $('#adS').textContent = AV[k].s;
    $('#view').innerHTML = ADMIN_HTML[k]();
    ADMIN_BIND[k] && ADMIN_BIND[k]();
    window.scrollTo({ top: 0 });
  }

  async function adminRefresh(btn) {
    busy(btn, true, '刷新中…');
    const o = await fetchOverview();
    if (o) {
      const e = $('#adUsers'); if (e) e.textContent = o.users || 0;
      if (S.adminTab === 'overview') adminGo('overview');
    }
    busy(btn, false);
  }
  async function fetchOverview() {
    try {
      const o = await api('/api/admin/overview');
      S.adminData.overview = o.stats;
      return o.stats;
    } catch (e) { if (e.status === 401) renderAdminLogin(); return null; }
  }

  const ADMIN_HTML = {};
  const ADMIN_BIND = {};

  ADMIN_HTML.overview = () => `
    <div class="stats" id="adStats"><div class="stat"><div class="b">
      <div class="n">…</div><div class="l">加载中</div></div></div></div>
    <div class="set-grid">
      <div class="card" style="margin:0">
        <div class="card-h"><h3>${ic('users')}最近登录的用户</h3><div class="sp"></div>
          <button class="btn btn-s btn-sm" onclick="APP.adminGo('users')">全部用户</button></div>
        <div class="card-b tight" id="adRecent"></div>
      </div>
      <div class="card" style="margin:0">
        <div class="card-h"><h3>${ic('ticket')}最近生成的兑换码</h3><div class="sp"></div>
          <button class="btn btn-s btn-sm" onclick="APP.adminGo('codes')">兑换码管理</button></div>
        <div class="card-b tight" id="adRecentCodes"></div>
      </div>
    </div>`;

  ADMIN_BIND.overview = async () => {
    const st = await fetchOverview();
    if (!st) return;
    const e = $('#adUsers'); if (e) e.textContent = st.users || 0;
    $('#adStats').innerHTML = [
      { i: 'users', c: 'blue', n: st.users, l: '用户数' },
      { i: 'clock', c: 'red', n: st.tasks, l: '任务数' },
      { i: 'check', c: 'green', n: st.success, l: '抢兑成功' },
      { i: 'alert', c: '', n: st.fail, l: '抢兑失败' },
      { i: 'ticket', c: 'gold', n: st.codes, l: '兑换码总数' },
      { i: 'key', c: '', n: st.codes_used, l: '已使用' },
    ].map((s) => `<div class="stat"><div class="si ${s.c}">${ic(s.i, 'i-l')}</div>
      <div class="b"><div class="n">${esc(s.n == null ? 0 : s.n)}</div>
      <div class="l">${s.l}</div></div></div>`).join('');

    const box = $('#adRecent');
    box.innerHTML = '<div class="empty" style="padding:24px">加载中…</div>';
    try {
      const u = await api('/api/admin/users');
      box.innerHTML = u.users.length ? u.users.slice(0, 6).map((x) => `
        <div class="ev"><span class="d" style="background:${x.status === 'active' ? '#0f9d58' : '#e6243f'}"></span>
        <span class="tx"><b>${esc(x.phone)}</b> · ${x.tasks} 个任务 / 成功 ${x.success}
        <span class="muted">· ${esc(x.last_login || '未登录过')}</span></span></div>`).join('')
        : '<div class="empty" style="padding:24px">还没有用户登录过</div>';
    } catch (e2) { box.innerHTML = '<div class="empty" style="padding:24px">加载失败</div>'; }

    const cb = $('#adRecentCodes');
    try {
      const c = await api('/api/admin/codes?limit=200');
      cb.innerHTML = c.codes.length ? c.codes.slice(0, 6).map((x) => `
        <div class="ev"><span class="d" style="background:${x.status === 'unused' ? '#c6ccd7' : x.status === 'used' ? '#0f9d58' : '#e6243f'}"></span>
        <span class="tx mono">${esc(x.code)} <span class="muted">${esc(x.note || '')} · ${
          x.status === 'unused' ? '未使用' : x.status === 'used' ? '已使用' : '已作废'}</span></span></div>`).join('')
        : '<div class="empty" style="padding:24px">还没有兑换码</div>';
    } catch (e2) { cb.innerHTML = '<div class="empty" style="padding:24px">加载失败</div>'; }
  };

  ADMIN_HTML.codes = () => `
    <div class="card">
      <div class="card-h"><h3>${ic('plus')}批量生成兑换码</h3><div class="sp"></div>
        <span class="sub">一个码 = 允许创建的任务个数</span></div>
      <div class="card-b">
        <div class="grid2">
          <label class="fld"><span>数量（1-500）</span><input id="cgCount" type="number" value="10"></label>
          <label class="fld"><span>每个码可创建任务数</span><input id="cgQuota" type="number" value="1"></label>
        </div>
        <div class="grid2">
          <label class="fld"><span>前缀</span><input id="cgPrefix" value="DW"></label>
          <label class="fld"><span>备注</span><input id="cgNote" placeholder="例如：10月活动 / 张三"></label>
        </div>
        <div class="msg" id="cgMsg"></div>
        <div class="row" style="margin-top:14px">
          <button class="btn btn-p btn-sm" onclick="APP.genCodes(this)">${ic('zap')}生成</button>
          <button class="btn btn-s btn-sm" onclick="APP.exportCodes(this)">${ic('download')}导出未使用的码</button>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h3>${ic('ticket')}兑换码列表 <span class="num" id="cCount">0</span></h3>
        <div class="sp"></div>
        <input id="cq" placeholder="搜索码 / 备注" style="max-width:190px">
        <select id="cs" style="max-width:130px">
          <option value="">全部状态</option><option value="unused">未使用</option>
          <option value="used">已使用</option><option value="disabled">已作废</option>
        </select>
        <button class="btn btn-s btn-sm" onclick="APP.loadCodes()">${ic('search')}查找</button>
      </div>
      <div class="card-b"><div id="codeBox"></div></div>
    </div>`;

  ADMIN_BIND.codes = () => {
    const q = $('#cq');
    q.onkeydown = (e) => { if (e.key === 'Enter') loadCodes(); };
    $('#cs').onchange = () => loadCodes();
    loadCodes();
  };

  async function genCodes(btn) {
    busy(btn, true, '生成中…');
    try {
      const j = await api('/api/admin/codes/generate', {
        count: +$('#cgCount').value, quota: +$('#cgQuota').value,
        prefix: $('#cgPrefix').value.trim(), note: $('#cgNote').value.trim(),
      });
      if (!j.ok) { setMsg('#cgMsg', j.msg, 'err'); }
      else {
        const m = $('#cgMsg');
        m.className = 'msg ok show';
        m.innerHTML = '已生成 ' + j.count + ' 个：<span class="mono">'
          + esc(j.codes.slice(0, 5).join('  ')) + (j.count > 5 ? ' …' : '') + '</span>';
        toast('已生成 ' + j.count + ' 个兑换码', 'ok');
        loadCodes();
      }
    } catch (e) { setMsg('#cgMsg', e.message, 'err'); }
    busy(btn, false);
  }
  async function exportCodes(btn) {
    busy(btn, true, '导出中…');
    try {
      const j = await api('/api/admin/codes/export', { status: 'unused' });
      if (!j.text) { toast('没有未使用的码', 'err'); busy(btn, false); return; }
      const url = URL.createObjectURL(new Blob([j.text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'dewu-codes.txt'; a.click();
      URL.revokeObjectURL(url);
      toast('已导出 ' + j.count + ' 个', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    busy(btn, false);
  }
  async function loadCodes() {
    const box = $('#codeBox'); if (!box) return;
    box.innerHTML = '<div class="empty" style="padding:26px">加载中…</div>';
    const q = encodeURIComponent($('#cq') ? $('#cq').value.trim() : '');
    const s = $('#cs') ? $('#cs').value : '';
    let j;
    try { j = await api(`/api/admin/codes?q=${q}&status=${s}`); }
    catch (e) {
      box.innerHTML = '<div class="empty" style="padding:26px">加载失败：' + esc(e.message) + '</div>';
      if (e.status === 401) renderAdminLogin();
      return;
    }
    $('#cCount').textContent = j.total;
    if (!j.codes.length) {
      box.innerHTML = `<div class="empty"><div class="ico">${ic('ticket')}</div>
        <b>没有兑换码</b>在上面批量生成一批</div>`;
      return;
    }
    const tag = (x) => ({ unused: 'wait', used: 'ok', disabled: 'bad' }[x] || 'wait');
    const label = (x) => ({ unused: '未使用', used: '已使用', disabled: '已作废' }[x] || x);
    box.innerHTML = `<div class="tbl-wrap"><table><thead><tr>
      <th>兑换码</th><th>备注</th><th>配额</th><th>状态</th><th>绑定</th><th>创建 / 使用</th><th>操作</th>
      </tr></thead><tbody>${j.codes.map((c) => `<tr>
        <td class="mono" style="font-weight:600">${esc(c.code)}</td>
        <td class="muted">${esc(c.note || '—')}</td>
        <td class="mono">${c.used}/${c.quota}</td>
        <td><span class="tag ${tag(c.status)}">${label(c.status)}</span></td>
        <td class="mono muted">${c.bound_user_id ? '#' + c.bound_user_id : '—'}</td>
        <td class="muted" style="font-size:11.5px">${esc(c.created_at)}<br>${esc(c.used_at || '')}</td>
        <td><div class="acts">
          <button class="btn btn-s btn-sm" onclick="APP.codeStatus(${c.id},'${c.status === 'disabled' ? 'unused' : 'disabled'}')">
            ${c.status === 'disabled' ? '恢复' : '作废'}</button>
          <button class="btn btn-danger btn-sm" onclick="APP.codeDel(${c.id})">删除</button>
        </div></td></tr>`).join('')}</tbody></table></div>`;
  }
  async function codeStatus(id, st) {
    await api(`/api/admin/codes/${id}/status`, { status: st });
    toast('已更新', 'ok'); loadCodes();
  }
  async function codeDel(id) {
    if (!confirm('删除这个兑换码？')) return;
    await api('/api/admin/codes/delete', { ids: [id] });
    toast('已删除', 'ok'); loadCodes();
  }

  ADMIN_HTML.users = () => `
    <div class="card">
      <div class="card-h"><h3>${ic('users')}用户列表 <span class="num" id="uCount">0</span></h3>
        <div class="sp"></div>
        <button class="btn btn-s btn-sm" onclick="APP.loadUsers()">${ic('refresh')}刷新</button></div>
      <div class="card-b"><div id="userBox"></div></div>
    </div>`;

  ADMIN_BIND.users = () => loadUsers();
  async function loadUsers() {
    const box = $('#userBox'); if (!box) return;
    box.innerHTML = '<div class="empty" style="padding:26px">加载中…</div>';
    let j;
    try { j = await api('/api/admin/users'); }
    catch (e) {
      box.innerHTML = '<div class="empty" style="padding:26px">加载失败：' + esc(e.message) + '</div>';
      if (e.status === 401) renderAdminLogin();
      return;
    }
    $('#uCount').textContent = j.users.length;
    const e = $('#adUsers'); if (e) e.textContent = j.users.length;
    if (!j.users.length) {
      box.innerHTML = `<div class="empty"><div class="ico">${ic('users')}</div>
        <b>还没有用户登录过</b>把用户端地址发出去，他们登录后就会出现在这里</div>`;
      return;
    }
    box.innerHTML = `<div class="tbl-wrap"><table><thead><tr>
      <th>#</th><th>手机号</th><th>备注</th><th>状态</th><th>任务 / 成功</th><th>监听</th><th>推送</th>
      <th>最近登录</th><th>操作</th></tr></thead><tbody>${j.users.map((u) => `<tr>
        <td class="mono">${u.id}</td>
        <td class="mono">${esc(u.phone)}</td>
        <td class="muted">${esc(u.remark || '—')}</td>
        <td>${u.status === 'active' ? '<span class="tag ok">正常</span>' : '<span class="tag bad">已禁用</span>'}
            ${u.has_token ? '' : '<span class="tag warn">无 token</span>'}</td>
        <td class="mono">${u.tasks} / <span style="color:#0f9d58">${u.success}</span></td>
        <td>${u.watch ? '<span class="tag run">开</span>' : '<span class="tag wait">关</span>'}</td>
        <td>${u.push ? '<span class="tag run">开</span>' : '<span class="tag wait">关</span>'}</td>
        <td class="muted" style="font-size:11.5px">${esc(u.last_login || '—')}</td>
        <td><div class="acts">
          <button class="btn btn-s btn-sm" onclick="APP.userStatus(${u.id},'${u.status === 'active' ? 'banned' : 'active'}')">
            ${u.status === 'active' ? '禁用' : '解禁'}</button>
          <button class="btn btn-s btn-sm" onclick="APP.userKick(${u.id})">踢下线</button>
          <button class="btn btn-s btn-sm" onclick="APP.userCredentials(${u.id})">重置凭据</button>
          <button class="btn btn-danger btn-sm" onclick="APP.userDel(${u.id})">删除</button>
        </div></td></tr>`).join('')}</tbody></table></div>`;
  }
  async function userStatus(id, st) {
    await api(`/api/admin/users/${id}/status`, { status: st });
    toast('已更新', 'ok'); loadUsers();
  }
  function userCredentials(id) {
    modal(`<h3>重置用户 #${id} 凭据</h3>
      <div class="desc">请先停止该用户的任务。保存后用户用新密码进入，不会触发得物登录。</div>
      <label class="fld"><span>新得物密码</span><input id="resetPassword" type="password" autocomplete="new-password"></label>
      <div class="foot"><button class="btn btn-s" onclick="APP.closeModal()">取消</button>
      <button class="btn btn-p" onclick="APP.saveCredentials(${id})">保存</button></div>`);
  }
  async function saveCredentials(id) {
    const password = $('#resetPassword').value;
    if (!password) return toast('请输入密码', 'error');
    const j = await api(`/api/admin/users/${id}/credentials`, { password });
    toast(j.msg, j.ok ? 'ok' : 'error');
    if (j.ok) { closeModal(); loadUsers(); }
  }
  async function userKick(id) {
    const j = await api(`/api/admin/users/${id}/kick`, {}); toast(j.msg, 'ok');
  }
  async function userDel(id) {
    if (!confirm('删除用户 #' + id + '？他的任务也会一起删除。')) return;
    await api(`/api/admin/users/${id}`, undefined, 'DELETE');
    toast('已删除', 'ok'); loadUsers();
  }

  ADMIN_HTML.settings = () => `
    <div class="set-grid">
      <div class="card" style="margin:0">
        <div class="sec-t"><span class="si">${ic('users')}</span>公共账号（拉商品用）</div>
        <div class="card-b">
          <div class="desc" style="font-size:12.5px;color:var(--ink3);margin-bottom:14px;line-height:1.65">
            填一个你自己的号，由它统一拉取商品列表，<b>所有用户共用这一份</b> —— 用户端
            不用登录就能看到商品。它走直连，<b>不占代理 IP 额度</b>，也不需要跟谁的登录态一致。</div>
          <label class="fld"><span>手机号</span>
            <input id="paPhone" placeholder="13800138000" autocomplete="off"></label>
          <label class="fld"><span>密码</span>
            <input id="paPw" type="password" placeholder="留空 = 不改" autocomplete="new-password">
            <div class="hint" id="paPwHint"></div></label>
          <div class="grid2">
            <label class="fld"><span>自动刷新间隔（秒）</span>
              <input id="paInt" type="number" min="20" placeholder="60">
              <div class="hint">最快 20 秒。别设太密，容易把列表接口拉崩。</div></label>
            <label class="fld"><span>当前状态</span>
              <div id="paStat" class="muted" style="padding-top:9px;font-size:12.5px;line-height:1.6">—</div></label>
          </div>
          <label class="chk"><input type="checkbox" id="paEn">
            启用（后台按上面的间隔自动刷新商品列表）</label>
          <div class="msg" id="paMsg"></div>
          <div class="row" style="margin-top:14px">
            <button class="btn btn-p btn-sm" onclick="APP.savePublic(this)">${ic('check')}保存</button>
            <button class="btn btn-s btn-sm" onclick="APP.testPublic(this)">${ic('pulse')}测试登录并拉一次</button>
            <button class="btn btn-g btn-sm" onclick="APP.refreshPublic(this)">${ic('refresh')}刷新商品</button>
          </div>
          <div id="paLogs" style="margin-top:12px"></div>
        </div>
      </div>
      <div class="card" style="margin:0">
        <div class="sec-t"><span class="si">${ic('pulse')}</span>天启IP（开抢前自动换 IP）</div>
        <div class="card-b">
          <div class="desc" style="font-size:12.5px;color:var(--ink3);margin-bottom:14px;line-height:1.65">
            配好之后，用户的任务会在 <b>开抢前 2 分钟</b> 自动提一个短效 IP，
            用<b>同一个 IP</b> 完成「登录 + 兑换」—— 一个号只用一个出口，最像真人。
            <b>没配就直连登录</b>（功能不受影响，只是出口 IP 是服务器本机）。</div>
          <label class="chk"><input type="checkbox" id="tqEn"> 启用（开抢前自动提 IP 登录）</label>
          <div class="grid2">
            <label class="fld"><span>提取秘钥 secret</span>
              <input id="tqSecret" placeholder="getip 提取接口用" autocomplete="off">
              <div class="hint" id="tqSecretHint"></div></label>
            <label class="fld"><span>用户签名 sign</span>
              <input id="tqSign" placeholder="两个接口都要" autocomplete="off">
              <div class="hint" id="tqSignHint"></div></label>
          </div>
          <div class="grid2">
            <label class="fld"><span>用户账号 key</span>
              <input id="tqKey" placeholder="白名单接口用" autocomplete="off">
              <div class="hint" id="tqKeyHint"></div></label>
            <label class="fld"><span>IP 寿命（分钟）</span>
              <select id="tqLife">
                <option value="3">3（默认，够用）</option><option value="5">5</option>
                <option value="10">10</option><option value="15">15</option>
              </select></label>
          </div>
          <div class="grid2">
            <label class="fld"><span>协议</span>
              <select id="tqProto">
                <option value="3">socks5（推荐）</option>
                <option value="2">https</option><option value="1">http</option>
              </select></label>
            <label class="fld"><span>指定地区（可空）</span>
              <input id="tqRegion" placeholder="例如 辽宁"></label>
          </div>
          <div class="grid2">
            <label class="fld"><span>代理用户名（免密套餐留空）</span>
              <input id="tqUser" autocomplete="off"></label>
            <label class="fld"><span>代理密码</span>
              <input id="tqPass" type="password" placeholder="留空 = 不改" autocomplete="new-password">
              <div class="hint" id="tqPassHint"></div></label>
          </div>
          <div class="msg" id="tqMsg"></div>
          <div class="row" style="margin-top:14px">
            <button class="btn btn-p btn-sm" onclick="APP.saveTianqi(this)">${ic('check')}保存</button>
            <button class="btn btn-s btn-sm" onclick="APP.testTianqi(this)">${ic('pulse')}测试提取一个 IP</button>
            <button class="btn btn-g btn-sm" onclick="APP.whiteTianqi(this)">${ic('shield')}本机 IP 加白名单</button>
          </div>
          <div class="muted" id="tqStat" style="margin-top:10px;font-size:12.5px;line-height:1.7">—</div>
        </div>
      </div>
      <div class="card" style="margin:0">
        <div class="sec-t"><span class="si">${ic('pulse')}</span>代理 IP 总开关</div>
        <div class="card-b">
          <div class="desc" style="font-size:12.5px;color:var(--ink3);margin-bottom:14px;line-height:1.65">
            关着的时候，谁都不会走代理（池子留着也不生效）。<b>抢兑是最容易被按 IP
            风控的一步</b>，拉列表和登录默认仍走直连，又快又稳。</div>
          <label class="chk"><input type="checkbox" id="gxEn"> 启用代理 IP 池</label>
          <label class="chk"><input type="checkbox" id="gxReq"> 强制所有任务都走代理（无视用户自己的开关）</label>
          <div class="msg" id="gxMsg"></div>
          <button class="btn btn-p btn-sm" style="margin-top:14px" onclick="APP.saveGlobal(this)">
            ${ic('check')}保存设置</button>
        </div>
      </div>
      <div class="card" style="margin:0">
        <div class="sec-t"><span class="si">${ic('sliders')}</span>接口参数</div>
        <div class="card-b">
          <div class="desc" style="font-size:12.5px;color:var(--ink3);margin-bottom:14px;line-height:1.65">
            活动换批次、sign 失效时在这里改，用户端不用动。</div>
          <label class="fld"><span>得物活动 id</span><input id="stAct" placeholder="20260917">
            <div class="hint">拉列表失败且提示「活动不存在」时改这里。</div></label>
          <label class="fld"><span>列表接口 sign</span><input id="stSign" placeholder="留空 = 用内置"></label>
          <label class="fld"><span>答题接口 sign</span><input id="stAsign" placeholder="留空 = 用内置"></label>
        </div>
      </div>
      <div class="card" style="margin:0">
        <div class="sec-t"><span class="si">${ic('shield')}</span>注册与限流</div>
        <div class="card-b">
          <label class="fld"><span>用户数上限（0 = 不限）</span><input id="stMax" type="number" placeholder="0"></label>
          <label class="chk"><input type="checkbox" id="stNew"> 允许新用户登录（关闭后只有已存在的账号能登录）</label>
          <label class="chk"><input type="checkbox" id="stCode"> 创建任务必须填兑换码</label>
          <div class="msg" id="stMsg"></div>
          <button class="btn btn-p btn-sm" style="margin-top:14px" onclick="APP.saveGlobal(this)">
            ${ic('check')}保存设置</button>
        </div>
      </div>
      <div class="card" style="margin:0">
        <div class="sec-t"><span class="si">${ic('key')}</span>修改管理员密码</div>
        <div class="card-b">
          <label class="fld"><span>原密码</span><input id="pwOld" type="password" autocomplete="off"></label>
          <label class="fld"><span>新密码（≥6 位）</span><input id="pwNew" type="password" autocomplete="off"></label>
          <div class="msg" id="pwMsg"></div>
          <button class="btn btn-s btn-sm" style="margin-top:14px" onclick="APP.savePw(this)">${ic('key')}修改密码</button>
        </div>
      </div>
    </div>`;

  ADMIN_HTML.proxies = () => `
    <div class="stats" id="gxStats"></div>
    <div class="card">
      <div class="card-h"><h3>${ic('pulse')}IP 池 <span class="num" id="gxCount">0</span></h3>
        <div class="sp"></div>
        <input id="gxq" placeholder="搜 IP / 备注" style="max-width:150px">
        <select id="gxs" style="max-width:110px">
          <option value="">全部状态</option><option value="new">未测</option>
          <option value="ok">可用</option><option value="bad">不通</option>
        </select>
        <button class="btn btn-s btn-sm" onclick="APP.loadProxies()">${ic('search')}查找</button></div>
      <div class="card-b">
        <div class="row" style="margin-bottom:14px">
          <button class="btn btn-p btn-sm" onclick="APP.checkProxies(this, false)">
            ${ic('pulse')}检测全部</button>
          <button class="btn btn-s btn-sm" onclick="APP.checkProxies(this, true)">
            ${ic('refresh')}只测没测过的</button>
          <button class="btn btn-s btn-sm" onclick="APP.autoAssign(this)">
            ${ic('users')}自动分配给用户</button>
        </div>
        <div id="gxBox"></div>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h3>${ic('download')}批量导入</h3><div class="sp"></div>
        <span class="sub">一行一个 · 支持 # 备注</span></div>
      <div class="card-b">
        <textarea id="gxText" style="min-height:130px"
          placeholder="1.2.3.4:1080:user:pass&#10;5.6.7.8:1080:user:pass&#10;9.10.11.12:8080#广州电信"></textarea>
        <div class="grid2" style="margin-top:12px">
          <label class="fld"><span>裸 host:port 按什么协议</span>
            <select id="gxScheme">
              <option value="socks5h">socks5h（域名也走代理，最稳）</option>
              <option value="socks5">socks5（本地解析 DNS）</option>
              <option value="http">http（CONNECT 隧道）</option>
            </select></label>
          <label class="fld"><span>这一批统一备注</span>
            <input id="gxLabel" placeholder="例如：10 月上海动态"></label>
        </div>
        <div class="msg" id="gxImpMsg"></div>
        <button class="btn btn-p btn-sm" style="margin-top:14px" onclick="APP.importProxies(this)">
          ${ic('download')}导入</button>
      </div>
    </div>`;

  ADMIN_BIND.proxies = () => {
    $('#gxq').onkeydown = (e) => { if (e.key === 'Enter') loadProxies(); };
    $('#gxs').onchange = () => loadProxies();
    loadProxies();
  };

  ADMIN_BIND.settings = () => loadSettings();
  async function saveGlobal(btn) {
    busy(btn, true, '保存中…');
    try {
      const j = await api('/api/admin/settings', {
        dewu_activity: $('#stAct').value.trim(), dewu_sign: $('#stSign').value.trim(),
        dewu_answer_sign: $('#stAsign').value.trim(), max_users: +$('#stMax').value,
        allow_new_user: $('#stNew').checked, require_code_for_task: $('#stCode').checked,
        proxy_enabled: $('#gxEn') ? $('#gxEn').checked : undefined,
        proxy_required: $('#gxReq') ? $('#gxReq').checked : undefined,
      });
      setMsg('#stMsg', j.ok ? '已保存' : '保存失败', j.ok ? 'ok' : 'err');
      if (j.ok && $('#gxMsg')) setMsg('#gxMsg', '已保存', 'ok');
    } catch (e) { setMsg('#stMsg', e.message, 'err'); }
    busy(btn, false);
  }
  async function savePw(btn) {
    busy(btn, true, '提交中…');
    try {
      const r = await api('/api/admin/password', { old: $('#pwOld').value, new: $('#pwNew').value });
      setMsg('#pwMsg', r.ok ? '已修改，下次登录用新密码' : r.msg, r.ok ? 'ok' : 'err');
      if (r.ok) { $('#pwOld').value = ''; $('#pwNew').value = ''; }
    } catch (e) { setMsg('#pwMsg', e.message, 'err'); }
    busy(btn, false);
  }
  async function loadSettings() {
    let j;
    try { j = await api('/api/admin/settings'); }
    catch (e) { if (e.status === 401) renderAdminLogin(); toast(e.message, 'err'); return; }
    const s = j.settings || {};
    const set = (id, v) => { const e = $(id); if (e) e.value = v == null ? '' : v; };
    set('#stAct', s.dewu_activity); set('#stSign', s.dewu_sign); set('#stAsign', s.dewu_answer_sign);
    set('#stMax', s.max_users == null ? 0 : s.max_users);
    if ($('#stNew')) $('#stNew').checked = !!s.allow_new_user;
    if ($('#stCode')) $('#stCode').checked = !!s.require_code_for_task;
    if ($('#gxEn')) $('#gxEn').checked = !!s.proxy_enabled;
    if ($('#gxReq')) $('#gxReq').checked = !!s.proxy_required;
    await loadPublicAccount();
    await loadTianqi();
  }

  /* ------------------------------------------------ 公共账号（拉商品用） */
  async function loadPublicAccount() {
    if (!$('#paPhone')) return;
    let j;
    try { j = await api('/api/admin/public-account'); }
    catch (e) { if (e.status === 401) renderAdminLogin(); return; }
    const c = j.config || {}, st = j.status || {};
    const set = (id, v) => { const e = $(id); if (e) e.value = v == null ? '' : v; };
    set('#paPhone', c.phone); set('#paInt', c.interval_sec);
    if ($('#paEn')) $('#paEn').checked = !!c.enabled;
    if ($('#paPw')) $('#paPw').value = '';
    if ($('#paPwHint')) {
      $('#paPwHint').textContent = c.has_password
        ? ('已保存密码 ' + c.password_mask + '，留空就不改') : '还没设密码';
    }
    const el = $('#paStat');
    if (el) {
      const bits = [];
      bits.push(!c.configured ? '未配置' : (c.enabled ? '已启用' : '已停用（不自动刷新）'));
      bits.push('后台 ' + (st.running ? '运行中' : '未运行'));
      if (st.count) bits.push('商品 ' + st.count + (st.at ? ' · ' + st.at : ''));
      if (st.err) bits.push('最近失败：' + st.err);
      el.textContent = bits.join(' · ');
      el.style.color = st.err ? 'var(--red, #e6243f)' : '';
    }
    const lg = $('#paLogs');
    if (lg) {
      const rows = (st.logs || []).slice(-6).reverse();
      lg.innerHTML = rows.length
        ? rows.map((l) => `<div class="muted" style="font-size:12px;line-height:1.7">${esc(l)}</div>`).join('')
        : '';
    }
  }

  async function savePublic(btn) {
    if (!$('#paPhone')) return;
    busy(btn, true, '保存中…');
    try {
      const body = {
        phone: $('#paPhone').value.trim(),
        enabled: $('#paEn').checked,
        interval_sec: +$('#paInt').value || 60,
      };
      const pw = $('#paPw').value;          // 空 = 不改密码
      if (pw) body.password = pw;
      const j = await api('/api/admin/public-account', body);
      setMsg('#paMsg', j.ok ? '已保存' : (j.msg || '保存失败'), j.ok ? 'ok' : 'err');
      if (j.ok && $('#paPw')) $('#paPw').value = '';
      await loadPublicAccount();
    } catch (e) { setMsg('#paMsg', e.message, 'err'); }
    busy(btn, false);
  }

  async function testPublic(btn) {
    if (!$('#paPhone')) return;
    busy(btn, true, '登录中…');
    try {
      const j = await api('/api/admin/public-account/test', {});
      setMsg('#paMsg', (j.ok ? '测试成功：' : '测试失败：') + (j.msg || ''), j.ok ? 'ok' : 'err');
      toast(j.msg || (j.ok ? '成功' : '失败'), j.ok ? 'ok' : 'err');
      await loadPublicAccount();
    } catch (e) { setMsg('#paMsg', e.message, 'err'); }
    busy(btn, false);
  }

  async function refreshPublic(btn) {
    if (!$('#paPhone')) return;
    busy(btn, true, '刷新中…');
    try {
      const j = await api('/api/admin/public-account/refresh', {});
      toast(j.msg || (j.ok ? '已刷新' : '失败'), j.ok ? 'ok' : 'err');
      await loadPublicAccount();
    } catch (e) { toast(e.message, 'err'); }
    busy(btn, false);
  }

  /* ------------------------------------------------ 天启IP（开抢前自动换 IP） */
  function _tqPaint(j) {
    const c = j.config || {}, st = j.status || {};
    if ($('#tqSecretHint')) {
      $('#tqSecretHint').textContent = c.has_secret
        ? ('已保存 ' + c.secret + '，留空不改') : '还没填 —— 从「提取链接」里抄 secret= 后面那段';
    }
    if ($('#tqSignHint')) {
      $('#tqSignHint').textContent = c.has_sign ? ('已保存 ' + c.sign) : '';
    }
    if ($('#tqKeyHint')) {
      $('#tqKeyHint').textContent = c.has_key ? ('已保存 ' + c.key) : '免密 s5 靠白名单认人，要填 key';
    }
    if ($('#tqPassHint')) {
      $('#tqPassHint').textContent = c.has_auth_pass ? ('已保存 ' + c.auth_pass) : '';
    }
    const el = $('#tqStat');
    if (el) {
      const bits = [c.enabled ? (c.ready ? '已启用 · 开抢前自动提 IP'
        : '已勾启用但还没配全（缺 secret/sign）') : '已停用 · 开抢前直连登录'];
      if (st.last_ok_at) bits.push('最近提取 ' + st.last_ok_at + (st.where ? '（' + st.where + '）' : ''));
      if (st.last_err) bits.push('最近失败：' + st.last_err);
      el.textContent = bits.join(' · ');
      el.style.color = st.last_err ? 'var(--red, #e6243f)' : '';
    }
  }

  async function loadTianqi() {
    if (!$('#tqEn')) return;
    let j;
    try { j = await api('/api/admin/tianqi'); }
    catch (e) { if (e.status === 401) renderAdminLogin(); return; }
    const c = j.config || {};
    if ($('#tqEn')) $('#tqEn').checked = !!c.enabled;
    if ($('#tqLife')) $('#tqLife').value = String(c.life || 3);
    if ($('#tqProto')) $('#tqProto').value = String(c.protocol || 3);
    if ($('#tqRegion')) $('#tqRegion').value = c.region || '';
    if ($('#tqUser')) $('#tqUser').value = c.auth_user || '';
    ['#tqSecret', '#tqSign', '#tqKey', '#tqPass'].forEach((s) => { if ($(s)) $(s).value = ''; });
    _tqPaint(j);
  }

  async function saveTianqi(btn) {
    if (!$('#tqEn')) return;
    busy(btn, true, '保存中…');
    try {
      const body = {
        enabled: $('#tqEn').checked,
        protocol: +$('#tqProto').value,
        life: +$('#tqLife').value,
        region: $('#tqRegion').value.trim(),
        auth_user: $('#tqUser').value.trim(),
      };
      // ★ 空 = 不改；前端回显的打码值也不会覆盖真值（后端还会再挡一层）
      [['secret', '#tqSecret'], ['sign', '#tqSign'], ['key', '#tqKey'],
       ['auth_pass', '#tqPass']].forEach(([k, sel]) => {
        const v = $(sel) ? $(sel).value.trim() : '';
        if (v) body[k] = v;
      });
      const j = await api('/api/admin/tianqi', body);
      setMsg('#tqMsg', j.ok ? '已保存' : (j.msg || '保存失败'), j.ok ? 'ok' : 'err');
      if (j.ok) ['#tqSecret', '#tqSign', '#tqKey', '#tqPass'].forEach((s) => { if ($(s)) $(s).value = ''; });
      _tqPaint(j);
    } catch (e) { setMsg('#tqMsg', e.message, 'err'); }
    busy(btn, false);
  }

  async function testTianqi(btn) {
    if (!$('#tqEn')) return;
    busy(btn, true, '提取中…');
    try {
      const j = await api('/api/admin/tianqi/test', {});
      setMsg('#tqMsg', (j.ok ? '提取成功：' : '提取失败：') + (j.msg || ''), j.ok ? 'ok' : 'err');
      toast(j.msg || (j.ok ? '成功' : '失败'), j.ok ? 'ok' : 'err');
      _tqPaint(j);
    } catch (e) { setMsg('#tqMsg', e.message, 'err'); }
    busy(btn, false);
  }

  async function whiteTianqi(btn) {
    if (!$('#tqEn')) return;
    busy(btn, true, '提交中…');
    try {
      const j = await api('/api/admin/tianqi/white', {});
      setMsg('#tqMsg', j.msg || (j.ok ? '已加入白名单' : '失败'), j.ok ? 'ok' : 'err');
      _tqPaint(j);
    } catch (e) { setMsg('#tqMsg', e.message, 'err'); }
    busy(btn, false);
  }

  /* ------------------------------------------------ 代理 IP（管理端） */
  async function loadProxies() {
    const box = $('#gxBox'); if (!box) return;
    box.innerHTML = '<div class="empty" style="padding:26px">加载中…</div>';
    const q = encodeURIComponent(($('#gxq') || {}).value || '');
    const st = ($('#gxs') || {}).value || '';
    let j;
    try { j = await api(`/api/admin/proxies?q=${q}&status=${st}`); }
    catch (e) {
      box.innerHTML = '<div class="empty" style="padding:26px">加载失败：' + esc(e.message) + '</div>';
      if (e.status === 401) renderAdminLogin();
      return;
    }
    S.adminData.proxies = j.proxies;
    $('#gxCount').textContent = j.stats.total;
    const s = j.stats;
    $('#gxStats').innerHTML = [
      { i: 'pulse', c: s.master ? 'green' : '', n: s.master ? '开' : '关', l: '总开关' },
      { i: 'inbox', c: 'blue', n: s.total, l: '池子总数' },
      { i: 'check', c: s.ok ? 'green' : '', n: s.ok, l: '探测可用' },
      { i: 'alert', c: s.bad ? 'red' : '', n: s.bad, l: '探测不通' },
      { i: 'users', c: 'gold', n: s.bound, l: '已绑定用户' },
      { i: 'help', c: '', n: s.untested, l: '还没测过' },
    ].map((x) => `<div class="stat"><div class="si ${x.c}">${ic(x.i, 'i-l')}</div>
      <div class="b"><div class="n">${esc(x.n)}</div><div class="l">${x.l}</div></div></div>`).join('');
    if ($('#gxEn')) $('#gxEn').checked = s.master;
    if ($('#gxReq')) $('#gxReq').checked = s.required;
    if ($('#gxScheme') && j.schemes) { /* 保留用户当前选择 */ }

    if (!j.proxies.length) {
      box.innerHTML = `<div class="empty"><div class="ico">${ic('pulse')}</div>
        <b>池子是空的</b>把 IP 商后台的列表粘到下面「批量导入」里</div>`;
      return;
    }
    const tg = (x) => ({ ok: 'ok', bad: 'bad', new: 'wait' }[x] || 'wait');
    const lb = (x) => ({ ok: '可用', bad: '不通', new: '未测' }[x] || x);
    box.innerHTML = `<div class="tbl-wrap"><table><thead><tr>
      <th>#</th><th>代理</th><th>备注</th><th>状态</th><th>出口 IP</th><th>延迟</th>
      <th>成功/失败</th><th>分给谁</th><th>操作</th></tr></thead><tbody>${j.proxies.map((p) => `<tr>
        <td class="mono">${p.id}</td>
        <td class="mono" style="font-size:12px">${esc(p.mask)}
            <div class="muted" style="font-size:11px">${esc(p.scheme)}</div></td>
        <td class="muted">${esc(p.label || '—')}</td>
        <td><span class="tag ${p.enabled ? tg(p.status) : 'bad'}">${
            p.enabled ? lb(p.status) : '已停用'}</span>
          ${p.fail_streak >= 3 ? '<span class="tag warn">连错 ' + p.fail_streak + '</span>' : ''}</td>
        <td class="mono" style="font-size:12px">${esc(p.exit_ip || '—')}</td>
        <td class="mono">${p.latency_ms ? p.latency_ms + 'ms' : '—'}</td>
        <td class="mono"><span style="color:#0f9d58">${p.ok_count}</span> / ${p.fail_count}</td>
        <td>${p.bound_user_id
            ? `<span class="tag ok">#${p.bound_user_id}</span>
               <div class="muted mono" style="font-size:11px">${esc(p.bound_phone || '')}</div>`
            : '<span class="tag wait">未分配</span>'}</td>
        <td><div class="acts">
          <button class="btn btn-s btn-sm" onclick="APP.checkOne(${p.id}, this)">测速</button>
          <button class="btn btn-s btn-sm" onclick="APP.proxyToggle(${p.id}, ${p.enabled ? 'false' : 'true'})">
            ${p.enabled ? '停用' : '启用'}</button>
          ${p.bound_user_id ? `<button class="btn btn-s btn-sm" onclick="APP.proxyBind(${p.id}, 0)">解绑</button>` : ''}
          <button class="btn btn-danger btn-sm" onclick="APP.proxyDel(${p.id})">删除</button>
        </div></td></tr>`).join('')}</tbody></table></div>`;
  }

  async function importProxies(btn) {
    const text = $('#gxText').value;
    if (!text.trim()) { setMsg('#gxImpMsg', '先粘贴点东西进来', 'err'); return; }
    busy(btn, true, '导入中…');
    try {
      const j = await api('/api/admin/proxies/import', {
        text, scheme: $('#gxScheme').value, label: $('#gxLabel').value.trim(),
      });
      const m = $('#gxImpMsg');
      m.className = 'msg ' + (j.ok ? 'ok' : 'err') + ' show';
      m.innerHTML = esc(j.msg || j.msg) + (j.errors && j.errors.length
        ? '<br><span class="mono" style="font-size:11px">格式不对：'
          + j.errors.slice(0, 5).map((e) => '第' + e.line + '行 ' + esc(e.text) + '（' + esc(e.err) + '）').join('；')
          + (j.errors.length > 5 ? ' …' : '') + '</span>' : '');
      if (j.added) { toast('导入 ' + j.added + ' 个', 'ok'); $('#gxText').value = ''; loadProxies(); }
    } catch (e) { setMsg('#gxImpMsg', e.message, 'err'); }
    busy(btn, false);
  }

  async function checkProxies(btn, onlyNew) {
    const ids = onlyNew
      ? (S.adminData.proxies || []).filter((p) => p.status === 'new').map((p) => p.id)
      : [];
    if (onlyNew && !ids.length) { toast('没有没测过的了', 'err'); return; }
    busy(btn, true, '检测中…（逐个探，可能要几十秒）');
    try {
      const j = await api('/api/admin/proxies/check', { ids });
      toast(j.msg, j.bad ? 'err' : 'ok');
      loadProxies();
    } catch (e) { toast(e.message, 'err'); }
    busy(btn, false);
  }
  async function checkOne(id, btn) {
    busy(btn, true, '…');
    try {
      const j = await api('/api/admin/proxies/check', { ids: [id] });
      const r = (j.results || [])[0] || {};
      toast(r.ok ? ('可用 · 出口 ' + (r.exit_ip || '未回显') + ' · ' + r.latency_ms + 'ms')
        : ('不通：' + (r.error || '')), r.ok ? 'ok' : 'err');
      loadProxies();
    } catch (e) { toast(e.message, 'err'); }
    busy(btn, false);
  }
  async function proxyToggle(id, on) {
    await api(`/api/admin/proxies/${id}`, { enabled: on });
    toast(on ? '已启用' : '已停用', 'ok'); loadProxies();
  }
  async function proxyBind(id, uid) {
    const j = await api(`/api/admin/proxies/${id}`, { bound_user_id: uid });
    toast(j.ok ? '已更新绑定' : (j.msg || '失败'), j.ok ? 'ok' : 'err'); loadProxies();
  }
  async function proxyDel(id) {
    if (!confirm('从池子里删除这个代理？已经用它的用户会回到「没分到 IP」。')) return;
    await api('/api/admin/proxies/delete', { ids: [id] });
    toast('已删除', 'ok'); loadProxies();
  }
  async function autoAssign(btn) {
    busy(btn, true, '分配中…');
    try {
      const j = await api('/api/admin/proxies/auto_assign', { only_ok: true });
      toast(j.msg, 'ok'); loadProxies();
    } catch (e) { toast(e.message, 'err'); }
    busy(btn, false);
  }

  async function adminLogout() {
    await api('/api/admin/logout', {});
    S.admin = null; renderAdminLogin();
  }

  /* ============================================================ 启动 */
  async function boot() {
    try {
      const m = await api('/api/me');
      S.me = m.user; S.cfg = m.settings; S.global = m.global;
      S.login = m.login || null;        // ★ 登录状态（懒登录模式下长期是「未登录」）
    } catch (e) {
      if (e.status === 401) {
        if (location.pathname.startsWith('/admin')) renderAdminLogin(); else renderLogin();
        return;
      }
      throw e;
    }
    renderShell();
    go('overview');
    await refreshState();
    S.lastPSig = ''; S.lastTSig = ''; paint(true);
    startPoll();
  }

  async function logout() {
    stopPoll();
    try { await api('/api/logout', {}); } catch (e) { /* 忽略 */ }
    S.me = null; S.state = null; renderLogin();
  }

  window.addEventListener('DOMContentLoaded', () => {
    if (location.pathname.startsWith('/admin')) bootAdmin(); else boot();
  });

  return {
    // 路由 / 生命周期
    boot, logout, go, sec, closeModal,
    // 用户端
    pick, refreshList, probe, clearDone, delTask, runNow, clearLogView,
    savePush, testPush, saveFallback, saveDefaults,
    // 兼容旧入口：跳到设置页对应段落
    pushModal: () => sec('push'),
    noticeModal: () => sec('notice'),
    // 管理端
    adminGo, adminLogout, loadUsers, userStatus, userKick, userCredentials, saveCredentials, userDel,
    loadCodes, genCodes, exportCodes, codeStatus, codeDel,
    saveGlobal, savePw, adminRefresh,
    // 公共账号（拉商品用）
    loadPublicAccount, savePublic, testPublic, refreshPublic,
    // 天启IP（开抢前自动换 IP）
    loadTianqi, saveTianqi, testTianqi, whiteTianqi,
    // 代理 IP（管理端）
    loadProxies, importProxies, checkProxies, checkOne, proxyToggle, proxyBind,
    proxyDel, autoAssign,
  };
})();
