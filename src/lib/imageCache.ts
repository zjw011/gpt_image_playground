import {
  CURRENT_THUMBNAIL_VERSION,
  getImage,
  getImageThumbnail,
  getStoredFreshImageThumbnail,
} from './db'
import { getPendingTaskImage } from './pendingTaskImages'

type ImageThumbnail = {
  dataUrl: string
  width?: number
  height?: number
  thumbnailVersion?: number
}

const imageCache = new Map<string, string>()
const thumbnailCache = new Map<string, ImageThumbnail>()
const thumbnailBackfillIds = new Map<string, 'visible' | 'background'>()
const thumbnailBackfillRunningIds = new Set<string>()
const thumbnailSubscribers = new Map<string, Set<(thumbnail: ImageThumbnail) => void>>()
let thumbnailBackfillScheduled = false

const MAX_IMAGE_CACHE_ENTRIES = 8
const MAX_THUMBNAIL_CACHE_ENTRIES = 80
const MAX_THUMBNAIL_BACKFILL_CONCURRENT = 4

export function getCachedImage(id: string): string | undefined {
  const dataUrl = imageCache.get(id)
  if (dataUrl) {
    imageCache.delete(id)
    imageCache.set(id, dataUrl)
  }
  return dataUrl
}

export function cacheImage(id: string, dataUrl: string) {
  imageCache.delete(id)
  imageCache.set(id, dataUrl)
  while (imageCache.size > MAX_IMAGE_CACHE_ENTRIES) {
    const oldestKey = imageCache.keys().next().value
    if (oldestKey == null) break
    imageCache.delete(oldestKey)
  }
}

export function deleteCachedImage(id: string) {
  imageCache.delete(id)
}

function getCachedThumbnail(id: string) {
  const thumbnail = thumbnailCache.get(id)
  if (thumbnail?.thumbnailVersion === CURRENT_THUMBNAIL_VERSION) {
    thumbnailCache.delete(id)
    thumbnailCache.set(id, thumbnail)
    return thumbnail
  }
  if (thumbnail) thumbnailCache.delete(id)
  return undefined
}

export function cacheThumbnail(id: string, thumbnail: ImageThumbnail) {
  if (thumbnail.thumbnailVersion !== CURRENT_THUMBNAIL_VERSION) return
  thumbnailCache.delete(id)
  thumbnailCache.set(id, thumbnail)
  while (thumbnailCache.size > MAX_THUMBNAIL_CACHE_ENTRIES) {
    const oldestKey = thumbnailCache.keys().next().value
    if (oldestKey == null) break
    thumbnailCache.delete(oldestKey)
  }
}

export function deleteImageCacheEntry(id: string) {
  imageCache.delete(id)
  thumbnailCache.delete(id)
  thumbnailBackfillIds.delete(id)
  thumbnailBackfillRunningIds.delete(id)
  thumbnailSubscribers.delete(id)
}

export function clearImageCaches() {
  imageCache.clear()
  thumbnailCache.clear()
  thumbnailBackfillIds.clear()
}

export async function ensureImageCached(id: string): Promise<string | undefined> {
  const pending = getPendingTaskImage(id)
  if (pending) return pending.dataUrl
  const cached = getCachedImage(id)
  if (cached) return cached
  const rec = await getImage(id)
  if (rec) {
    cacheImage(id, rec.dataUrl)
    return rec.dataUrl
  }
  return undefined
}

export async function ensureImageThumbnailCached(id: string): Promise<ImageThumbnail | undefined> {
  const cached = getCachedThumbnail(id)
  if (cached) return cached

  const rec = await getStoredFreshImageThumbnail(id)
  if (!rec?.thumbnailDataUrl) {
    scheduleThumbnailBackfill([id], 'visible')
    return undefined
  }

  const thumbnail = {
    dataUrl: rec.thumbnailDataUrl,
    width: rec.width,
    height: rec.height,
    thumbnailVersion: rec.thumbnailVersion,
  }
  cacheThumbnail(id, thumbnail)
  return thumbnail
}

export function subscribeImageThumbnail(id: string, callback: (thumbnail: ImageThumbnail) => void) {
  let subscribers = thumbnailSubscribers.get(id)
  if (!subscribers) {
    subscribers = new Set()
    thumbnailSubscribers.set(id, subscribers)
  }
  subscribers.add(callback)
  return () => {
    subscribers?.delete(callback)
    if (subscribers?.size === 0) thumbnailSubscribers.delete(id)
  }
}

export function scheduleThumbnailBackfill(ids: Iterable<string>, priority: 'visible' | 'background' = 'background') {
  for (const id of ids) {
    if (getCachedThumbnail(id) || thumbnailBackfillRunningIds.has(id)) continue
    const currentPriority = thumbnailBackfillIds.get(id)
    if (!currentPriority || priority === 'visible') thumbnailBackfillIds.set(id, priority)
  }
  scheduleThumbnailBackfillTick()
}

function scheduleThumbnailBackfillTick() {
  if (thumbnailBackfillScheduled || thumbnailBackfillIds.size === 0) return
  thumbnailBackfillScheduled = true

  const run = () => {
    thumbnailBackfillScheduled = false
    void processNextThumbnailBackfill()
  }

  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: 2_000 })
  } else {
    globalThis.setTimeout(run, 250)
  }
}

async function processNextThumbnailBackfill() {
  if (thumbnailBackfillRunningIds.size > 0) return
  const ids = getOrderedThumbnailBackfillIds().slice(0, MAX_THUMBNAIL_BACKFILL_CONCURRENT)
  for (const id of ids) {
    thumbnailBackfillIds.delete(id)
    thumbnailBackfillRunningIds.add(id)
  }
  // 先读小缩略图；只让确实过期的原图逐张解码，避免为估算并发反复读取大图。
  const stored = await Promise.allSettled(ids.map((id) => getStoredFreshImageThumbnail(id)))
  for (let idx = 0; idx < ids.length; idx++) {
    const result = stored[idx]
    await startThumbnailBackfill(ids[idx], result.status === 'fulfilled' ? result.value : undefined)
  }
  scheduleThumbnailBackfillTick()
}

function getOrderedThumbnailBackfillIds() {
  const visible: string[] = []
  const background: string[] = []
  for (const [id, priority] of thumbnailBackfillIds) {
    if (priority === 'visible') visible.push(id)
    else background.push(id)
  }
  return [...visible, ...background]
}

async function startThumbnailBackfill(id: string, stored?: Awaited<ReturnType<typeof getStoredFreshImageThumbnail>>) {
  thumbnailBackfillRunningIds.add(id)

  try {
    if (getCachedThumbnail(id)) return

    const thumbnail = stored ?? await getImageThumbnail(id)
    if (thumbnail?.thumbnailDataUrl) {
      cacheThumbnail(id, {
        dataUrl: thumbnail.thumbnailDataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
        thumbnailVersion: thumbnail.thumbnailVersion,
      })
      thumbnailSubscribers.get(id)?.forEach((callback) => callback({
        dataUrl: thumbnail.thumbnailDataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
      }))
    }
  } catch {
    // 缩略图生成失败时保留占位图，后续仍可再次补全。
  } finally {
    thumbnailBackfillRunningIds.delete(id)
    scheduleThumbnailBackfillTick()
  }
}
