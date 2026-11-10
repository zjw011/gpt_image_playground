// 专业工具参考图代理：只允许已知素材站的栅格图片，不能变成同源网页代理。
import { HttpError, sendError } from './http.mjs'

function assetCdn() {
  return (process.env.TOOLS_GALLERY_ASSET_BASE || 'https://ai-pose-gallery.anhao.app').replace(/\/$/, '')
}
const ALLOWED_FETCH_HOSTS = new Set([
  'ai-pose-gallery.anhao.app', 'ai-costume-gallery.pages.dev',
  'ai-costume-anime-gallery.pages.dev', 'ai-portrait-gallery.pages.dev',
  'charadb-2fi.pages.dev', 'github.com', 'raw.githubusercontent.com',
])
const MAX_ASSET_BYTES = 32 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])
let activeDownloads = 0

function validateTarget(url) {
  const configured = new URL(assetCdn())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new HttpError(400, '素材地址无效')
  // 自建镜像必须由管理员明确配置，不信任共享托管平台上的任意租户。
  if (url.origin !== configured.origin && (!ALLOWED_FETCH_HOSTS.has(url.hostname) || url.port)) throw new HttpError(403, '该素材域名未获授权')
}

async function proxyResponse(req, res, target) {
  validateTarget(target)
  if (activeDownloads >= 8) throw new HttpError(429, '素材下载繁忙，请稍后重试')
  activeDownloads += 1
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  timer.unref?.()
  const cancel = () => { if (!res.writableEnded) controller.abort() }
  res.once('close', cancel)
  try {
    let upstream
    let url = target
    for (let redirects = 0; redirects <= 4; redirects += 1) {
      validateTarget(url)
      upstream = await fetch(url, {
        method: req.method,
        headers: { 'User-Agent': 'gpt-image-playground-tools-proxy/1.0' },
        redirect: 'manual', signal: controller.signal,
      })
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break
      await upstream.body?.cancel()
      const location = upstream.headers.get('location')
      if (!location || redirects === 4) throw new HttpError(502, '素材重定向次数过多或地址缺失')
      url = new URL(location, url)
    }
    if (!upstream.ok) {
      await upstream.body?.cancel()
      throw new HttpError(502, `上游素材请求失败：HTTP ${upstream.status}`)
    }
    const contentType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (!IMAGE_TYPES.has(contentType)) {
      await upstream.body?.cancel()
      throw new HttpError(415, '素材代理仅支持 PNG、JPEG、WebP、GIF 和 AVIF 图片')
    }
    if (Number(upstream.headers.get('content-length')) > MAX_ASSET_BYTES) {
      await upstream.body?.cancel()
      throw new HttpError(413, '素材图片超过 32MB 限制')
    }
    const chunks = []
    let size = 0
    if (req.method !== 'HEAD' && upstream.body) {
      for await (const value of upstream.body) {
        size += value.byteLength
        if (size > MAX_ASSET_BYTES) throw new HttpError(413, '素材图片超过 32MB 限制')
        chunks.push(Buffer.from(value))
      }
    }
    if (res.destroyed) return
    res.writeHead(200, {
      'Content-Type': contentType,
      ...(req.method === 'HEAD' ? {} : { 'Content-Length': size }),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'public, max-age=86400',
    })
    res.end(req.method === 'HEAD' ? undefined : Buffer.concat(chunks, size))
  } finally {
    controller.abort()
    clearTimeout(timer)
    res.off('close', cancel)
    activeDownloads -= 1
  }
}

export async function handleToolsAssets(req, res, path) {
  if (!['GET', 'HEAD'].includes(req.method)) return sendError(res, 405, '方法不允许')
  const rel = path.replace(/^\/tools-assets\/?/, '')
  if (!rel || /\.\.|%2e|%2f|%5c|\\/i.test(rel)) return sendError(res, 400, '非法路径')
  try {
    return await proxyResponse(req, res, new URL(`${assetCdn()}/${rel}`))
  } catch (err) {
    if (res.destroyed) return
    return sendError(res, err instanceof HttpError ? err.status : 502, err instanceof HttpError ? err.message : '素材下载超时或失败')
  }
}

export async function handleToolsFetch(req, res, search) {
  if (!['GET', 'HEAD'].includes(req.method)) return sendError(res, 405, '方法不允许')
  let target
  try {
    target = new URL(new URLSearchParams(search).get('url') || '')
  } catch {
    return sendError(res, 400, 'url 无效')
  }
  try {
    return await proxyResponse(req, res, target)
  } catch (err) {
    if (res.destroyed) return
    return sendError(res, err instanceof HttpError ? err.status : 502, err instanceof HttpError ? err.message : '素材下载超时或失败')
  }
}
