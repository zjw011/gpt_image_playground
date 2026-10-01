// 作品广场路由。挂在 guestRoutes 的门禁**之前**：浏览是公开的，写操作才要登录。
//
//   GET    /api/gallery             公开列表
//   GET    /api/gallery/:id/image   公开图片（内容不可变，可长缓存）
//   GET    /api/gallery/:id/comments 公开评论
//   POST   /api/gallery             发布（需登录账号）
//   POST   /api/gallery/:id/like    点赞/取消（需登录账号）
//   POST   /api/gallery/:id/comments 发布评论（需登录账号）
//   DELETE /api/gallery/:id         删除（作者本人或管理员）
//
// 发布的请求体是 base64 图片（可达数 MB），超出 readJsonBody 的 4MB 限制，
// 所以这里用 readRawBody 自己收字节自己解析。
import { HttpError, readJsonBody, readRawBody, sendJson, sendError } from './http.mjs'
import { sendFile } from './staticFiles.mjs'
import { listWorks, publishWork, toggleLike, removeWork, getImagePath, hasWork } from './gallery.mjs'
import { createComment, listComments, removeComment, reportComment } from './galleryComments.mjs'
import { getConfig } from './store.mjs'

function currentProfiles() {
  return new Map(getConfig().users.map((user) => [user.id, {
    name: user.displayName || user.wechatNickname || user.username,
    avatar: user.avatar
      ? `/api/gallery/avatars/${encodeURIComponent(user.id)}?v=${user.updatedAt}`
      : user.wechatAvatar || '',
  }]))
}

function withCurrentOwner(item, profiles) {
  const profile = profiles.get(item.ownerId)
  return {
    ...item,
    ownerName: profile?.name || item.ownerName,
    ownerAvatar: profile?.avatar || '',
  }
}

function withCurrentCommentAuthor(comment, profiles) {
  const profile = profiles.get(comment.userId)
  const { userId, ...publicComment } = comment
  return {
    ...publicComment,
    userName: profile?.name || comment.userName,
    userAvatar: profile?.avatar || '',
  }
}

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
      const profiles = currentProfiles()
      return sendJson(res, 200, { items: listWorks(viewerId).map((item) => withCurrentOwner(item, profiles)) })
    }

    // 自定义头像存在配置文件里，单独返回图片，避免同一段 Base64 在每件历史作品里重复下发。
    const avatarMatch = path.match(/^\/api\/gallery\/avatars\/([^/]+)$/)
    if (avatarMatch && method === 'GET') {
      const userId = decodeURIComponent(avatarMatch[1])
      const avatar = getConfig().users.find((user) => user.id === userId)?.avatar ?? ''
      const matched = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(avatar)
      if (!matched) return sendJson(res, 404, { error: '头像不存在' })
      const bytes = Buffer.from(matched[2], 'base64')
      res.writeHead(200, {
        'Content-Type': matched[1],
        'Content-Length': bytes.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(bytes)
      return
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

    const commentsMatch = path.match(/^\/api\/gallery\/([^/]+)\/comments$/)
    if (commentsMatch && method === 'GET') {
      const workId = decodeURIComponent(commentsMatch[1])
      if (!hasWork(workId)) return sendJson(res, 404, { error: '作品不存在或已被删除' })
      const query = new URLSearchParams(ctx.search ?? '')
      const result = listComments(workId, {
        viewerId,
        isAdmin: ctx.role === 'admin',
        offset: query.get('offset'),
        limit: query.get('limit'),
      })
      const profiles = currentProfiles()
      return sendJson(res, 200, {
        ...result,
        comments: result.comments.map((comment) => withCurrentCommentAuthor(comment, profiles)),
      })
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
        ownerName: user.displayName || user.wechatNickname || user.username,
        title: body.title,
        caption: body.caption,
        prompt: String(body.prompt ?? ''),
        model: String(body.model ?? ''),
        imageDataUrl: String(body.image ?? ''),
      })
      if (!result.ok) throw new HttpError(400, result.error)
      const item = withCurrentOwner(result.item, currentProfiles())
      return sendJson(res, 200, { ok: true, item, duplicated: Boolean(result.duplicated) })
    }

    const likeMatch = path.match(/^\/api\/gallery\/([^/]+)\/like$/)
    if (likeMatch && method === 'POST') {
      const user = requireUser(ctx)
      const result = toggleLike(decodeURIComponent(likeMatch[1]), user.id)
      if (!result.ok) throw new HttpError(404, result.error)
      return sendJson(res, 200, { ok: true, liked: result.liked, likes: result.likes })
    }

    if (commentsMatch && method === 'POST') {
      const user = requireUser(ctx)
      const workId = decodeURIComponent(commentsMatch[1])
      if (!hasWork(workId)) throw new HttpError(404, '作品不存在或已被删除')
      const body = await readJsonBody(req)
      const result = createComment({
        workId,
        userId: user.id,
        userName: user.displayName || user.wechatNickname || user.username,
        text: body.text,
      })
      if (!result.ok) throw new HttpError(result.status, result.error)
      return sendJson(res, 201, {
        ...result,
        comment: withCurrentCommentAuthor(result.comment, currentProfiles()),
      })
    }

    const commentActionMatch = path.match(/^\/api\/gallery\/([^/]+)\/comments\/([^/]+)(?:\/(report))?$/)
    if (commentActionMatch && method === 'POST' && commentActionMatch[3] === 'report') {
      const user = requireUser(ctx)
      const result = reportComment(decodeURIComponent(commentActionMatch[2]), {
        workId: decodeURIComponent(commentActionMatch[1]),
        userId: user.id,
      })
      if (!result.ok) throw new HttpError(result.status, result.error)
      return sendJson(res, 200, result)
    }
    if (commentActionMatch && method === 'DELETE' && !commentActionMatch[3]) {
      const user = requireUser(ctx)
      const result = removeComment(decodeURIComponent(commentActionMatch[2]), {
        workId: decodeURIComponent(commentActionMatch[1]),
        userId: user.id,
        isAdmin: ctx.role === 'admin',
      })
      if (!result.ok) throw new HttpError(result.status, result.error)
      return sendJson(res, 200, result)
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
