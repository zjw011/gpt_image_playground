/* ==========================================================================
   得物整点抢兑助手 · Web 版   前端（零构建，原生 JS）
   ========================================================================== */
const APP = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const S = {
    me: null, cfg: null, global: null, state: null,
    admin: null, adminTab: 'codes', adminData: {},
    sel: null, timer: null, lastRefreshed: null, lastTasks: '',
    filter: { q: '', stock: 'all', sort: 'default' },
    isAdmin: location.pathname.startsWith('/admin'),
  };

  /* ------------------------------------------------------------ 网络 */
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
    try { j = await r.json(); } catch (e) { /* 可能是空的 */ }
    if (r.status === 401) { const e = new Error((j && j.msg) || '未登录'); e.status = 401; throw e; }
    if (!j) throw new Error('HTTP ' + r.status);
    return j;
  }

  /* ------------------------------------------------------------ 小工具 */
  function toast(msg, kind = '') {
    const box = $('#toast');
    const d = document.createElement('div');
    d.className = 'toast ' + kind;
    d.textContent = msg;
    box.appendChild(d);
    setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .3s'; }, 2400);
    setTimeout(() => d.remove(), 2800);
  }
  const yuan = (fen) => (fen == null ? '—' : '¥' + (fen / 100).toFixed(2).replace(/\.00$/, ''));
  const IMG_PH = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='%23f2f4f7'/><text x='50' y='60' font-size='30' text-anchor='middle' fill='%23c9cfda'>?</text></svg>";

  // 兜底：万一某处 JS 出错，不要留一个「加载中…」白屏让人猜
  window.addEventListener('error', (e) => {
    const box = document.getElementById('app');
    if (box && /加载中/.test(box.textContent)) {
      box.innerHTML = '<div class="login-wrap"><div class="login-card">' +
        '<div class="brand"><div class="logo">!</div><div><h1>页面出错了</h1>' +
        '<p>请截图给管理员</p></div></div>' +
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
    if (on) { btn.dataset.old = btn.textContent; btn.textContent = text || '处理中…'; }
    else if (btn.dataset.old) { btn.textContent = btn.dataset.old; }
  };

  /* ============================================================ 登录页 */
  function renderLogin(msg) {
    $('#app').innerHTML = `
    <div class="login-wrap"><div class="login-card">
      <div class="brand">
        <div class="logo">得</div>
        <div><h1>得物整点抢兑助手</h1><p>Web 版 · 登录后即可创建定时兑换任务</p></div>
      </div>
      <div class="msg err ${msg ? 'show' : ''}" id="lgMsg">${esc(msg || '')}</div>
      <label class="fld"><span>得物手机号</span>
        <input id="phone" placeholder="11 位手机号" inputmode="numeric" autocomplete="username"></label>
      <label class="fld"><span>登录密码</span>
        <input id="pwd" type="password" placeholder="得物账号密码" autocomplete="current-password"></label>
      <button class="btn btn-p btn-block" id="lgBtn">登录</button>

      <details class="adv">
        <summary>登录被风控？改用「粘贴抓包 curl」</summary>
        <textarea id="curl" placeholder="在手机上进入得物「金币兑换」页，抓包复制带 x-auth-token 的那条 curl，粘贴到这里"></textarea>
        <button class="btn btn-s btn-block btn-sm" style="margin-top:8px" id="curlBtn">用这段 curl 登录</button>
        <div class="hint muted" style="margin-top:7px;font-size:11.5px;line-height:1.6">
          这种方式不经过密码接口，最稳；缺点是要先从手机上抓一次包。
        </div>
      </details>

      <div class="login-foot">
        <span>数据仅存于本服务器，账号之间完全隔离</span>
        <a href="/admin" id="adminLink">管理员登录 →</a>
      </div>
    </div></div>`;

    const doLogin = async (payload, btn) => {
      const m = $('#lgMsg'); m.className = 'msg err'; m.textContent = '';
      busy(btn, true, '登录中…');
      try {
        const j = await api('/api/login', payload);
        if (!j.ok) { m.className = 'msg err show'; m.textContent = j.msg || '登录失败'; busy(btn, false); return; }
        toast('登录成功，正在拉取商品列表…', 'ok');
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
        <div class="logo">管</div>
        <div><h1>管理后台</h1><p>兑换码 · 用户 · 全局设置</p></div>
      </div>
      <div class="msg err ${msg ? 'show' : ''}" id="lgMsg">${esc(msg || '')}</div>
      <label class="fld"><span>管理员账号</span><input id="au" placeholder="用户名" autocomplete="username"></label>
      <label class="fld"><span>密码</span><input id="ap" type="password" autocomplete="current-password"></label>
      <button class="btn btn-p btn-block" id="ab">登录后台</button>
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

  /* ============================================================ 用户工作台 */
  function shell(inner) {
    const st = S.state || {};
    const watch = st.watch || {};
    const bal = st.balance;
    return `
    <div class="topbar"><div class="topbar-in">
      <div class="logo">得</div>
      <h1>得物整点抢兑助手<small>Web 版</small></h1>
      <div class="sp"></div>
      <span class="pill coin" title="当前金币余额">金币 <b>${bal == null ? '—' : esc(bal)}</b></span>
      <span class="pill ${watch.running ? '' : 'off'}" id="pillWatch" title="库存监听状态">
        <span class="dot"></span>监听 ${watch.running ? '开' : '关'}${watch.tracked ? ' · ' + watch.tracked + ' 件' : ''}</span>
      <span class="pill hide-sm" id="clock" title="服务器时间">--:--:--</span>
      <span class="muted who" title="${esc(S.me.phone)}">${esc(S.me.remark || S.me.phone)}</span>
      <button class="btn btn-s btn-sm" onclick="APP.logout()">退出</button>
    </div></div>
    ${inner}`;
  }

  function renderDashboard() {
    $('#app').innerHTML = shell(`
    <div class="wrap">
      <div class="cardt">
        <h2>⚡ 快捷操作 <span class="sp"></span>
          <span class="muted">活动 id：<span class="mono">${esc((S.me.activity) || '—')}</span></span></h2>
        <div class="toolbar">
          <button class="btn btn-p" onclick="APP.refreshList(this)">刷新商品列表</button>
          <button class="btn btn-s" onclick="APP.watchModal()">库存监听</button>
          <button class="btn btn-s" onclick="APP.pushModal()">微信推送</button>
          <button class="btn btn-s" onclick="APP.answerModal()">每日答题</button>
          <button class="btn btn-s" onclick="APP.probe(this)">链路诊断</button>
          <span class="sp" style="flex:1"></span>
          <span class="muted" id="refreshedAt"></span>
        </div>
        <div class="msg err" id="listErr" style="margin-top:13px"></div>
      </div>

      <div class="cardt">
        <h2>🛍 商品列表 <span class="num" id="pCount">0</span> <span class="sp"></span>
          <span class="h2sub" id="pSum"></span></h2>
        <div class="filterbar">
          <input class="grow" id="fq" placeholder="搜索商品名…">
          <div class="seg" id="fseg">
            <button data-stock="all" class="on">全部</button>
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

      <div class="cardt">
        <h2>⏰ 我的任务 <span class="num" id="tCount">0</span> <span class="sp"></span>
          <button class="btn btn-s btn-sm" onclick="APP.clearDone()">清理已结束</button></h2>
        <div class="tlist" id="tasks"></div>
      </div>

      <div class="cardt">
        <h2>📜 运行日志 <span class="sp"></span>
          <button class="btn btn-s btn-sm" onclick="APP.clearLogView()">清屏</button></h2>
        <div id="log"></div>
      </div>
    </div>`);
    tick();
    setInterval(tick, 1000);
    bindFilters();
  }

  function bindFilters() {
    const q = $('#fq');
    if (q) {
      q.value = S.filter.q;
      let t = null;
      q.oninput = () => {
        S.filter.q = q.value.trim();
        clearTimeout(t);
        t = setTimeout(() => renderProducts(true), 180);   // 防抖，边打字边过滤
      };
    }
    const seg = $('#fseg');
    if (seg) {
      $$('button', seg).forEach((b) => {
        b.classList.toggle('on', b.dataset.stock === S.filter.stock);
        b.onclick = () => {
          S.filter.stock = b.dataset.stock;
          $$('button', seg).forEach((x) => x.classList.toggle('on', x === b));
          renderProducts(true);
        };
      });
    }
    const so = $('#fsort');
    if (so) {
      so.value = S.filter.sort;
      so.onchange = () => { S.filter.sort = so.value; renderProducts(true); };
    }
  }

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

  function tick() {
    const el = $('#clock');
    if (el && S.state) {
      const d = new Date();
      el.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map((x) => String(x).padStart(2, '0')).join(':');
    }
  }

  function renderProducts(force) {
    const st = S.state || {};
    const grid = $('#pgrid');
    if (!grid) return;
    const ra = st.refreshed_at;
    const sig = [ra, S.filter.q, S.filter.stock, S.filter.sort].join('|');
    if (!force && sig === S.lastRefreshed) return;
    S.lastRefreshed = sig;

    const { list, total } = filteredProducts();
    $('#pCount').textContent = total;
    const rt = $('#refreshedAt');
    if (rt) rt.textContent = ra ? ('列表更新于 ' + ra) : '';
    const sum = $('#pSum');
    if (sum) sum.textContent = list.length === total ? '点任意商品即可创建定时兑换任务'
      : '筛选出 ' + list.length + ' / ' + total + ' 个';
    const le = $('#listErr');
    if (le) { le.className = 'msg err' + (st.list_error ? ' show' : ''); le.textContent = st.list_error || ''; }

    if (!total) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="ico">🛍</div>' +
        '还没有商品数据<br>点上面的「刷新商品列表」拉一次</div>';
      return;
    }
    if (!list.length) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="ico">🔍</div>' +
        '没有符合条件的商品<br>换个关键词或筛选条件试试</div>';
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
            <span class="coin">${p.cost == null ? '—' : esc(p.cost)} 金币</span>
          </div>
          <div class="stock ${oos ? 'no' : low ? 'low' : ''}">
            库存 ${p.stock == null ? '—' : esc(p.stock)}${p.typeDesc ? ' · ' + esc(p.typeDesc) : ''}
          </div>
        </div>
      </div>`;
    }).join('');
  }

  function renderTasks() {
    const st = S.state || {};
    const ts = st.tasks || [];
    const box = $('#tasks');
    if (!box) return;
    $('#tCount').textContent = ts.length;
    const sig = JSON.stringify(ts.map((t) => [t.id, t.status, t.attempts, t.detail]));
    if (sig === S.lastTasks) return;
    S.lastTasks = sig;
    if (!ts.length) {
      box.innerHTML = '<div class="empty"><div class="ico">⏰</div>还没有任务，点上面任意商品创建一个</div>';
      return;
    }
    const tagOf = (s) => ({ '成功': 'ok', '失败': 'bad', '等待': 'wait', '兑换中': 'run', '已取消': 'wait' }[s] || 'wait');
    box.innerHTML = ts.map((t) => `<div class="task">
      <img class="t-img" src="${esc(t.picture || IMG_PH)}" onerror="this.src='${IMG_PH}'" alt="">
      <div>
        <div class="t-name" title="${esc(t.cName)}">${esc(t.cName)}</div>
        <div class="t-sub">
          <span class="id">#${t.id}</span>
          <span>${t.cost == null ? '—' : esc(t.cost) + ' 金币'}</span>
          <span>${yuan(t.price)}</span>
          ${t.repeat_daily ? '<span>每日</span>' : ''}
          ${t.fallback ? '<span>自动降级</span>' : ''}
        </div>
      </div>
      <div class="t-fields">
        <div class="tf"><div class="k">目标时间</div><div class="v mono">${esc(t.time)}</div></div>
        <div class="tf"><div class="k">状态</div><div class="v">
          <span class="tag ${tagOf(t.status)}">${esc(t.status)}</span>
          ${t.attempts ? `<span class="muted" style="font-size:11px"> ${t.attempts} 次</span>` : ''}
        </div></div>
        <div class="tf wide"><div class="k">说明</div>
          <div class="v" title="${esc(t.detail || '')}">${esc(t.detail || '—')}</div></div>
      </div>
      <div class="t-acts">
        <button class="btn btn-s btn-sm" onclick="APP.runNow(${t.id})">立即执行</button>
        <button class="btn btn-danger btn-sm" onclick="APP.delTask(${t.id})">删除</button>
      </div>
    </div>`).join('');
  }

  function renderLogs() {
    const st = S.state || {};
    const box = $('#log');
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const lines = (st.logs || []).slice().reverse();
    box.innerHTML = lines.map((l) =>
      `<div class="l-${esc(l.level || 'info')}">${esc(l.line || l.msg)}</div>`).join('');
    if (atBottom) box.scrollTop = 0;
  }

  /* ------------------------------------------------------------ 用户动作 */
  async function refreshState() {
    try {
      const st = await api('/api/state');
      S.state = st;
      renderProducts(); renderTasks(); renderLogs();
      const w = st.watch || {};
      const coin = $('.pill.coin b');
      if (coin) coin.textContent = st.balance == null ? '—' : st.balance;
      const wp = $('#pillWatch');
      if (wp) {
        wp.className = 'pill ' + (w.running ? '' : 'off');
        wp.innerHTML = '<span class="dot"></span>监听 ' + (w.running ? '开' : '关')
          + (w.tracked ? ' · ' + w.tracked + ' 件' : '');
      }
    } catch (e) {
      if (e.status === 401) { stopPoll(); renderLogin('登录已过期，请重新登录'); }
    }
  }
  function startPoll() { stopPoll(); S.timer = setInterval(refreshState, 2000); }
  function stopPoll() { if (S.timer) clearInterval(S.timer); S.timer = null; }

  async function refreshList(btn) {
    busy(btn, true, '刷新中…');
    try {
      const j = await api('/api/products/refresh', {});
      toast(j.msg, j.ok ? 'ok' : 'err');
      S.lastRefreshed = null; await refreshState(); renderProducts(true);
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
    const j = await api('/api/tasks/clear_done', {});
    toast('已清理', 'ok'); S.lastTasks = ''; refreshState();
  }
  async function delTask(id) {
    if (!confirm('确定删除任务 #' + id + '？')) return;
    await api(`/api/tasks/${id}/delete`, {});
    toast('已删除', 'ok'); S.lastTasks = ''; refreshState();
  }
  async function runNow(id) {
    const j = await api(`/api/tasks/${id}/run_now`, {});
    toast(j.msg || '已开始', j.ok ? 'ok' : 'err'); S.lastTasks = ''; refreshState();
  }
  function clearLogView() { const b = $('#log'); if (b) b.innerHTML = ''; }

  function pick(cId) {
    const p = (S.state.products || []).find((x) => x.cId === cId);
    if (!p) return;
    S.sel = cId; renderProducts(true);
    taskModal(p);
  }

  /* ============================================================ 弹窗：创建任务 */
  function taskModal(p) {
    const g = S.global || {};
    const fd = ((S.me.settings || {}).task_defaults) || {};
    const fbDefault = ((S.me.settings || {}).fallback || {}).enabled !== false;
    modal(`
      <h3>创建定时兑换任务</h3>
      <div class="desc">到点自动抢兑。建议提前 300ms 起抢，每次间隔 200ms。</div>
      <div class="preview">
        <img src="${esc(p.picture || IMG_PH)}" onerror="this.src='${IMG_PH}'" alt="">
        <div class="info">
          <b>${esc(p.cName)}</b>
          <div class="meta">
            <span class="p">${yuan(p.price)}</span>
            <span>需要 <b>${esc(p.cost)}</b> 金币</span>
            <span>库存 ${p.stock == null ? '—' : esc(p.stock)}</span>
            ${p.outOfStock ? '<span style="color:#e6243f">当前已售罄</span>' : ''}
          </div>
        </div>
      </div>
      ${g.require_code ? `<label class="fld"><span>兑换码（必填 · 一个兑换码只能创建一个任务）</span>
        <input id="tCode" placeholder="例如 DW-XXXX-XXXX" style="text-transform:uppercase"></label>` : ''}
      <div class="grid2">
        <label class="fld"><span>目标时间</span><input id="tTime" value="${esc(fd.time || '10:00:00')}"></label>
        <label class="fld"><span>提前起抢 (ms)</span><input id="tLead" type="number" value="${esc(fd.lead_ms || 300)}"></label>
      </div>
      <div class="grid2">
        <label class="fld"><span>每次间隔 (ms)</span><input id="tInt" type="number" value="${esc(fd.interval_ms || 200)}"></label>
        <label class="fld"><span>最多尝试次数</span><input id="tMax" type="number" value="${esc(fd.max_attempts || 600)}"></label>
      </div>
      <label class="chk"><input type="checkbox" id="tRep"> 每天重复（抢到后第二天继续）</label>
      <label class="chk"><input type="checkbox" id="tFb" ${fbDefault ? 'checked' : ''}> 自动降级兜底（原商品下架/抢不到时，自动换一个买得起的有货商品）</label>
      <label class="chk"><input type="checkbox" id="tNow"> 创建后立即执行一次（测试用）</label>
      <div class="msg err" id="tMsg"></div>
      <div class="foot">
        <button class="btn btn-s" onclick="APP.closeModal()">取消</button>
        <button class="btn btn-p" id="tOk">创建任务</button>
      </div>`);
    $('#tOk').onclick = async () => {
      const m = $('#tMsg'); m.className = 'msg err'; m.textContent = '';
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
        if (!j.ok) { m.className = 'msg err show'; m.textContent = j.msg; busy($('#tOk'), false); return; }
        closeModal(); toast('任务 #' + j.task_id + ' 已创建', 'ok');
        S.lastTasks = ''; refreshState();
      } catch (e) { m.className = 'msg err show'; m.textContent = e.message; busy($('#tOk'), false); }
    };
  }

  /* ============================================================ 弹窗：推送设置 */
  function pushModal() {
    const p = (S.me.settings || {}).push || {};
    modal(`
      <h3>微信推送（PushPlus）</h3>
      <div class="desc">抢兑结果、库存变化推到微信。没填 token 就只能在本页看结果。</div>
      <label class="chk"><input type="checkbox" id="pEn" ${p.enabled ? 'checked' : ''}> 开启推送</label>
      <label class="fld"><span>PushPlus token</span>
        <input id="pToken" value="${esc(p.token || '')}" placeholder="在 pushplus.plus 登录后复制"></label>
      <label class="chk"><input type="checkbox" id="pFail" ${p.on_fail ? 'checked' : ''}> 抢兑失败也推送</label>
      <div class="sect">
        <h4>群发到群组（只发库存变化）</h4>
        <label class="fld"><span>群组编码</span>
          <input id="pTopic" value="${esc(p.topic || '')}" placeholder="留空 = 只私发给你自己"></label>
        <label class="chk"><input type="checkbox" id="pGs" ${p.group_stock !== false ? 'checked' : ''}> 库存变化也群发到群组</label>
        <label class="chk"><input type="checkbox" id="pGst" ${p.group_self_too !== false ? 'checked' : ''}> 群发之外，也私发我一份</label>
        <div class="muted" style="font-size:11.5px">抢兑成功/失败**永远不会**发到群里（卡片里有账号信息）。</div>
      </div>
      <div class="msg" id="pMsg"></div>
      <div class="foot">
        <button class="btn btn-g" id="pTest">发送测试</button>
        <span class="sp"></span>
        <button class="btn btn-s" onclick="APP.closeModal()">取消</button>
        <button class="btn btn-p" id="pOk">保存</button>
      </div>`);
    const collect = () => ({
      push: {
        enabled: $('#pEn').checked, token: $('#pToken').value.trim(),
        on_fail: $('#pFail').checked, topic: $('#pTopic').value.trim(),
        group_stock: $('#pGs').checked, group_self_too: $('#pGst').checked,
      },
    });
    $('#pOk').onclick = async () => {
      const j = await api('/api/settings', collect());
      if (j.ok) { S.me.settings = j.settings; closeModal(); toast('已保存', 'ok'); }
    };
    $('#pTest').onclick = async () => {
      const m = $('#pMsg'); m.className = 'msg'; m.textContent = '';
      busy($('#pTest'), true, '发送中…');
      await api('/api/settings', collect());
      try {
        const j = await api('/api/push/test', {});
        m.className = 'msg show ' + (j.ok ? 'ok' : 'err'); m.textContent = j.msg;
      } catch (e) { m.className = 'msg show err'; m.textContent = e.message; }
      busy($('#pTest'), false);
    };
  }

  /* ============================================================ 弹窗：库存监听 */
  function watchModal() {
    const w = (S.state || {}).watch || {};
    const s = (S.me.settings || {}).watch || {};
    modal(`
      <h3>库存监听</h3>
      <div class="desc">定时拉商品列表，发现「新品上架 / 补货」就通知你。商品墙也会跟着自动更新。</div>
      <div class="kv"><span class="k">当前状态</span>
        <span class="v">${w.running ? '<span class="tag ok">运行中</span>' : '<span class="tag wait">已关闭</span>'}</span></div>
      <div class="kv"><span class="k">已监听商品</span><span class="v">${w.tracked || 0} 件</span></div>
      <div class="kv"><span class="k">已通知次数</span><span class="v">${w.notified || 0}</span></div>
      <div class="kv"><span class="k">最近检查</span><span class="v">${esc(w.checked_at || '—')}</span></div>
      ${w.last_error ? `<div class="msg err show">${esc(w.last_error)}</div>` : ''}
      <div class="sect">
        <label class="fld"><span>检查间隔（秒，最小 5）</span>
          <input id="wInt" type="number" value="${esc(s.interval_sec || 30)}"></label>
        <label class="chk"><input type="checkbox" id="wNew" ${s.notify_new !== false ? 'checked' : ''}> 新品上架时通知</label>
        <label class="chk"><input type="checkbox" id="wRes" ${s.notify_restock !== false ? 'checked' : ''}> 补货时通知</label>
      </div>
      <div class="foot">
        <button class="btn btn-g" id="wOnce">立即检查一次</button>
        <span class="sp"></span>
        <button class="btn btn-s" id="wStop" ${w.running ? '' : 'disabled'}>关闭监听</button>
        <button class="btn btn-p" id="wStart">开启监听</button>
      </div>`);
    const save = async () => api('/api/settings', {
      watch: { interval_sec: +$('#wInt').value, notify_new: $('#wNew').checked, notify_restock: $('#wRes').checked },
    });
    $('#wStart').onclick = async () => {
      await save();
      const j = await api('/api/watch/start', { interval_sec: +$('#wInt').value });
      toast(j.msg, j.ok ? 'ok' : 'err'); closeModal(); refreshState();
    };
    $('#wStop').onclick = async () => {
      const j = await api('/api/watch/stop', {}); toast(j.msg, 'ok'); closeModal(); refreshState();
    };
    $('#wOnce').onclick = async () => {
      busy($('#wOnce'), true, '检查中…');
      await save();
      const j = await api('/api/watch/once', {});
      toast(j.msg, j.ok ? 'ok' : 'err'); busy($('#wOnce'), false); refreshState();
    };
  }

  /* ============================================================ 弹窗：每日答题 */
  async function answerModal() {
    modal(`<h3>每日答题</h3><div class="desc">正在取今日题目…</div>`);
    let j = null;
    try { j = await api('/api/answer/today'); } catch (e) { j = { ok: false, msg: e.message }; }
    if (!j.ok) {
      modal(`<h3>每日答题</h3><div class="msg err show">${esc(j.msg)}</div>
        <div class="foot"><button class="btn btn-s" onclick="APP.closeModal()">关闭</button></div>`);
      return;
    }
    const i = j.info;
    modal(`
      <h3>每日答题</h3>
      <div class="desc">看图片猜词。${i.answered ? '<b style="color:#0f9d58">今日已答对 ✓</b>' : '还有 ' + (i.remain == null ? '?' : i.remain) + ' 次机会'} · 当前余额 ${i.balance == null ? '—' : i.balance}</div>
      <div style="text-align:center;margin-bottom:14px">
        ${i.image_url ? `<img src="${esc(i.image_url)}" style="max-width:100%;border-radius:12px;border:1px solid var(--line)">` : '<div class="muted">今日题目没有图片</div>'}
      </div>
      <div class="muted" style="text-align:center;margin-bottom:14px">提示：${esc(j.hint || '—')}</div>
      ${i.answered ? '' : `<label class="fld"><span>你的答案</span><input id="aAns" placeholder="输入答案"></label>`}
      <div class="msg" id="aMsg"></div>
      <div class="foot">
        <button class="btn btn-s" onclick="APP.closeModal()">关闭</button>
        ${i.answered ? '' : '<button class="btn btn-p" id="aOk">提交答案</button>'}
      </div>`);
    const ok = $('#aOk');
    if (ok) ok.onclick = async () => {
      busy(ok, true, '提交中…');
      try {
        const r = await api('/api/answer/submit', { answer: $('#aAns').value.trim() });
        const m = $('#aMsg'); m.className = 'msg show ' + (r.kind === 'ok' ? 'ok' : 'err'); m.textContent = r.msg;
        busy(ok, false);
        if (r.kind === 'ok') setTimeout(() => { closeModal(); answerModal(); }, 1100);
      } catch (e) { busy(ok, false); toast(e.message, 'err'); }
    };
  }

  /* ============================================================ 管理后台 */
  function adminShell(inner) {
    const nav = [['codes', '兑换码'], ['users', '用户'], ['settings', '全局设置']];
    return `
    <div class="topbar"><div class="topbar-in">
      <div class="logo">管</div>
      <h1>管理后台<small>得物整点抢兑助手</small></h1>
      <div class="sp"></div>
      <span class="muted who">${esc((S.admin || {}).username || '')}</span>
      <a class="btn btn-s btn-sm" href="/">用户端</a>
      <button class="btn btn-s btn-sm" onclick="APP.adminLogout()">退出</button>
    </div></div>
    <div class="subbar"><div class="subbar-in">
      <div class="tabs">
        ${nav.map(([k, t]) => `<div class="tab ${S.adminTab === k ? 'on' : ''}" onclick="APP.adminGo('${k}')">${t}</div>`).join('')}
      </div>
    </div></div>
    <div class="wrap">${inner}</div>`;
  }

  async function bootAdmin() {
    try {
      // ★ 直接刷新 /admin 时前端没有管理员信息，必须先问一次后端是谁
      const me = await api('/api/admin/me');
      S.admin = me.admin;
      const o = await api('/api/admin/overview');
      S.adminData.overview = o.stats;
    } catch (e) {
      if (e.status === 401) return renderAdminLogin();
      throw e;
    }
    renderAdmin();
  }

  function renderAdmin() {
    const st = S.adminData.overview || {};
    const stats = `<div class="stats" style="margin-bottom:16px">
      <div class="stat red"><div class="n">${st.users || 0}</div><div class="l">用户数</div></div>
      <div class="stat blue"><div class="n">${st.tasks || 0}</div><div class="l">任务数</div></div>
      <div class="stat green"><div class="n">${st.success || 0}</div><div class="l">抢兑成功</div></div>
      <div class="stat"><div class="n">${st.fail || 0}</div><div class="l">抢兑失败</div></div>
      <div class="stat red"><div class="n">${st.codes || 0}</div><div class="l">兑换码总数</div></div>
      <div class="stat"><div class="n">${st.codes_used || 0}</div><div class="l">已使用</div></div>
    </div>`;
    const body = { codes: codesView, users: usersView, settings: settingsView }[S.adminTab]();
    $('#app').innerHTML = adminShell(stats + body);
    ({ codes: codesBind, users: usersBind, settings: settingsBind }[S.adminTab])();
    if (S.adminTab === 'codes') loadCodes();
    if (S.adminTab === 'users') loadUsers();
    if (S.adminTab === 'settings') loadSettings();
  }

  function codesView() {
    return `<div class="cardt">
      <h2>🎟 批量生成兑换码</h2>
      <div class="grid2">
        <label class="fld"><span>数量（1-500）</span><input id="cgCount" type="number" value="10"></label>
        <label class="fld"><span>每个码可创建任务数</span><input id="cgQuota" type="number" value="1"></label>
      </div>
      <div class="grid2">
        <label class="fld"><span>前缀</span><input id="cgPrefix" value="DW"></label>
        <label class="fld"><span>备注</span><input id="cgNote" placeholder="例如：10月活动 / 张三"></label>
      </div>
      <button class="btn btn-p" id="cgGo">生成</button>
      <button class="btn btn-s" id="cgExp" style="margin-left:8px">导出未使用的码</button>
      <div class="msg" id="cgMsg" style="margin-top:12px"></div>
    </div>
    <div class="cardt">
      <h2>兑换码列表 <span class="num" id="cCount">0</span></h2>
      <div class="row" style="margin-bottom:12px">
        <input id="cq" placeholder="搜索码 / 备注" style="max-width:240px">
        <select id="cs" style="max-width:150px">
          <option value="">全部状态</option><option value="unused">未使用</option>
          <option value="used">已使用</option><option value="disabled">已作废</option>
        </select>
        <button class="btn btn-s btn-sm" id="cfind">筛选</button>
      </div>
      <div id="codeBox"></div>
    </div>`;
  }
  function codesBind() {
    $('#cgGo').onclick = async () => {
      const btn = $('#cgGo'); busy(btn, true, '生成中…');
      try {
        const j = await api('/api/admin/codes/generate', {
          count: +$('#cgCount').value, quota: +$('#cgQuota').value,
          prefix: $('#cgPrefix').value.trim(), note: $('#cgNote').value.trim(),
        });
        const m = $('#cgMsg');
        if (!j.ok) { m.className = 'msg err show'; m.textContent = j.msg; }
        else {
          m.className = 'msg ok show';
          m.innerHTML = '已生成 ' + j.count + ' 个：<span class="mono">' + j.codes.slice(0, 5).join('  ') + (j.count > 5 ? ' …' : '') + '</span>';
          toast('已生成 ' + j.count + ' 个兑换码', 'ok');
          loadCodes(); bootAdmin();
        }
      } catch (e) { toast(e.message, 'err'); }
      busy(btn, false);
    };
    $('#cgExp').onclick = async () => {
      const j = await api('/api/admin/codes/export', { status: 'unused' });
      if (!j.text) { toast('没有未使用的码', 'err'); return; }
      const url = URL.createObjectURL(new Blob([j.text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'dewu-codes.txt'; a.click();
      URL.revokeObjectURL(url);
      toast('已导出 ' + j.count + ' 个', 'ok');
    };
    $('#cfind').onclick = () => loadCodes();
    $('#cq').onkeydown = (e) => { if (e.key === 'Enter') loadCodes(); };
  }
  async function loadCodes() {
    const box = $('#codeBox'); if (!box) return;
    box.innerHTML = '<div class="empty">加载中…</div>';
    const q = encodeURIComponent($('#cq') ? $('#cq').value.trim() : '');
    const s = $('#cs') ? $('#cs').value : '';
    let j;
    try { j = await api(`/api/admin/codes?q=${q}&status=${s}`); }
    catch (e) {
      box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>';
      if (e.status === 401) renderAdminLogin();
      return;
    }
    S.adminData.codes = j.codes;
    $('#cCount').textContent = j.total;
    if (!j.codes.length) { box.innerHTML = '<div class="empty"><div class="ico">🎟</div>没有兑换码，上面生成一批</div>'; return; }
    const tag = (x) => ({ unused: 'wait', used: 'ok', disabled: 'bad' }[x] || 'wait');
    const label = (x) => ({ unused: '未使用', used: '已使用', disabled: '已作废' }[x] || x);
    box.innerHTML = `<div class="tbl-wrap"><table><thead><tr>
      <th>兑换码</th><th>备注</th><th>配额</th><th>状态</th><th>绑定用户</th><th>创建/使用</th><th>操作</th>
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
  async function codeStatus(id, st) { await api(`/api/admin/codes/${id}/status`, { status: st }); toast('已更新', 'ok'); loadCodes(); }
  async function codeDel(id) { if (!confirm('删除这个兑换码？')) return; await api('/api/admin/codes/delete', { ids: [id] }); toast('已删除', 'ok'); loadCodes(); }

  function usersView() {
    return `<div class="cardt"><h2>👥 用户列表 <span class="num" id="uCount">0</span>
      <span class="sp"></span><button class="btn btn-s btn-sm" onclick="APP.loadUsers()">刷新</button></h2>
      <div id="userBox"></div></div>`;
  }
  function usersBind() { }
  async function loadUsers() {
    const box = $('#userBox'); if (!box) return;
    box.innerHTML = '<div class="empty">加载中…</div>';
    let j;
    try { j = await api('/api/admin/users'); }
    catch (e) {
      box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>';
      if (e.status === 401) renderAdminLogin();
      return;
    }
    $('#uCount').textContent = j.users.length;
    if (!j.users.length) { box.innerHTML = '<div class="empty"><div class="ico">👥</div>还没有用户登录过</div>'; return; }
    box.innerHTML = `<div class="tbl-wrap"><table><thead><tr>
      <th>#</th><th>手机号</th><th>备注</th><th>状态</th><th>任务/成功</th><th>监听</th><th>推送</th><th>最近登录</th><th>操作</th>
      </tr></thead><tbody>${j.users.map((u) => `<tr>
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
          <button class="btn btn-danger btn-sm" onclick="APP.userDel(${u.id})">删除</button>
        </div></td></tr>`).join('')}</tbody></table></div>`;
  }
  async function userStatus(id, st) { await api(`/api/admin/users/${id}/status`, { status: st }); toast('已更新', 'ok'); loadUsers(); bootAdmin(); }
  async function userKick(id) { const j = await api(`/api/admin/users/${id}/kick`, {}); toast(j.msg, 'ok'); }
  async function userDel(id) { if (!confirm('删除用户 #' + id + '？他的任务也会一起删除。')) return; await api(`/api/admin/users/${id}`, undefined, 'DELETE'); toast('已删除', 'ok'); loadUsers(); bootAdmin(); }

  function settingsView() {
    return `<div class="cardt"><h2>⚙️ 全局设置</h2>
      <div class="desc">活动 id 换批次、sign 失效时在这里改（用户端不用改）。</div>
      <div class="grid2">
        <label class="fld"><span>得物活动 id</span><input id="stAct">
          <div class="hint">当前活动编号，例如 20260917。拉列表失败且提示「活动不存在」时改这里。</div></label>
        <label class="fld"><span>列表接口 sign</span><input id="stSign"></label>
      </div>
      <label class="fld"><span>答题接口 sign</span><input id="stAsign"></label>
      <div class="grid2">
        <label class="fld"><span>用户数上限（0 = 不限）</span><input id="stMax" type="number"></label>
        <div>
          <label class="chk"><input type="checkbox" id="stNew"> 允许新用户登录（关闭后只有已存在的账号能登）</label>
          <label class="chk"><input type="checkbox" id="stCode"> 创建任务必须填兑换码</label>
        </div>
      </div>
      <div class="msg" id="stMsg"></div>
      <button class="btn btn-p" id="stOk">保存设置</button>
    </div>
    <div class="cardt"><h2>🔑 修改管理员密码</h2>
      <div class="grid2">
        <label class="fld"><span>原密码</span><input id="pwOld" type="password"></label>
        <label class="fld"><span>新密码（≥6 位）</span><input id="pwNew" type="password"></label>
      </div>
      <div class="msg" id="pwMsg"></div>
      <button class="btn btn-s" id="pwOk">修改密码</button>
    </div>`;
  }
  function settingsBind() {
    $('#stOk').onclick = async () => {
      const j = await api('/api/admin/settings', {
        dewu_activity: $('#stAct').value.trim(), dewu_sign: $('#stSign').value.trim(),
        dewu_answer_sign: $('#stAsign').value.trim(), max_users: +$('#stMax').value,
        allow_new_user: $('#stNew').checked, require_code_for_task: $('#stCode').checked,
      });
      const m = $('#stMsg'); m.className = 'msg show ok'; m.textContent = '已保存';
    };
    $('#pwOk').onclick = async () => {
      const r = await api('/api/admin/password', { old: $('#pwOld').value, new: $('#pwNew').value });
      const m = $('#pwMsg'); m.className = 'msg show ' + (r.ok ? 'ok' : 'err'); m.textContent = r.ok ? '已修改' : r.msg;
    };
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
  }
  function adminGo(k) { S.adminTab = k; renderAdmin(); }
  async function adminLogout() { await api('/api/admin/logout', {}); S.admin = null; renderAdminLogin(); }

  /* ============================================================ 启动 */
  async function boot() {
    try {
      const m = await api('/api/me');
      S.me = m.user; S.cfg = m.settings; S.global = m.global;
    } catch (e) {
      if (e.status === 401) { S.isAdmin ? renderAdminLogin() : renderLogin(); return; }
      throw e;
    }
    renderDashboard();
    await refreshState();
    renderProducts(true);
    startPoll();
  }

  async function logout() {
    stopPoll();
    await api('/api/logout', {});
    S.me = null; S.state = null; renderLogin();
  }

  window.addEventListener('DOMContentLoaded', () => {
    if (location.pathname.startsWith('/admin')) bootAdmin();
    else boot();
  });

  return {
    boot, logout, closeModal, pick, refreshList, probe, clearDone, delTask, runNow,
    clearLogView, watchModal, pushModal, answerModal,
    adminGo, adminLogout, loadUsers, userStatus, userKick, userDel,
    codeStatus, codeDel,
  };
})();
