// 作品广场：用户把生成好的作品上传到服务器，公开给所有访客浏览、点赞。
//
// 设计取舍：
// - 图片直接落盘（DATA_DIR/gallery/g-<id>.<ext>），元数据记在 gallery.json。
//   不进 config.json：广场是公开内容，跟"站点配置"不是一个生命周期。
// - 用内容的 sha256 去重：同一张图重复上传只算一件作品。
// - 点赞记 userId（一人一票，可取消）；未登录只能看。
// - 数量上限是防滥用的兜底（配合 rateLimit），满了先拒绝发布并提示清理。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { readDurableJson, writeDurableJson } from './durableJson.mjs'
import { countComments, removeCommentsForWork } from './galleryComments.mjs'

const MAX_ITEMS = 500
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_TITLE_LENGTH = 60
const MAX_CAPTION_LENGTH = 500
const LINK_PATTERN = /(https?:\/\/|www\.|(?:^|\s)[a-z0-9-]+\.(?:com|cn|net|org|top|xyz)(?:[\s/]|$))/i
const HTML_PATTERN = /<\s*\/?\s*[a-z][^>]*>/i
// 防滥用：公开站点任何人都能注册登录，上传口子必须有闸。
// 单人总量 30 件 + 每小时最多发 10 件，足以正常分享，又能挡住灌盘。
const MAX_PER_USER = 30
const PUBLISH_WINDOW_MS = 60 * 60 * 1000
const MAX_PUBLISH_PER_WINDOW = 10
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

// 两个目录分开放，别再混：
//   <数据目录>/gallery.json        元数据（作者、点赞、时间）
//   <数据目录>/gallery/<id>.<ext>  图片文件
// 之前两者都在 gallery/ 里，导致"读 A 写 B"外加孤儿清理把元数据自己删掉，
// 用户上传的作品每次重启都会丢。
let rootDir = ''
let imagesDir = ''
let items = []
let byId = new Map()
let byHash = new Map()
// 发布频率：内存滑窗计数即可，重启清零是可接受的（限流不是记账）
const publishLog = new Map()

function checkPublishRate(userId) {
  const now = Date.now()
  const stamps = (publishLog.get(userId) ?? []).filter((at) => now - at < PUBLISH_WINDOW_MS)
  if (stamps.length >= MAX_PUBLISH_PER_WINDOW) {
    const waitMinutes = Math.ceil((stamps[0] + PUBLISH_WINDOW_MS - now) / 60000)
    return `上传太频繁了，请约 ${waitMinutes} 分钟后再试`
  }
  stamps.push(now)
  publishLog.set(userId, stamps)
  return null
}

function file() {
  return join(rootDir, 'gallery.json')
}

function commit() {
  const payload = { version: 1, items }
  writeDurableJson(file(), payload)
}

function index() {
  byId = new Map(items.map((item) => [item.id, item]))
  byHash = new Map(items.filter((item) => item.hash).map((item) => [item.hash, item]))
}

// 内置精选作品：随站点分发的示例图（/art/*.jpg），任何部署首次启动就自动上架，
// 让广场公开可见、不至于空着。它们没有图片文件（staticPath 直指静态资源），不可被普通用户删除。
const SEED_WORKS = [
  { id: 'w-seed-train', staticPath: '/art/work-train.jpg', ownerName: '星野', title: '银河列车今晚会经过哪里', caption: '把一直想象的夜色画了出来，车窗里的暖光是我最喜欢的细节。', baseLikes: 1280, prompt: '星空下的列车，璀璨银河，车窗暖光，新海诚风格', daysAgo: 6 },
  { id: 'w-seed-seaside', staticPath: '/art/work-seaside.jpg', ownerName: '蓝调', title: '海风刚好，她也刚好回头', caption: '粉蓝色的天空和远处的海鸥，是我心里最治愈的夏天。', baseLikes: 986, prompt: '海边少女回头微笑，粉蓝色天空，海鸥，唯美治愈', daysAgo: 5 },
  { id: 'w-seed-cyber', staticPath: '/art/work-cyber.jpg', ownerName: 'NightCity', title: '下雨后的霓虹城', caption: '路面的反光比霓虹灯牌更有故事感，想做一组完整的未来城市系列。', baseLikes: 2100, prompt: '赛博朋克城市夜景，霓虹灯牌，雨后街道倒影', daysAgo: 4 },
  { id: 'w-seed-cat', staticPath: '/art/work-cat.jpg', ownerName: '喵星人', title: '今天也是被猫咪治愈的一天', caption: '蓝眼睛和淡紫色蝴蝶结太搭了，像一位安静的小公主。', baseLikes: 2800, prompt: '布偶猫特写肖像，蓝眼睛，淡紫蝴蝶结，花瓣光斑', daysAgo: 3 },
  { id: 'w-seed-hanfu', staticPath: '/art/work-hanfu.jpg', ownerName: '古风小筑', title: '桃花深处见江南', caption: '柔和的晨光落在汉服上，这就是我想象中的春日江南。', baseLikes: 764, prompt: '汉服少女桃花树下，江南水乡，柔和晨光，国风插画', daysAgo: 2 },
  { id: 'w-seed-sakura', staticPath: '/art/work-sakura.jpg', ownerName: '春日部', title: '樱花落下的时候，春天就有了形状', caption: '透明雨伞、少女背影和满街花瓣，保存一个很轻的春日瞬间。', baseLikes: 1500, prompt: '春日樱花街道，透明雨伞少女背影，花瓣纷飞', daysAgo: 1 },
]

export function initGallery(dir) {
  rootDir = dir
  imagesDir = join(dir, 'gallery')
  mkdirSync(imagesDir, { recursive: true })
  const target = file()
  let recovered = false
  if (existsSync(target)) {
    const loaded = readDurableJson(target, '作品广场元数据')
    recovered = loaded.recovered
    items = Array.isArray(loaded.value.items) ? loaded.value.items.filter(isRecord) : []
  } else {
    // 首次启动：播种精选作品，广场一上线就有内容、对所有人可见
    const now = Date.now()
    items = SEED_WORKS.map((seed) => ({
      id: seed.id,
      staticPath: seed.staticPath,
      file: '',
      hash: '',
      bytes: 0,
      prompt: seed.prompt,
      title: seed.title,
      caption: seed.caption,
      model: '',
      ownerId: 'system',
      ownerName: seed.ownerName,
      baseLikes: seed.baseLikes,
      likedBy: [],
      createdAt: now - seed.daysAgo * 86_400_000,
      seed: true,
    }))
    commit()
  }
  // 旧版已播种的精选作品没有帖子标题与正文，原地补齐，不重新播种也不改 ID。
  const seeds = new Map(SEED_WORKS.map((seed) => [seed.id, seed]))
  const needsSeedCopy = items.some((item) => seeds.has(item.id) && (!item.title || !item.caption))
  if (needsSeedCopy) {
    items = items.map((item) => {
      const seed = seeds.get(item.id)
      return seed ? { ...item, title: item.title || seed.title, caption: item.caption || seed.caption } : item
    })
    if (!recovered) commit()
  }
  index()
  // 备份可能比图片文件落后一个提交；恢复启动时保留孤儿，交给管理员核对后处理。
  if (recovered) return
  // 只有元数据成功载入后才清孤儿；解析失败会在上面终止启动，绝不拿空索引删图片。
  const known = new Set(items.map((item) => item.file).filter(Boolean))
  for (const name of readdirSync(imagesDir)) {
    // 只清理"我们生成的图片文件"这一种形态：名字对不上的一律不碰。
    // 否则元数据文件、.tmp 临时文件都会被它顺手删掉（这正是之前丢数据的原因之一）。
    if (!/^w-[a-z0-9-]+\.(png|jpg|webp)$/.test(name)) continue
    if (known.has(name)) continue
    try { unlinkSync(join(imagesDir, name)) } catch { /* 并发清理时可能已被删 */ }
  }
}

function isRecord(value) {
  return value && typeof value === 'object'
}

/** 公开投影：给列表/详情用，绝不含 ownerId 之外的隐私（本来也没有）。 */
function toPublic(item, viewerId) {
  const prompt = String(item.prompt ?? '').trim()
  return {
    id: item.id,
    title: String(item.title ?? '').trim() || Array.from(prompt).slice(0, 28).join('') || '分享一张新作品',
    caption: String(item.caption ?? '').trim(),
    prompt,
    model: item.model,
    ownerName: item.ownerName,
    ownerId: item.ownerId,
    likes: (item.baseLikes ?? 0) + item.likedBy.length,
    comments: countComments(item.id),
    likedByMe: viewerId ? item.likedBy.includes(viewerId) : false,
    createdAt: item.createdAt,
    // 精选作品直接引用随站点分发的内置图；用户上传的走图片接口
    imageUrl: item.staticPath ?? `/api/gallery/${item.id}/image`,
  }
}

/**
 * 发布作品。imageDataUrl 是前端从 IndexedDB 读出的原图 dataURL。
 * 返回 { ok, item | error }，错误都给人话，前端直接透出。
 */
export function publishWork({ ownerId, ownerName, title, caption, prompt, model, imageDataUrl }) {
  if (!ownerId) return { ok: false, error: '请先登录后再上传作品' }
  if (items.length >= MAX_ITEMS) return { ok: false, error: `作品广场已满（${MAX_ITEMS} 件），请联系管理员清理` }

  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(imageDataUrl ?? ''))
  if (!match) return { ok: false, error: '图片格式不支持，仅支持 PNG / JPG / WebP' }
  const [, mime, base64] = match
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.length) return { ok: false, error: '图片内容为空' }
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: '图片超过 8MB，无法上传' }

  const normalizedPrompt = String(prompt ?? '').trim().slice(0, 500)
  const normalizedTitle = String(title ?? '').replace(/\s+/g, ' ').trim() || Array.from(normalizedPrompt).slice(0, 28).join('') || '分享一张新作品'
  const normalizedCaption = String(caption ?? '').replace(/\r\n?/g, '\n').trim()
  if (Array.from(normalizedTitle).length > MAX_TITLE_LENGTH) return { ok: false, error: `标题最多 ${MAX_TITLE_LENGTH} 个字` }
  if (Array.from(normalizedCaption).length > MAX_CAPTION_LENGTH) return { ok: false, error: `正文最多 ${MAX_CAPTION_LENGTH} 个字` }
  if (HTML_PATTERN.test(normalizedTitle) || HTML_PATTERN.test(normalizedCaption)) return { ok: false, error: '发布文案不支持 HTML 标签' }
  if (LINK_PATTERN.test(normalizedTitle) || LINK_PATTERN.test(normalizedCaption)) return { ok: false, error: '发布文案暂不支持网址链接' }

  // 同一张图重复上传直接复用已有作品：不计频率、不占配额
  const hash = createHash('sha256').update(bytes).digest('hex')
  const existing = byHash.get(hash)
  if (existing) {
    return { ok: true, item: toPublic(existing, ownerId), duplicated: true }
  }

  // 防滥用两道闸：发布频率 + 单人总量
  const rateError = checkPublishRate(ownerId)
  if (rateError) return { ok: false, error: rateError }
  const ownedCount = items.filter((item) => item.ownerId === ownerId && !item.seed).length
  if (ownedCount >= MAX_PER_USER) {
    return { ok: false, error: `每个账号最多上传 ${MAX_PER_USER} 件作品，请先删除一些再试` }
  }

  const now = Date.now()
  const id = `w-${now.toString(36)}-${randomBytes(3).toString('hex')}`
  const fileName = `${id}.${EXT_BY_MIME[mime]}`
  const tmp = join(imagesDir, `${fileName}.tmp`)
  writeFileSync(tmp, bytes)
  renameSync(tmp, join(imagesDir, fileName))

  const item = {
    id,
    file: fileName,
    hash,
    bytes: bytes.length,
    mime,
    title: normalizedTitle,
    caption: normalizedCaption,
    prompt: normalizedPrompt,
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

export function hasWork(itemId) {
  return byId.has(itemId)
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
  // likes 口径与列表投影一致：基础点赞（精选作品自带）+ 真实点赞
  return { ok: true, liked: idx < 0, likes: (item.baseLikes ?? 0) + item.likedBy.length }
}

/** 删除：作者本人或管理员。删元数据 + 删文件 + 释放内容去重。 */
export function removeWork(itemId, { userId, isAdmin }) {
  const item = byId.get(itemId)
  if (!item) return { ok: false, error: '作品不存在或已被删除' }
  if (item.seed) return { ok: false, error: '精选作品不可删除' }
  if (!isAdmin && item.ownerId !== userId) return { ok: false, error: '只能删除自己的作品' }
  items = items.filter((candidate) => candidate.id !== itemId)
  index()
  try { unlinkSync(join(imagesDir, item.file)) } catch { /* 文件已不在就当删掉 */ }
  commit()
  removeCommentsForWork(itemId)
  return { ok: true }
}

export function getImagePath(itemId) {
  const item = byId.get(itemId)
  if (!item) return null
  const path = join(imagesDir, item.file)
  return existsSync(path) ? { path, mime: item.mime } : null
}
