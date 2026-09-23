// 驱动本机 Chrome 的最小 DevTools 协议客户端，给审计脚本共用。
// 只做审计需要的那几件事：开页面、点元素、读文本、拿当前 URL，外加收集控制台报错。
// 不引第三方依赖——Chrome 自带远程调试端口，一个 WebSocket 就够。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 起一个无头 Chrome 并接上 CDP。
 * @param {object} options
 * @param {number} options.port CDP 端口，多个脚本同时跑时别撞
 * @param {string} [options.chromePath] 默认走系统装好的 Chrome，可用 CHROME_PATH 覆盖
 * @param {(line: string) => void} [options.onConsoleError] 页面里 console.error 的回调
 * @param {string} [options.baseUrl] 相对路径跳转时的基准地址
 */
export async function launchChrome({ port, chromePath, onConsoleError, baseUrl } = {}) {
  const chrome = chromePath || process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  const profileDir = mkdtempSync(join(tmpdir(), 'cdp-audit-'))
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    // 审计永远指向本机端口，绝不能被系统代理劫持——代理一挂，所有页面都会变成
    // chrome-error://chromewebdata/，脚本只会看到"标题是 127.0.0.1 的空页面"。
    '--no-proxy-server',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: 'ignore' })

  let socket
  let messageId = 1
  const pending = new Map()

  const waitForDevtools = async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (response.ok) return
      } catch {}
      await sleep(250)
    }
    throw new Error('Chrome DevTools 未就绪，请确认已安装 Chrome（可用 CHROME_PATH 指定路径）')
  }

  const send = (method, params) => {
    const id = messageId++
    socket.send(JSON.stringify({ id, method, params: params ?? {} }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }

  await waitForDevtools()
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (onConsoleError && message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      onConsoleError(message.params.args.map((arg) => arg.value || arg.description).join(' ').slice(0, 160))
    }
    const entry = message.id && pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result)
  }
  await send('Runtime.enable')

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }

  return {
    evaluate,
    sleep,
    /**
     * 等元素出现再继续。
     *
     * 为什么需要：vite 冷启动第一次访问要现场编译整个应用，几秒内 body 里什么都还没有。
     * 以前固定 sleep 一段时间的写法会把"首次加载慢"误报成"按钮不存在"，白白制造假失败。
     * @param {string} selector CSS 选择器
     * @param {number} [timeout] 毫秒，默认 8 秒
     */
    waitFor: async (selector, timeout = 8000) => {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        const found = await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)
        if (found) return true
        await sleep(200)
      }
      return false
    },
    /** @param {string} path 站内路径，会用 location.href 整页跳转（等价于直接输入地址） */
    open: async (path, wait = 2200) => {
      await evaluate(`location.href = ${JSON.stringify((baseUrl ?? '') + path)}`)
      await sleep(wait)
    },
    click: async (selector, wait = 1000) => {
      const state = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; el.click(); return 'clicked' })()`)
      await sleep(wait)
      return state
    },
    clickByText: async (label, wait = 1000) => {
      const state = await evaluate(`(() => { const el = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === ${JSON.stringify(label)}); if (!el) return 'missing'; el.click(); return 'clicked' })()`)
      await sleep(wait)
      return state
    },
    url: () => evaluate('location.pathname + location.search'),
    text: () => evaluate('document.body.innerText'),
    close: async () => {
      try { socket?.close() } catch {}
      child.kill()
      await sleep(300)
      try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
    },
  }
}
