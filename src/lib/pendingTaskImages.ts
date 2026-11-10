import type { StoredImage } from '../types'
import { storeImageWithSize } from './db'

// 浏览器存储失败时保留已生成的原图，直到用户保存成功或明确删除。
const pendingImages = new Map<string, StoredImage>()

export function rememberPendingTaskImage(image: StoredImage) {
  pendingImages.set(image.id, image)
}

export function getPendingTaskImage(id: string) {
  return pendingImages.get(id)
}

export function forgetPendingTaskImage(id: string) {
  pendingImages.delete(id)
}

export async function storeGeneratedImage(dataUrl: string) {
  try {
    return await storeImageWithSize(dataUrl, 'generated')
  } catch (err) {
    console.warn('生成图片暂存失败，原图保留在本页等待重试', err)
    const image: StoredImage = {
      id: `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      dataUrl,
      source: 'generated',
      createdAt: Date.now(),
    }
    rememberPendingTaskImage(image)
    return image
  }
}
