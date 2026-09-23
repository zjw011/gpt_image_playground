// 审计脚本共用的"自带 dev server"。
//
// 为什么要自起：以前审计脚本让开发者手动先跑 npm run dev，结果 dev server 早就退出了，
// 脚本还对着 5173 一通点击/截图，把"连接不上"报成一堆业务断言失败（或者更糟：全都
// 落在首页却全部 PASS）。自己起、自己关，就再也不会出现这种假信号。
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 起一个 vite dev server 并等它就绪。
 *
 * 用 vite dev（而不是 dist 产物）是有意的：vite 走源码，没有构建缓存，
 * 能测到"刚改完还没构建"的状态；托管模式的审计交给 audit-server.mjs。
 * @param {object} options
 * @param {number} options.port 端口，多个脚本并行时别撞
 * @param {string} [options.root] 项目根目录，默认脚本所在目录的上一级
 */
export async function startDevServer({ port, root } = {}) {
  const ROOT = root ?? resolve(import.meta.dirname, '..', '..')
  const url = `http://127.0.0.1:${port}`
  const child = spawn(
    process.execPath,
    [join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore' },
  )

  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return {
          url,
          stop: async () => {
            child.kill()
            await sleep(400)
          },
        }
      }
    } catch {
      // 还没起来
    }
    await sleep(250)
  }

  child.kill()
  throw new Error(`dev server 未在 ${url} 就绪`)
}
