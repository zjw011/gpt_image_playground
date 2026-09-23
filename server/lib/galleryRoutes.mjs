// 作品广场路由。挂在 guestRoutes 的门禁**之前**：浏览是公开的，写操作才要登录。
//
//   GET    /api/gallery             公开列表
//   GET    /api/gallery/:id/image   公开图片（内容不可变，可长缓存）
//   POST   /api/gallery             发布（需登录账号）
//   POST   /api/gallery/:id/like    点赞/取消（需登录账号）
//   DELETE /api/gallery/:id         删除（作者本人或管理员）
//
// 发布的请求体是 base64 图片（可达数 MB），超出 readJsonBody 的 4MB 限制，
// 所以这里用 readRawBody 自己收字节自己解析。
import { HttpError, readRawBody, sendJson, sendError } from './http.mjs'
import { sendFile } from './staticFiles.mjs'
import { listWorks, publishWork, toggleLike, removeWork, getImagePath } from './gallery.mjs'

/** 写操作一律校验同源：发布/点赞/删除都能改公开数据，不能被外站表单借用。 */
function assertSameOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return
  const origin = req.headers.origin
  if (!origin) return
  const host = req.headers.host
  try {
    if (new URL(origin).host !== host) throw new HttpError(403, '跨站请求已被拒绝')
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(403, 'Origin 头无效')
  }
}

/** 发布/点赞/删除都要求真实账号：开放模式和共享口令模式下没有身份，不开放这些操作。 */
function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(403, '请先登录后再使用作品广场')
  return ctx.user
}

export async function handleGalleryRoute(req, res, ctx) {
  const path = ctx.path
  const method = req.method ?? 'GET'
  const viewerId = ctx.user?.id ?? null

  try {
    // ===== 公开：列表 =====
    if (path === '/api/gallery' && method === 'GET') {
      return sendJson(res, 200, { items: listWorks(viewerId) })
    }

    // ===== 公开：图片 =====
    const imageMatch = path.match(/^\/api\/gallery\/([^/]+)\/image$/)
    if (imageMatch && method === 'GET') {
      const found = getImagePath(decodeURIComponent(imageMatch[1]))
      // 内容一旦发布不会变，长缓存既省流量也不影响更新（新图是新 id）
      if (found) {
        sendFile(res, found.path, {
          cacheControl: 'public, max-age=31536000, immutable',
          headers: { 'Content-Type': found.mime },
        })
        return
      }
      return sendJson(res, 404, { error: '作品不存在或已被删除' })
    }

    // ===== 以下全是写操作：同源 + 登录 =====
    assertSameOrigin(req)

    if (path === '/api/gallery' && method === 'POST') {
      const user = requireUser(ctx)
      const raw = readRawBody(req, 16 * 1024 * 1024)
      let body
      try {
        body = JSON.parse((await raw).toString('utf-8'))
      } catch {
        throw new HttpError(400, '请求体不是合法的 JSON')
      }
      const result = publishWork({
        ownerId: user.id,
        ownerName: user.wechatNickname || user.displayName || user.username,
        prompt: String(body.prompt ?? ''),
        model: String(body.model ?? ''),
        imageDataUrl: String(body.image ?? ''),
      })
      if (!result.ok) throw new HttpError(400, result.error)
      return sendJson(res, 200, { ok: true, item: result.item, duplicated: Boolean(result.duplicated) })
    }

    const likeMatch = path.match(/^\/api\/gallery\/([^/]+)\/like$/)
    if (likeMatch && method === 'POST') {
      const user = requireUser(ctx)
      const result = toggleLike(decodeURIComponent(likeMatch[1]), user.id)
      if (!result.ok) throw new HttpError(404, result.error)
      return sendJson(res, 200, { ok: true, liked: result.liked, likes: result.likes })
    }

    const deleteMatch = path.match(/^\/api\/gallery\/([^/]+)$/)
    if (deleteMatch && method === 'DELETE') {
      const user = requireUser(ctx)
      const result = removeWork(decodeURIComponent(deleteMatch[1]), { userId: user.id, isAdmin: ctx.role === 'admin' })
      if (!result.ok) throw new HttpError(403, result.error)
      return sendJson(res, 200, { ok: true })
    }

    return sendJson(res, 404, { error: '未找到' })
  } catch (error) {
    if (error instanceof HttpError) return sendError(res, error.status, error.message, error.extra)
    console.error('[gallery] 请求处理失败：', error)
    return sendError(res, 502, error instanceof Error ? error.message : '服务器内部错误')
  }
}
