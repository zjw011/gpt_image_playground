// 作品评论单独落盘，不塞进 gallery.json：评论增长速度远高于作品，
// 拆开后评论读写、审核或损坏恢复都不会拖累作品与图片元数据。
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { readDurableJson, writeDurableJson } from './durableJson.mjs'

const MAX_COMMENTS = 20_000
const MAX_PER_WORK = 500
const MAX_TEXT_LENGTH = 200
const COMMENT_COOLDOWN_MS = 10_000
const COMMENT_WINDOW_MS = 60 * 60 * 1000
const MAX_COMMENTS_PER_WINDOW = 30
const LINK_PATTERN = /(https?:\/\/|www\.|(?:^|\s)[a-z0-9-]+\.(?:com|cn|net|org|top|xyz)(?:[\s/]|$))/i
const HTML_PATTERN = /<\s*\/?\s*[a-z][^>]*>/i

let commentsFile = ''
let comments = []
let byId = new Map()
let visibleCountByWork = new Map()
const commentLog = new Map()

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeComment(input) {
  if (!isRecord(input)) return null
  const id = String(input.id ?? '').trim()
  const workId = String(input.workId ?? '').trim()
  const userId = String(input.userId ?? '').trim()
  const text = String(input.text ?? '').trim().slice(0, MAX_TEXT_LENGTH)
  if (!id || !workId || !userId || !text) return null
  return {
    id,
    workId,
    userId,
    userName: String(input.userName ?? '').trim().slice(0, 40) || '创作者',
    text,
    createdAt: Number.isFinite(input.createdAt) ? Math.max(0, Math.trunc(input.createdAt)) : 0,
    hidden: input.hidden === true,
    reports: Array.isArray(input.reports)
      ? input.reports.filter(isRecord).map((item) => ({
          userId: String(item.userId ?? '').trim(),
          at: Number.isFinite(item.at) ? Math.max(0, Math.trunc(item.at)) : 0,
        })).filter((item) => item.userId)
      : [],
  }
}

function index() {
  byId = new Map(comments.map((comment) => [comment.id, comment]))
  visibleCountByWork = new Map()
  for (const comment of comments) {
    if (comment.hidden) continue
    visibleCountByWork.set(comment.workId, (visibleCountByWork.get(comment.workId) ?? 0) + 1)
  }
}

function commit() {
  writeDurableJson(commentsFile, { version: 1, comments })
}

export function initGalleryComments(dir) {
  commentsFile = join(dir, 'gallery-comments.json')
  if (existsSync(commentsFile)) {
    const loaded = readDurableJson(commentsFile, '作品广场评论').value
    comments = Array.isArray(loaded.comments)
      ? loaded.comments.map(normalizeComment).filter(Boolean).slice(-MAX_COMMENTS)
      : []
  } else {
    comments = []
    commit()
  }
  commentLog.clear()
  index()
}

function toPublic(comment, viewerId, isAdmin) {
  return {
    id: comment.id,
    workId: comment.workId,
    // 路由层用稳定 userId 关联当前资料，发给浏览器前会移除。
    userId: comment.userId,
    userName: comment.userName,
    text: comment.text,
    createdAt: comment.createdAt,
    canDelete: Boolean(viewerId) && (isAdmin || comment.userId === viewerId),
    reportedByMe: Boolean(viewerId) && comment.reports.some((report) => report.userId === viewerId),
  }
}

export function countComments(workId) {
  return visibleCountByWork.get(workId) ?? 0
}

export function listComments(workId, { viewerId, isAdmin = false, offset = 0, limit = 20 } = {}) {
  const visible = comments
    .filter((comment) => comment.workId === workId && !comment.hidden)
    .sort((a, b) => b.createdAt - a.createdAt)
  const start = Math.max(0, Math.trunc(Number(offset) || 0))
  const size = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 20)))
  return {
    total: visible.length,
    offset: start,
    limit: size,
    comments: visible.slice(start, start + size).map((comment) => toPublic(comment, viewerId, isAdmin)),
  }
}

function validateText(value) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim()
  if (!text) return { error: '评论内容不能为空' }
  if (Array.from(text).length > MAX_TEXT_LENGTH) return { error: `评论最多 ${MAX_TEXT_LENGTH} 个字` }
  if (HTML_PATTERN.test(text)) return { error: '评论不支持 HTML 标签' }
  if (LINK_PATTERN.test(text)) return { error: '评论暂不支持网址链接' }
  return { text }
}

function checkRate(userId, now) {
  const stamps = (commentLog.get(userId) ?? []).filter((at) => now - at < COMMENT_WINDOW_MS)
  const latest = stamps.at(-1) ?? 0
  if (now - latest < COMMENT_COOLDOWN_MS) {
    return { status: 429, error: `评论太快了，请 ${Math.ceil((latest + COMMENT_COOLDOWN_MS - now) / 1000)} 秒后再试` }
  }
  if (stamps.length >= MAX_COMMENTS_PER_WINDOW) {
    return { status: 429, error: '一小时最多发布 30 条评论，请稍后再试' }
  }
  return { stamps }
}

export function createComment({ workId, userId, userName, text, now = Date.now() }) {
  if (!userId) return { ok: false, status: 403, error: '请先登录后再评论' }
  if (comments.length >= MAX_COMMENTS) return { ok: false, status: 409, error: '评论区已满，请联系管理员清理' }
  if (countComments(workId) >= MAX_PER_WORK) return { ok: false, status: 409, error: `每件作品最多保留 ${MAX_PER_WORK} 条评论` }
  const checked = validateText(text)
  if (checked.error) return { ok: false, status: 400, error: checked.error }
  const rate = checkRate(userId, now)
  if (rate.error) return { ok: false, ...rate }

  const comment = {
    id: `c-${now.toString(36)}-${randomBytes(3).toString('hex')}`,
    workId,
    userId,
    userName: String(userName ?? '').trim().slice(0, 40) || '创作者',
    text: checked.text,
    createdAt: now,
    hidden: false,
    reports: [],
  }
  comments.push(comment)
  rate.stamps.push(now)
  commentLog.set(userId, rate.stamps)
  index()
  commit()
  return { ok: true, comment: toPublic(comment, userId, false), total: countComments(workId) }
}

export function removeComment(commentId, { workId, userId, isAdmin = false } = {}) {
  const comment = byId.get(commentId)
  if (!comment) return { ok: false, status: 404, error: '评论不存在或已被删除' }
  if (workId && comment.workId !== workId) return { ok: false, status: 404, error: '评论不存在或已被删除' }
  if (!isAdmin && comment.userId !== userId) return { ok: false, status: 403, error: '只能删除自己的评论' }
  comments = comments.filter((item) => item.id !== commentId)
  index()
  commit()
  return { ok: true, workId: comment.workId, total: countComments(comment.workId) }
}

export function reportComment(commentId, { workId, userId, now = Date.now() } = {}) {
  const comment = byId.get(commentId)
  if (!comment || comment.hidden) return { ok: false, status: 404, error: '评论不存在或已被删除' }
  if (workId && comment.workId !== workId) return { ok: false, status: 404, error: '评论不存在或已被删除' }
  if (!userId) return { ok: false, status: 403, error: '请先登录后再举报' }
  if (comment.userId === userId) return { ok: false, status: 400, error: '不能举报自己的评论' }
  if (comment.reports.some((report) => report.userId === userId)) {
    return { ok: true, duplicated: true }
  }
  comment.reports.push({ userId, at: now })
  commit()
  return { ok: true, duplicated: false }
}

export function removeCommentsForWork(workId) {
  const before = comments.length
  comments = comments.filter((comment) => comment.workId !== workId)
  if (comments.length === before) return 0
  index()
  commit()
  return before - comments.length
}

export function listCommentsForAdmin({ status = 'reported', keyword = '', offset = 0, limit = 50 } = {}) {
  const term = String(keyword).trim().toLowerCase()
  const start = Math.max(0, Math.trunc(Number(offset) || 0))
  const size = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 50)))
  const filtered = comments
    .filter((comment) => status === 'all'
      || (status === 'hidden' ? comment.hidden : status === 'visible' ? !comment.hidden : comment.reports.length > 0))
    .filter((comment) => !term || comment.text.toLowerCase().includes(term) || comment.userName.toLowerCase().includes(term))
    .sort((a, b) => b.createdAt - a.createdAt)
  return {
    total: filtered.length,
    offset: start,
    limit: size,
    comments: filtered.slice(start, start + size).map((comment) => ({
      id: comment.id,
      workId: comment.workId,
      userName: comment.userName,
      text: comment.text,
      createdAt: comment.createdAt,
      hidden: comment.hidden,
      reports: comment.reports.length,
    })),
  }
}

export function setCommentHidden(commentId, hidden) {
  const comment = byId.get(commentId)
  if (!comment) return { ok: false, status: 404, error: '评论不存在或已被删除' }
  comment.hidden = hidden === true
  index()
  commit()
  return { ok: true, hidden: comment.hidden }
}
