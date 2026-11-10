import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let child
let base
let port

beforeAll(async () => {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const dir = mkdtempSync(join(tmpdir(), 'gip-request-boundary-'))
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: resolve(import.meta.dirname, '../..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), GIP_DATA_DIR: dir, GIP_DIST_DIR: dir },
    stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return } catch { /* 等待隔离服务启动。 */ }
    if (child.exitCode != null) throw new Error('隔离服务提前退出')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('隔离服务启动超时')
})

afterAll(async () => {
  if (!child || child.exitCode != null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await exited
})

it('畸形 Cookie/URL 仅影响当前请求，真实 Node 进程随后继续处理健康检查', async () => {
  expect((await fetch(`${base}/api/health`, { headers: { Cookie: 'gip_guest=%E0%A4%A' } })).status).toBe(200)
  const status = await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: 'http://[', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end()
  })
  expect(status).toBe(400)
  expect((await fetch(`${base}/api/health`)).status).toBe(200)
  expect(child.exitCode).toBeNull()
})
