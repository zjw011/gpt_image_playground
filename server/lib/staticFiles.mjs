// 静态文件服务：托管 Vite 构建产物与后台管理页。
// SPA 回退到 index.html，构建资源（/assets/）走长缓存。

import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { createBrotliCompress, createGzip, constants } from 'node:zlib'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
}

/** 把 URL 路径解析成 root 内的真实文件路径，越界返回 null。 */
function resolveInside(root, urlPath) {
  const decoded = (() => {
    try {
      return decodeURIComponent(urlPath)
    } catch {
      return urlPath
    }
  })()
  // 反斜杠在 Windows 上也算分隔符，统一成 / 让两个平台的规范化结果一致。
  const target = resolve(join(root, normalize(decoded.replace(/\\/g, '/'))))
  const rootWithSep = resolve(root) + sep
  if (target !== resolve(root) && !target.startsWith(rootWithSep)) return null
  return target
}

export function sendFile(res, filePath, options = {}) {
  const stats = statSync(filePath)
  const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  const compressible = stats.size >= 1024 && /^(?:text\/|application\/(?:json|manifest\+json)|image\/svg)/.test(type)
  const accepted = String(options.req?.headers['accept-encoding'] ?? '').split(',').map((part) => {
    const [encoding, ...params] = part.trim().split(';')
    const quality = params.find((value) => value.trim().startsWith('q='))
    return { encoding: encoding.toLowerCase(), quality: quality ? Number(quality.trim().slice(2)) : 1 }
  }).filter((entry) => entry.quality > 0 && (entry.encoding === 'br' || entry.encoding === 'gzip'))
    .sort((a, b) => b.quality - a.quality || Number(b.encoding === 'br') - Number(a.encoding === 'br'))
  const encoding = compressible ? accepted[0]?.encoding : undefined
  res.writeHead(200, {
    'Content-Type': type,
    ...(encoding ? { 'Content-Encoding': encoding } : { 'Content-Length': stats.size }),
    ...(compressible ? { Vary: 'Accept-Encoding' } : {}),
    'Cache-Control': options.cacheControl ?? 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...(options.headers ?? {}),
  })
  if (options.req?.method === 'HEAD') {
    res.end()
    return
  }
  const source = createReadStream(filePath)
  const compressed = encoding === 'br'
    ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
    : encoding === 'gzip' ? createGzip() : null
  const fail = (error) => { source.destroy(); compressed?.destroy(); res.destroy?.(error) }
  source.on('error', fail)
  compressed?.on('error', fail)
  res.once('close', () => { source.destroy(); compressed?.destroy() })
  if (compressed) source.pipe(compressed).pipe(res)
  else source.pipe(res)
}

/**
 * 尝试从 root 提供 urlPath 对应的文件。
 * 命中返回 true；未命中且 spaFallback 为真时返回 index.html。
 */
export function serveStatic(res, root, urlPath, options = {}) {
  const filePath = resolveInside(root, urlPath === '/' ? '/index.html' : urlPath)
  // 越界路径不给 SPA 回退，避免把探测行为伪装成正常访问。
  if (!filePath) return false

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    const isHashedAsset = urlPath.startsWith('/assets/')
    sendFile(res, filePath, {
      req: options.req,
      cacheControl: isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    return true
  }

  if (!options.spaFallback) return false

  // 带扩展名的路径是资源请求，缺失时不能回退成 index.html：
  // 否则 <script src> 会拿到一份 200 的 HTML，浏览器只报 MIME 错误，排查起来极其误导。
  if (extname(filePath)) return false

  const indexPath = join(root, 'index.html')
  if (!existsSync(indexPath)) return false
  sendFile(res, indexPath, { cacheControl: 'no-store', req: options.req })
  return true
}
