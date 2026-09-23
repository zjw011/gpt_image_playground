// 作品广场：用户把生成好的作品上传到服务器，公开给所有访客浏览、点赞。
//
// 设计取舍：
// - 图片直接落盘（DATA_DIR/gallery/g-<id>.<ext>），元数据记在 gallery.json。
//   不进 config.json：广场是公开内容，跟"站点配置"不是一个生命周期。
// - 用内容的 sha256 去重：同一张图重复上传只算一件作品。
// - 点赞记 userId（一人一票，可取消）；未登录只能看。
// - 数量上限是防滥用的兜底（配合 rateLimit），满了先拒绝发布并提示清理。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const MAX_ITEMS = 500
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

let dataDir = ''
let items = []
let byId = new Map()
let byHash = new Map()

function file() {
  return join(dataDir, 'gallery.json')
}

function commit() {
  const payload = { version: 1, items }
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(payload))
  renameSync(tmp, file())
}

function index() {
  byId = new Map(items.map((item) => [item.id, item]))
  byHash = new Map(items.map((item) => [item.hash, item]))
}

export function initGallery(dir) {
  dataDir = join(dir, 'gallery')
  mkdirSync(dataDir, { recursive: true })
  const target = join(dir, 'gallery.json')
  if (existsSync(target)) {
    try {
      const parsed = JSON.parse(readFileSync(target, 'utf-8'))
      items = Array.isArray(parsed.items) ? parsed.items.filter(isRecord) : []
    } catch {
      // 元数据损坏就当空库处理：图片文件还在，不至于把服务起挂
      items = []
      console.error('[gallery] gallery.json 解析失败，已按空广场处理')
    }
  } else {
    items = []
  }
  index()
  // 元数据丢失时按文件名无法还原作者等信息，孤儿图片文件宁可清掉也不展示"无主"作品
  const known = new Set(items.map((item) => item.file))
  for (const name of readdirSync(dataDir)) {
    if (!known.has(name)) {
      try { unlinkSync(join(dataDir, name)) } catch { /* 并发清理时可能已被删 */ }
    }
  }
}

function isRecord(value) {
  return value && typeof value === 'object'
}

/** 公开投影：给列表/详情用，绝不含 ownerId 之外的隐私（本来也没有）。 */
function toPublic(item, viewerId) {
  return {
    id: item.id,
    prompt: item.prompt,
    model: item.model,
    ownerName: item.ownerName,
    ownerId: item.ownerId,
    likes: item.likedBy.length,
    likedByMe: viewerId ? item.likedBy.includes(viewerId) : false,
    createdAt: item.createdAt,
    imageUrl: `/api/gallery/${item.id}/image`,
  }
}

/**
 * 发布作品。imageDataUrl 是前端从 IndexedDB 读出的原图 dataURL。
 * 返回 { ok, item | error }，错误都给人话，前端直接透出。
 */
export function publishWork({ ownerId, ownerName, prompt, model, imageDataUrl }) {
  if (!ownerId) return { ok: false, error: '请先登录后再上传作品' }
  if (items.length >= MAX_ITEMS) return { ok: false, error: `作品广场已满（${MAX_ITEMS} 件），请联系管理员清理` }

  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(imageDataUrl ?? ''))
  if (!match) return { ok: false, error: '图片格式不支持，仅支持 PNG / JPG / WebP' }
  const [, mime, base64] = match
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.length) return { ok: false, error: '图片内容为空' }
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: '图片超过 8MB，无法上传' }

  const hash = createHash('sha256').update(bytes).digest('hex')
  const existing = byHash.get(hash)
  if (existing) {
    // 同一张图重复上传：直接复用已有作品，不占两份盘
    return { ok: true, item: toPublic(existing, ownerId), duplicated: true }
  }

  const now = Date.now()
  const id = `w-${now.toString(36)}-${randomBytes(3).toString('hex')}`
  const fileName = `${id}.${EXT_BY_MIME[mime]}`
  const tmp = join(dataDir, `${fileName}.tmp`)
  writeFileSync(tmp, bytes)
  renameSync(tmp, join(dataDir, fileName))

  const item = {
    id,
    file: fileName,
    hash,
    bytes: bytes.length,
    mime,
    prompt: String(prompt ?? '').slice(0, 500),
    model: String(model ?? '').slice(0, 80),
    ownerId: String(ownerId),
    ownerName: String(ownerName ?? '').slice(0, 40) || '匿名创作者',
    likedBy: [],
    createdAt: now,
  }
  items.push(item)
  index()
  commit()
  return { ok: true, item: toPublic(item, ownerId) }
}

/** 公开列表：广场不需要分页控件那么细，一页拉够（前端本地排序/搜索）。 */
export function listWorks(viewerId) {
  // 新作品排前面：广场的"新"就是流量
  return [...items].sort((a, b) => b.createdAt - a.createdAt).map((item) => toPublic(item, viewerId))
}

/** 点赞/取消点赞。返回当前状态，前端直接覆盖本地。 */
export function toggleLike(itemId, userId) {
  const item = byId.get(itemId)
  if (!item) return { ok: false, error: '作品不存在或已被删除' }
  if (!userId) return { ok: false, error: '请先登录后再点赞' }
  const idx = item.likedBy.indexOf(userId)
  if (idx >= 0) item.likedBy.splice(idx, 1)
  else item.likedBy.push(userId)
  commit()
  return { ok: true, liked: idx < 0, likes: item.likedBy.length }
}

/** 删除：作者本人或管理员。删元数据 + 删文件 + 释放内容去重。 */
export function removeWork(itemId, { userId, isAdmin }) {
  const item = byId.get(itemId)
  if (!item) return { ok: false, error: '作品不存在或已被删除' }
  if (!isAdmin && item.ownerId !== userId) return { ok: false, error: '只能删除自己的作品' }
  items = items.filter((candidate) => candidate.id !== itemId)
  index()
  try { unlinkSync(join(dataDir, item.file)) } catch { /* 文件已不在就当删掉 */ }
  commit()
  return { ok: true }
}

export function getImagePath(itemId) {
  const item = byId.get(itemId)
  if (!item) return null
  const path = join(dataDir, item.file)
  return existsSync(path) ? { path, mime: item.mime } : null
}
