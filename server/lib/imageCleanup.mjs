import { HttpError, sendJson } from './http.mjs'

const MAX_BYTES = 16 * 1024 * 1024
const users = new Map()
let active = 0

export async function handleImageCleanup(req, res, ctx) {
  const worker = process.env.GIP_WATERMARK_URL
  if (req.method === 'GET') return sendJson(res, 200, { available: Boolean(worker && ctx.user), reason: !ctx.user ? '请登录后使用' : !worker ? '本站未启用水印处理服务' : '' })
  if (req.method !== 'POST') throw new HttpError(405, '不支持的请求方法')
  if (!ctx.user) throw new HttpError(401, '请登录后使用水印处理')
  if (!worker) throw new HttpError(503, '水印处理服务未启用，可以下载原图')
  const type = String(req.headers['content-type'] || '').split(';')[0]
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new HttpError(415, '仅支持 PNG、JPG、WebP 静态图片')
  if (Number(req.headers['content-length']) > MAX_BYTES) throw new HttpError(413, '图片超过 16MB，请下载原图')
  const now = Date.now()
  for (const [id, value] of users) if (!value.active && now - value.at > 60_000) users.delete(id)
  const user = users.get(ctx.user.id) || { at: now, count: 0, active: false }
  if (user.active || active >= 2) throw new HttpError(429, '水印处理繁忙，请稍后再试或下载原图')
  if (now - user.at > 60_000) {
    user.at = now
    user.count = 0
  }
  if (user.count >= 12 || users.size >= 4096 && !users.has(ctx.user.id)) throw new HttpError(429, '操作过于频繁，请稍后再试')
  user.count++
  user.active = true
  users.set(ctx.user.id, user)
  active++
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 55_000)
  const close = () => { if (!res.writableEnded) controller.abort() }
  const uploadTimeout = () => req.destroy(new Error('图片上传超时'))
  res.on('close', close)
  req.on('timeout', uploadTimeout)
  req.setTimeout(15_000)
  try {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      if (controller.signal.aborted) throw new HttpError(408, '图片上传超时')
      size += chunk.length
      if (size > MAX_BYTES) throw new HttpError(413, '图片超过 16MB，请下载原图')
      chunks.push(chunk)
    }
    req.setTimeout(0)
    if (!size) throw new HttpError(400, '图片不能为空')
    const response = await fetch(new URL('/clean', worker), { method: 'POST', headers: { 'Content-Type': type }, body: Buffer.concat(chunks), signal: controller.signal, redirect: 'error' })
    if (!response.ok) throw new HttpError(response.status === 422 ? 422 : 503, response.status === 422 ? '此图片无法安全处理，请下载原图' : '水印处理暂不可用，请下载原图')
    const status = response.headers.get('X-Cleanup-Status')
    if (!['cleaned', 'partial', 'unvalidated', 'no_watermark'].includes(status)) throw new Error('水印处理返回状态无效')
    const outputType = response.headers.get('content-type')
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(outputType)) throw new Error('水印处理返回格式无效')
    const output = []
    let outputSize = 0
    for await (const chunk of response.body) {
      outputSize += chunk.length
      if (outputSize > 24 * 1024 * 1024) {
        controller.abort()
        throw new Error('水印处理输出过大')
      }
      output.push(chunk)
    }
    if (!outputSize) throw new Error('水印处理返回空图片')
    res.writeHead(200, { 'Content-Type': outputType, 'Content-Length': outputSize, 'Cache-Control': 'no-store', 'X-Cleanup-Status': status, 'X-Content-Type-Options': 'nosniff' })
    res.end(Buffer.concat(output))
  } catch (err) {
    if (err instanceof HttpError) throw err
    console.warn('可见水印处理失败：', err.message)
    throw new HttpError(503, '水印处理失败或超时，请下载原图')
  } finally {
    clearTimeout(timer)
    res.off('close', close)
    req.setTimeout(0)
    req.off('timeout', uploadTimeout)
    user.active = false
    active--
  }
}
