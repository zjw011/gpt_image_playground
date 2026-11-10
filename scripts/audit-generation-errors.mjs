// 生图失败专项：自带 Vite、隔离 Chrome 和本地合成素材，所有业务接口只走内存模拟。
import { launchChrome } from './lib/cdp.mjs'
import { startDevServer } from './lib/devServer.mjs'

let dev
let browser
let checked = 0
let failed = 0
const errors = []
const report = (label, ok) => {
  checked++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failed++
}

async function waitForText(text) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if ((await browser.text()).includes(text)) return
    await browser.sleep(100)
  }
  throw new Error(`页面未出现预期文案：${text}`)
}

try {
  dev = await startDevServer({ port: 5193 })
  browser = await launchChrome({ port: 9433, baseUrl: dev.url, onConsoleError: (line) => errors.push(line) })
  await browser.open('/studio')
  if (!await browser.waitFor('textarea', 15000)) throw new Error('创作页未就绪')
  report('初始创作页精确路由', await browser.url() === '/studio')

  const seeded = await browser.evaluate(`(async () => {
    const originalFetch = window.fetch
    window.failureAuditCalls = []
    window.failureAuditBlocked = []
    window.failureAuditDisabled = []
    window.failureAuditConfirms = []
    window.failureAuditVerdicts = ['content-policy', 'cancelled', 'rate-limit', 'skipped', 'ok']
    window.failureAuditBootstrap = {
      backendMode: true, initialized: true, authenticated: true, accessMode: 'open',
      user: { id: 'failure-audit-user', username: 'failure-audit', displayName: '审计用户', role: 'user' },
      site: { title: '绘想', allowGuestParamOverride: true }, channels: [], customProviders: [],
      credits: { enabled: true, costPerImage: 1, balance: 100, reserved: 0, available: 100, totalIn: 100, totalOut: 0, ledger: [] },
    }
    const json = (value) => Promise.resolve(new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }))
    window.fetch = function (input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
      if (url.pathname.startsWith('/api/')) {
        window.failureAuditCalls.push({ path: url.pathname, method })
        if (url.pathname === '/api/bootstrap' && method === 'GET') return json(window.failureAuditBootstrap)
        if (url.pathname === '/api/image-cleanup' && method === 'GET') return json({ available: false, reason: '专项审计不启用水印处理' })
        if (url.pathname === '/api/admin/state' && method === 'GET') return json({ initialized: true, authenticated: true, site: {}, channels: [], users: [], customProviders: [], credits: {}, wechat: {}, smtp: {} })
        if (url.pathname === '/api/admin/channels/audit' && method === 'POST') return json({ results: window.failureAuditVerdicts.map((verdict, idx) => ({ id: 'audit-' + idx, verdict })) })
        if (url.pathname === '/api/admin/channels/bulk-disable' && method === 'POST') {
          const ids = JSON.parse(String(init.body)).ids
          window.failureAuditDisabled.push(ids)
          return json({ disabled: ids, channels: [] })
        }
      }
      if (url.pathname.startsWith('/api/') || (url.protocol.startsWith('http') && url.origin !== location.origin)) {
        window.failureAuditBlocked.push({ url: url.href, method })
        return Promise.reject(new Error('生图错误审计禁止实际业务请求'))
      }
      return originalFetch.call(this, input, init)
    }
    window.confirm = (message) => { window.failureAuditConfirms.push(message); return true }
    const { loadBackendBootstrap, isBackendMode, getBackendUser } = await import('/src/lib/backend.ts')
    await loadBackendBootstrap()
    const store = await import('/src/store.ts')
    const { getAllTasks, getImage, putTask, storeImage } = await import('/src/lib/db.ts')
    const { DEFAULT_PARAMS } = await import('/src/types.ts')
    const canvas = document.createElement('canvas')
    canvas.width = 96
    canvas.height = 96
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#8b7cf6'
    ctx.fillRect(0, 0, 96, 96)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    const reference = await store.createInputImageFromFile(new File([blob], 'audit-reference.png', { type: 'image/png' }))
    const outputId = await storeImage(canvas.toDataURL('image/png'), 'generated')
    window.failureAuditReference = reference.id
    window.failureAuditOriginal = (await getImage(reference.id)).dataUrl
    window.failureAuditOutput = outputId
    const base = {
      prompt: '生图失败专项：保留原始描述和参考图', params: { ...DEFAULT_PARAMS, n: 2 },
      inputImageIds: [reference.id], outputImages: [], status: 'error', createdAt: Date.now(),
    }
    const policy = 'HTTP 403: {"error":{"code":"content_policy_violation","message":"Rejected"}}'
    const tasks = [
      { ...base, id: 'failure-audit-content', error: policy },
      { ...base, id: 'failure-audit-cancelled', error: '{"status":"cancelled"}' },
      { ...base, id: 'failure-audit-download', error: '图片已生成，但因服务商未允许跨域，图片链接下载失败。' },
      { ...base, id: 'failure-audit-partial', status: 'done', outputImages: [outputId], outputErrors: [{ requestIndex: 1, error: policy }] },
    ]
    for (const task of tasks) await putTask(task)
    store.useStore.getState().setTasks(await getAllTasks())
    window.failureAuditCalls = []
    return { count: store.useStore.getState().tasks.length, managedUser: isBackendMode() && getBackendUser()?.role === 'user' }
  })()`)
  report('历史失败记录持久化后读回', seeded.count === 4)
  report('使用普通用户托管视图', seeded.managedUser)

  const cases = [
    ['content', '内容未通过安全审核', ['本次内容未通过绘图服务的安全审核', '修改描述或更换参考图', '返回修改内容']],
    ['cancelled', '本次生成已取消', ['未提供明确原因', '仅凭取消状态无法判断是否涉及内容限制']],
    ['download', '暂未取回生成结果', ['未能取回有效图片', '暂时无法确认生成结果']],
    ['partial', '本次部分完成，已保留 1 张图片', ['本次内容未通过绘图服务的安全审核', '修改内容']],
  ]
  for (const [id, title, expected] of cases) {
    const path = `/result?task=failure-audit-${id}`
    // 使用真实路由切换，保留全程生效的接口拦截；任务数据来自 IndexedDB 的历史读取。
    await browser.evaluate(`(async () => { const { router } = await import('/src/router.tsx'); await router.navigate(${JSON.stringify(path)}) })()`)
    await waitForText(title)
    const text = await browser.text()
    report(`${id} 结果页精确路由`, await browser.url() === path)
    report(`${id} 显示具体原因和处理建议`, expected.every((value) => text.includes(value)))
    report(`${id} 不展示渠道归责或绝对免扣承诺`, !/渠道故障|所有渠道均失败|已尝试.*渠道|不会扣除积分|不扣积分|免扣/.test(text))
    report(`${id} 普通用户不暴露上游原始诊断`, !text.includes('content_policy_violation') && !text.includes('查看错误详情'))
    if (id !== 'partial') report(`${id} 积分说明以实际记录为准`, text.includes('积分结算请以「我的积分」记录为准'))
    if (id === 'download') report('旧下载错误不继续声称图片已生成', !text.includes('图片已生成') && !text.includes('服务商未允许跨域'))
    if (id === 'cancelled') report('只有取消状态不定性内容违规', !text.includes('内容未通过安全审核') && !text.includes('可能涉及成人'))
    if (id === 'partial') {
      if (!await browser.waitFor('img[data-image-id]', 15000)) throw new Error('部分完成结果未加载已有图片')
      report('部分完成保留已生成图片', await browser.evaluate(`(async () => { const img = document.querySelector('img[data-image-id]'); await img.decode(); return img.getAttribute('data-image-id') === window.failureAuditOutput && img.complete && img.naturalWidth > 0 })()`))
    } else {
      report(`${id} 无结果时禁用下载`, await browser.evaluate(`Array.from(document.querySelectorAll('button')).some((button) => button.innerText.trim() === '下载' && button.disabled)`))
    }
    for (const width of [1440, 390, 320]) {
      await browser.setViewport(width, 900)
      report(`${id} 结果页 ${width}px 无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
      if (id === 'content') report(`内容修改按钮 ${width}px 至少 44px`, await browser.evaluate(`Array.from(document.querySelectorAll('button')).some((button) => button.innerText.trim() === '返回修改内容' && button.getBoundingClientRect().height >= 44)`))
    }
    if (id !== 'content') continue
    report('点击返回修改内容', await browser.clickByText('返回修改内容') === 'clicked')
    if (!await browser.waitFor('textarea', 15000)) throw new Error('内容拒绝后未返回创作编辑器')
    report('内容拒绝返回图生图编辑精确路由', await browser.url() === '/studio?mode=image')
    report('返回修改保留描述、参考图和数量，原图未变', await browser.evaluate(`(async () => {
      const { useStore } = await import('/src/store.ts')
      const { getImage } = await import('/src/lib/db.ts')
      const state = useStore.getState()
      return state.prompt === '生图失败专项：保留原始描述和参考图' && state.params.n === 2
        && state.inputImages.length === 1 && state.inputImages[0].id === window.failureAuditReference
        && (await getImage(window.failureAuditReference)).dataUrl === window.failureAuditOriginal
    })()`))
    report('返回编辑没有触发绘图或积分 API', await browser.evaluate('window.failureAuditCalls.length === 0 && window.failureAuditBlocked.length === 0'))
    for (const width of [1440, 390, 320]) {
      await browser.setViewport(width, 900)
      report(`返回编辑 ${width}px 无横向溢出`, await browser.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
    }
  }
  report('查看结果仅查询下载能力，没有绘图、扣费或水印处理请求', await browser.evaluate(`window.failureAuditCalls.every((call) => call.path === '/api/image-cleanup' && call.method === 'GET') && window.failureAuditBlocked.length === 0`))

  // 管理员操作也仅命中内存响应，验证一键停用的实际请求名单而非重复实现筛选逻辑。
  await browser.setViewport(1440, 900)
  await browser.evaluate(`(async () => {
    window.failureAuditBootstrap.user.role = 'admin'
    const { router } = await import('/src/router.tsx')
    await router.navigate('/admin?tab=channels')
  })()`)
  await waitForText('深度自检')
  report('管理员渠道页精确路由', await browser.url() === '/admin?tab=channels')
  report('点击模拟深度自检', await browser.clickByText('深度自检') === 'clicked')
  await waitForText('因审核、取消、限流或跳过而未确认出图')
  report('未确认出图不弹停用确认、不发送停用请求', await browser.evaluate('window.failureAuditConfirms.length === 0 && window.failureAuditDisabled.length === 0'))
  report('未确认出图不冒充全部渠道成功', !(await browser.text()).includes('全部渠道都能出图'))
  await browser.evaluate(`window.failureAuditVerdicts = ['content-policy', 'cancelled', 'rate-limit', 'skipped', 'ok', 'auth', 'error']`)
  report('再次自检包含真正渠道故障', await browser.clickByText('深度自检') === 'clicked')
  await waitForText('已停用 2 条渠道')
  report('一键停用只提交真正故障的两个 ID', await browser.evaluate(`JSON.stringify(window.failureAuditDisabled) === JSON.stringify([['audit-5', 'audit-6']])`))
  report('所有非模拟业务请求均未触发', await browser.evaluate('window.failureAuditBlocked.length === 0'))
  report('无控制台错误', errors.length === 0)
  if (errors.length) console.log(errors)
  console.log(`生图错误专项结束：${checked} 项检查，${failed} 项失败。使用本地合成图、历史失败记录和内存接口，不调用真实绘图渠道；手机宽度不等同于真机验收。`)
} catch (err) {
  failed++
  console.error(err)
} finally {
  await browser?.close()
  await dev?.stop()
}
process.exitCode = failed ? 1 : 0
