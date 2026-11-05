import { blobToDataUrl } from '../dataUrl'
import { storeImage } from '../db'
import { cacheImage } from '../imageCache'
import type { InputImage } from '../../types'
import type { CostumeItem, PoseItem } from './types'

/** 图库高清素材默认走对方在线站；本地有镜像时可改 VITE_TOOLS_GALLERY_ASSET_BASE。 */
export const TOOLS_ASSET_CDN = (import.meta.env.VITE_TOOLS_GALLERY_ASSET_BASE as string | undefined)?.replace(/\/$/, '')
  || 'https://ai-pose-gallery.anhao.app'

/** 同源代理前缀：开发由 Vite 转发，生产由 Node 服务转发，避免 fetch 参考图时 CORS 失败。 */
export const TOOLS_ASSET_PROXY = 'tools-assets'

export function resolveRouterBase(): string {
  // 与 routerBasename 一致：vite base 为 './' 时前端路由仍挂在站点根路径
  const base = import.meta.env.BASE_URL || '/'
  if (!base.startsWith('/')) return '/'
  return base.endsWith('/') ? base : `${base}/`
}

export function dataUrl(path: string): string {
  return `${resolveRouterBase()}tools-gallery/data/${path.replace(/^\/+/, '')}`
}

/** 展示用 URL：相对路径直连 CDN（img 不需要 CORS），绝对 URL 原样返回。 */
export function assetUrl(src: string): string {
  if (!src) return ''
  if (/^(data:|blob:)/i.test(src)) return src
  if (/^https?:\/\//i.test(src)) return src
  const clean = src.replace(/^\/+/, '')
  return `${TOOLS_ASSET_CDN}/${clean}`
}

/** 拉取成 InputImage 时用的同源地址，绕过 CDN CORS。 */
export function fetchableAssetUrl(src: string): string {
  if (!src) return ''
  if (/^(data:|blob:)/i.test(src)) return src
  if (/^https?:\/\//i.test(src)) {
    return `${resolveRouterBase()}api/tools-fetch?url=${encodeURIComponent(src)}`
  }
  const clean = src.replace(/^\/+/, '')
  return `${resolveRouterBase()}${TOOLS_ASSET_PROXY}/${clean}`
}

export function poseThumbPath(pose: PoseItem, useDepth = Boolean(pose.useDepth)): string {
  const raw = pose.缩略图
  if (pose.source === 'upload' || !useDepth || /^(data:|https?:\/\/)/i.test(raw)) return raw
  const clean = raw.replace(/^\/+/, '')
  if (clean.startsWith('thumbs/depth/')) return raw
  if (clean.startsWith('thumbs/')) {
    return `thumbs/depth/${clean.slice('thumbs/'.length).replace(/\.(jpe?g|png)$/i, '.webp')}`
  }
  return raw
}

export function poseImagePath(pose: PoseItem, useDepth = Boolean(pose.useDepth)): string {
  const raw = pose.原图 || pose.缩略图
  if (pose.source === 'upload' || !useDepth || /^(data:|https?:\/\/)/i.test(raw)) return raw
  const clean = raw.replace(/^\/+/, '')
  if (clean.startsWith('img/depth/')) return raw
  if (clean.startsWith('img/')) {
    return `img/depth/${clean.slice('img/'.length).replace(/\.(png|jpe?g)$/i, '.webp')}`
  }
  return raw
}

export function costumeImagePath(item: CostumeItem, preferOriginal = true): string {
  if (preferOriginal) return item.原图 || item.预览图 || item.缩略图
  return item.缩略图 || item.预览图 || item.原图
}

export async function createInputImageFromAsset(src: string): Promise<InputImage> {
  const url = fetchableAssetUrl(src)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`拉取参考图失败：HTTP ${res.status}`)
  const blob = await res.blob()
  if (!blob.type.startsWith('image/') && blob.size === 0) throw new Error('不是有效的图片')
  const dataUrl = await blobToDataUrl(blob, blob.type || 'image/png')
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  return { id, dataUrl }
}
