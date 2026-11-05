// 专业工具参考图代理：浏览器同源拉图，避免跨域 CDN 无法 fetch 进 IndexedDB。
import { sendError, sendText } from './http.mjs'

const DEFAULT_CDN = 'https://ai-pose-gallery.anhao.app'
const ASSET_CDN = (process.env.TOOLS_GALLERY_ASSET_BASE || DEFAULT_CDN).replace(/\/$/, '')

const ALLOWED_FETCH_HOSTS = new Set([
  'ai-pose-gallery.anhao.app',
  'ai-costume-gallery.pages.dev',
  'ai-costume-anime-gallery.pages.dev',
  'ai-portrait-gallery.pages.dev',
  'charadb-2fi.pages.dev',
  'github.com',
  'raw.githubusercontent.com',
])

function isAllowedHost(hostname) {
  if (ALLOWED_FETCH_HOSTS.has(hostname)) return true
  // 允许用户自建镜像子域
  return hostname.endsWith('.anhao.app') || hostname.endsWith('.pages.dev')
}

async function proxyResponse(res, upstreamUrl) {
  const upstream = await fetch(upstreamUrl, {
    headers: { 'User-Agent': 'gpt-image-playground-tools-proxy/1.0' },
    redirect: 'follow',
  })
  if (!upstream.ok) {
    return sendText(res, upstream.status, `上游素材请求失败：HTTP ${upstream.status}`)
  }
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
  const buffer = Buffer.from(await upstream.arrayBuffer())
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(buffer)
}

/** /tools-assets/* → CDN 镜像 */
export async function handleToolsAssets(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, '方法不允许')
  }
  const rel = path.replace(/^\/tools-assets\/?/, '')
  if (!rel || rel.includes('..')) return sendError(res, 400, '非法路径')
  try {
    return await proxyResponse(res, `${ASSET_CDN}/${rel}`)
  } catch (err) {
    console.error('tools-assets 代理失败：', err)
    return sendError(res, 502, err instanceof Error ? err.message : '素材代理失败')
  }
}

/** /api/tools-fetch?url= → 白名单外链图片 */
export async function handleToolsFetch(req, res, search) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, '方法不允许')
  }
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const raw = params.get('url') || ''
  let target
  try {
    target = new URL(raw)
  } catch {
    return sendError(res, 400, 'url 无效')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return sendError(res, 400, '仅允许 http/https')
  }
  if (!isAllowedHost(target.hostname)) {
    return sendError(res, 403, `不允许代理该域名：${target.hostname}`)
  }
  try {
    return await proxyResponse(res, target.toString())
  } catch (err) {
    console.error('tools-fetch 代理失败：', err)
    return sendError(res, 502, err instanceof Error ? err.message : '素材代理失败')
  }
}
