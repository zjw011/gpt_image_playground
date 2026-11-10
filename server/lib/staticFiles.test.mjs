// 回归测试：/admin 的资源请求必须真的命中文件，缺失的资源不能回退成 index.html。
// 曾经因为 SPA 回退兜住了 /admin.js，浏览器拿到一份 200 的 HTML，页面永远停在「正在加载」。

import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, get } from 'node:http'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

import { serveStatic } from './staticFiles.mjs'

/** 造一个最小站点目录：index.html + admin.js + assets/app.js */
function createRoot() {
  const root = mkdtempSync(join(tmpdir(), 'gip-static-'))
  writeFileSync(join(root, 'index.html'), '<!DOCTYPE html><body>index</body>')
  writeFileSync(join(root, 'admin.js'), 'console.log(1)')
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(2)')
  return root
}

/** 收集 writeHead 的状态码与响应头，正文不关心。 */
function createRes() {
  const res = {
    status: 0,
    headers: {},
    writeHead: vi.fn((status, headers) => {
      res.status = status
      res.headers = headers ?? {}
    }),
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    end: vi.fn(),
    write: vi.fn(() => true),
  }
  return res
}

describe('serveStatic', () => {
  const root = createRoot()

  it('压缩文本资源、尊重禁用编码，HEAD不发送正文', async () => {
    const source = 'const message = "hello world"\n'.repeat(1000)
    writeFileSync(join(root, 'large.js'), source)
    const server = createServer((req, res) => serveStatic(res, root, '/large.js', { req }))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      for (const [encoding, method] of [['br, gzip', 'GET'], ['gzip', 'GET'], ['br;q=0, gzip;q=0', 'GET'], ['br', 'HEAD']]) {
        const result = await new Promise((resolve, reject) => {
          get({ hostname: '127.0.0.1', port: server.address().port, method, headers: { 'Accept-Encoding': encoding } }, (res) => {
            const chunks = []
            res.on('data', (chunk) => chunks.push(chunk))
            res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
          }).on('error', reject)
        })
        if (method === 'HEAD') { expect(result.body.length).toBe(0); continue }
        const kind = result.headers['content-encoding']
        const decoded = kind === 'br' ? brotliDecompressSync(result.body) : kind === 'gzip' ? gunzipSync(result.body) : result.body
        expect(decoded.toString()).toBe(source)
        if (kind) expect(result.body.length).toBeLessThan(source.length / 2)
        else expect(encoding).toContain('q=0')
        expect(result.headers.vary).toBe('Accept-Encoding')
      }
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('serves an existing asset with its own mime type', () => {
    const res = createRes()
    expect(serveStatic(res, root, '/admin.js', { spaFallback: true })).toBe(true)
    expect(res.status).toBe(200)
    expect(res.headers['Content-Type']).toBe('text/javascript; charset=utf-8')
  })

  it('does not fall back to index.html for a missing asset', () => {
    const res = createRes()
    expect(serveStatic(res, root, '/missing.js', { spaFallback: true })).toBe(false)
    expect(res.writeHead).not.toHaveBeenCalled()
  })

  it('falls back to index.html for extensionless routes', () => {
    const res = createRes()
    expect(serveStatic(res, root, '/some/deep/route', { spaFallback: true })).toBe(true)
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8')
  })

  it('serves index.html for the root path', () => {
    const res = createRes()
    expect(serveStatic(res, root, '/', { spaFallback: true })).toBe(true)
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8')
    expect(res.headers['Referrer-Policy']).toBe('no-referrer')
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff')
  })

  it('marks hashed assets as immutable', () => {
    const res = createRes()
    expect(serveStatic(res, root, '/assets/app.js', { spaFallback: true })).toBe(true)
    expect(res.headers['Cache-Control']).toBe('public, max-age=31536000, immutable')
  })

  it('rejects traversal without falling back to index.html', () => {
    for (const path of ['/../package.json', '/%2e%2e%2fpackage.json', '/..%5Cpackage.json']) {
      const res = createRes()
      expect(serveStatic(res, root, path, { spaFallback: true })).toBe(false)
      expect(res.writeHead).not.toHaveBeenCalled()
    }
  })
})
