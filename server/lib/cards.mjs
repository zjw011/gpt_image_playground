// 卡密：批量生成、状态流转、兑换核销。
//
// 商业模式是「管理员生成卡密 → 导出上传到自己的发卡网 → 用户买到卡密 → 前台兑换成积分」，
// 所以这里只需要管好「一张卡密面额多少、用没用、被谁用的」，
// 不需要对接任何支付平台——收款在站外完成，本站只认卡密。
//
// 与 credits.json 同样是**同步原子写**：卡密是有价凭证，丢了就是钱。
// 好在写频率极低（只在生成/兑换/作废时），全量重写完全无压力。

import { randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 卡密总量上限。
 * 5 万张 × 约 150 字节 ≈ 7MB，全量重写在几十毫秒内，仍然无感；
 * 再往上就该考虑换 SQLite 了，但那时候商业模式也早就不是"手改卡密"了。
 */
const MAX_CARDS = 50_000

/**
 * 无歧义字母表：去掉 I / O / 0 / 1，这四个字符在打印小票和手抄时最容易出错。
 * 卡密经常是用户对着屏幕手打的，少一次"输错了"就少一次售后。
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 每组 4 位，共 3 组：32^12 ≈ 1.15e18，配合兑换限流不可能被撞库。 */
const CODE_GROUPS = 3
const CODE_GROUP_LEN = 4
const CODE_PREFIX = 'GIP'

export const CARD_STATUSES = new Set(['unused', 'used', 'void'])

let cardsFile = ''
let cache = null
/** code -> card 的索引。卡密几乎全部操作都是"按码查"，用它把 O(n) 降到 O(1)。 */
let byCode = new Map()

function emptyCards() {
  return { version: 1, cards: [], batches: [], updatedAt: 0 }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toInt(value, fallback = 0) {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : fallback
}

function toCredits(value, fallback = 0) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(100_000_000, Math.max(0, Math.trunc(numeric)))
}

/** 用户手抄进来的卡密：忽略大小写、连字符和空格。少一处出错就少一次售后。 */
export function normalizeCardCode(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[\s-]/g, '')
}

function formatCode(body) {
  const groups = []
  for (let i = 0; i < body.length; i += CODE_GROUP_LEN) groups.push(body.slice(i, i + CODE_GROUP_LEN))
  return `${CODE_PREFIX}-${groups.join('-')}`
}

function randomCodeBody() {
  const chars = Array.from(
    { length: CODE_GROUPS * CODE_GROUP_LEN },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
  )
  return chars.join('')
}

function normalizeCard(input) {
  const record = isRecord(input) ? input : {}
  return {
    code: String(record.code ?? '').trim().toUpperCase(),
    credits: toCredits(record.credits),
    batch: String(record.batch ?? '').trim(),
    note: String(record.note ?? '').slice(0, 120),
    status: CARD_STATUSES.has(record.status) ? record.status : 'unused',
    createdAt: toInt(record.createdAt, Date.now()),
    usedAt: toInt(record.usedAt),
    usedBy: typeof record.usedBy === 'string' ? record.usedBy : '',
  }
}

function normalizeBatch(input, fallbackId) {
  const record = isRecord(input) ? input : {}
  return {
    id: String(record.id ?? fallbackId).trim() || fallbackId,
    credits: toCredits(record.credits),
    count: toInt(record.count),
    note: String(record.note ?? '').slice(0, 120),
    createdAt: toInt(record.createdAt, Date.now()),
  }
}

function normalizeCards(input) {
  const record = isRecord(input) ? input : {}
  const next = emptyCards()
  const seen = new Set()

  if (Array.isArray(record.cards)) {
    for (const item of record.cards) {
      const card = normalizeCard(item)
      // 空码和重复码直接丢弃：它们永远无法被兑换，留着只会让列表出现幽灵行。
      if (!card.code || seen.has(card.code)) continue
      seen.add(card.code)
      next.cards.push(card)
    }
  }

  const seenBatches = new Set()
  for (const [idx, item] of (Array.isArray(record.batches) ? record.batches : []).entries()) {
    const batch = normalizeBatch(item, `b-${idx + 1}`)
    if (seenBatches.has(batch.id)) continue
    seenBatches.add(batch.id)
    next.batches.push(batch)
  }

  next.updatedAt = toInt(record.updatedAt)
  return next
}

function rebuildIndex() {
  byCode = new Map(cache.cards.map((card) => [card.code, card]))
}

export function initCards(dataDir) {
  cardsFile = join(dataDir, 'cards.json')
  mkdirSync(dirname(cardsFile), { recursive: true })
  cache = existsSync(cardsFile)
    ? (() => {
        try {
          return normalizeCards(JSON.parse(readFileSync(cardsFile, 'utf-8')))
        } catch (err) {
          // 与积分账本同理：读坏了不清零，先备份再以空库启动，让管理员有机会人工抢救。
          console.error('卡密库读取失败，已备份为 cards.json.corrupt：', err)
          try {
            renameSync(cardsFile, `${cardsFile}.corrupt`)
          } catch {
            // 备份失败也继续，至少让服务能起来。
          }
          return emptyCards()
        }
      })()
    : emptyCards()
  rebuildIndex()
  return cache
}

function writeCardsFile() {
  if (!cardsFile || !cache) return
  const tmp = `${cardsFile}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(cache), { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, cardsFile)
}

function commit() {
  cache.updatedAt = Date.now()
  writeCardsFile()
}

// ===== 生成 =====

/**
 * 批量生成卡密。
 * 返回明文卡密数组——这是唯一一次能把明文交出去的机会（之后也能从库里读回来，
 * 因为卡密本身就是凭证，不需要像口令那样只存哈希）。
 */
export function generateCards(input = {}) {
  const credits = toCredits(input.credits)
  const count = toInt(input.count)
  if (credits <= 0) throw new Error('卡密面额必须大于 0')
  if (count <= 0) throw new Error('生成数量必须大于 0')
  if (count > 2000) throw new Error('单批最多生成 2000 张，避免一次误操作灌爆卡密库')
  if (cache.cards.length + count > MAX_CARDS) {
    throw new Error(`卡密总数上限为 ${MAX_CARDS} 张，请先清理已作废的卡密`)
  }

  const now = Date.now()
  const batchId = `b-${now.toString(36)}-${randomInt(1000, 9999)}`
  const note = String(input.note ?? '').slice(0, 120)
  const created = []

  for (let i = 0; i < count; i += 1) {
    // 冲突概率极低（32^12 之一），但真撞上了也不能发出两张一样的码。
    let code = formatCode(randomCodeBody())
    let attempts = 0
    while (byCode.has(code) && attempts < 10) {
      code = formatCode(randomCodeBody())
      attempts += 1
    }
    const card = {
      code,
      credits,
      batch: batchId,
      note,
      status: 'unused',
      createdAt: now,
      usedAt: 0,
      usedBy: '',
    }
    cache.cards.push(card)
    byCode.set(card.code, card)
    created.push(card.code)
  }

  cache.batches.push({ id: batchId, credits, count, note, createdAt: now })
  // 批次也只留最近的，早期批次不影响任何业务。
  if (cache.batches.length > 200) cache.batches.splice(0, cache.batches.length - 200)

  commit()
  return { batchId, credits, count, codes: created }
}

// ===== 兑换 =====

/**
 * 核销一张卡密。
 * 返回具体原因而不是布尔值：前台要把"已被使用"和"已作废"分开告诉用户，
 * 否则他只会反复重试同一张卡。
 */
export function redeemCard(rawCode, userId) {
  const code = normalizeCardCode(rawCode)
  if (!code) return { ok: false, reason: 'empty', message: '请输入卡密' }

  const card = byCode.get(code) ?? cache.cards.find((item) => normalizeCardCode(item.code) === code)
  if (!card) return { ok: false, reason: 'not-found', message: '卡密不存在，请核对后重试' }
  if (card.status === 'void') return { ok: false, reason: 'void', message: '该卡密已被作废' }
  if (card.status === 'used') {
    return { ok: false, reason: 'used', message: `该卡密已于 ${formatTime(card.usedAt)} 被使用` }
  }
  if (!userId) return { ok: false, reason: 'no-user', message: '请先登录后再兑换' }

  card.status = 'used'
  card.usedAt = Date.now()
  card.usedBy = userId
  commit()
  return { ok: true, credits: card.credits, code: card.code, batch: card.batch }
}

function formatTime(at) {
  if (!at) return '未知时间'
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 兑换失败时不要消耗掉用户的机会，但作废/删除这类管理动作需要能回滚吗？不需要，是不可逆操作。 */
export function voidCards(codes) {
  const wanted = new Set((Array.isArray(codes) ? codes : []).map(normalizeCardCode).filter(Boolean))
  if (!wanted.size) return { changed: 0 }
  let changed = 0
  for (const card of cache.cards) {
    const normalized = normalizeCardCode(card.code)
    if (!wanted.has(normalized) || card.status !== 'unused') continue
    card.status = 'void'
    changed += 1
  }
  if (changed) commit()
  return { changed }
}

export function restoreCards(codes) {
  const wanted = new Set((Array.isArray(codes) ? codes : []).map(normalizeCardCode).filter(Boolean))
  if (!wanted.size) return { changed: 0 }
  let changed = 0
  for (const card of cache.cards) {
    const normalized = normalizeCardCode(card.code)
    if (!wanted.has(normalized) || card.status !== 'void') continue
    card.status = 'unused'
    changed += 1
  }
  if (changed) commit()
  return { changed }
}

/** 只允许删除未使用的卡密。已兑换的是财务凭证，必须留在库里。 */
export function deleteCards(codes) {
  const wanted = new Set((Array.isArray(codes) ? codes : []).map(normalizeCardCode).filter(Boolean))
  if (!wanted.size) return { removed: 0, skipped: 0 }

  const kept = []
  let removed = 0
  let skipped = 0
  for (const card of cache.cards) {
    const normalized = normalizeCardCode(card.code)
    if (!wanted.has(normalized)) {
      kept.push(card)
      continue
    }
    if (card.status === 'used') {
      skipped += 1
      kept.push(card)
      continue
    }
    removed += 1
  }
  cache.cards = kept
  rebuildIndex()
  if (removed) commit()
  return { removed, skipped }
}

/** 整个批次作废，用于"这批卡密印错了/发错了"的场景。 */
export function voidBatch(batchId) {
  let changed = 0
  for (const card of cache.cards) {
    if (card.batch !== batchId || card.status !== 'unused') continue
    card.status = 'void'
    changed += 1
  }
  if (changed) commit()
  return { changed }
}

export function deleteBatch(batchId) {
  const before = cache.cards.length
  cache.cards = cache.cards.filter((card) => card.batch !== batchId || card.status === 'used')
  const removed = before - cache.cards.length
  if (removed) {
    cache.batches = cache.batches.filter((batch) => batch.id !== batchId)
    rebuildIndex()
    commit()
  }
  return { removed }
}

// ===== 查询 =====

/**
 * 卡密列表。
 * 有筛选条件时全量扫描是可以接受的：5 万条内存里过滤是毫秒级，
 * 而分页参数在内存里切片，省掉一套索引维护。
 */
export function listCards(options = {}) {
  const status = CARD_STATUSES.has(options.status) ? options.status : ''
  const batch = String(options.batch ?? '').trim()
  const keyword = normalizeCardCode(options.keyword)
  const limit = Math.max(1, Math.min(500, toInt(options.limit, 100)))
  const offset = toInt(options.offset)

  const matched = cache.cards.filter((card) => {
    if (status && card.status !== status) return false
    if (batch && card.batch !== batch) return false
    if (keyword && !normalizeCardCode(card.code).includes(keyword)) return false
    return true
  })

  // 最新生成的排前面：后台最常看的是"我刚发出去的这批"。
  const ordered = [...matched].reverse()

  return {
    total: matched.length,
    limit,
    offset,
    cards: ordered.slice(offset, offset + limit).map((card) => ({ ...card })),
  }
}

/** 导出用：返回全部命中的卡密明文，不带分页。 */
export function exportCards(options = {}) {
  const status = CARD_STATUSES.has(options.status) ? options.status : ''
  const batch = String(options.batch ?? '').trim()
  return cache.cards
    .filter((card) => (!status || card.status === status) && (!batch || card.batch === batch))
    .map((card) => ({ code: card.code, credits: card.credits, batch: card.batch, status: card.status, note: card.note }))
}

export function listBatches() {
  const stats = new Map()
  for (const card of cache.cards) {
    const stat = stats.get(card.batch) ?? { total: 0, used: 0, unused: 0, voided: 0 }
    stat.total += 1
    if (card.status === 'used') stat.used += 1
    else if (card.status === 'void') stat.voided += 1
    else stat.unused += 1
    stats.set(card.batch, stat)
  }

  return [...cache.batches]
    .reverse()
    .map((batch) => ({
      ...batch,
      ...(stats.get(batch.id) ?? { total: 0, used: 0, unused: 0, voided: 0 }),
    }))
}

/** 后台概览：卡密库存与已兑付积分。 */
export function cardsOverview() {
  const counts = { total: cache.cards.length, unused: 0, used: 0, void: 0 }
  let redeemedCredits = 0
  let unusedCredits = 0
  for (const card of cache.cards) {
    if (card.status === 'used') {
      counts.used += 1
      redeemedCredits += card.credits
    } else if (card.status === 'void') {
      counts.void += 1
    } else {
      counts.unused += 1
      unusedCredits += card.credits
    }
  }
  return { ...counts, redeemedCredits, unusedCredits, batches: cache.batches.length }
}

/** 最近被兑换的卡密，后台首屏看"刚刚卖出去了几张"。 */
export function recentRedeems(limit = 20, userNames = new Map()) {
  return cache.cards
    .filter((card) => card.status === 'used')
    .sort((a, b) => b.usedAt - a.usedAt)
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map((card) => ({
      code: card.code,
      credits: card.credits,
      batch: card.batch,
      usedAt: card.usedAt,
      usedBy: card.usedBy,
      userName: userNames.get(card.usedBy) ?? '（已删除的用户）',
      exists: userNames.has(card.usedBy),
    }))
}
