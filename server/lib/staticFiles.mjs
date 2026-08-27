// 静态文件服务：托管 Vite 构建产物与后台管理页。
// SPA 回退到 index.html，构建资源（/assets/）走长缓存。

import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'

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
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stats.size,
    'Cache-Control': options.cacheControl ?? 'no-cache',
    ...(options.headers ?? {}),
  })
  createReadStream(filePath).pipe(res)
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
  sendFile(res, indexPath, { cacheControl: 'no-store' })
  return true
}
