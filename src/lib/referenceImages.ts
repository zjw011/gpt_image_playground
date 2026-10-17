import { canvasToBlob, loadImage } from './canvasImage'
import { blobToDataUrl } from './dataUrl'
import { getDataUrlDecodedByteSize } from './imageApiShared'

// 本地读取保护与请求副本的兼容性目标，不代表每个绘图服务的上传上限。
export const MAX_REFERENCE_FILE_BYTES = 50 * 1024 * 1024
export const REFERENCE_IMAGE_TARGET_BYTES = 4 * 1024 * 1024
const REFERENCE_IMAGE_MAX_EDGE = 2560

export function assertReferenceFileSize(bytes: number) {
  if (bytes > MAX_REFERENCE_FILE_BYTES) {
    throw new Error(`参考图片过大（${(bytes / 1024 / 1024).toFixed(1)} MB），单张上传上限为 50 MB。请压缩或缩小图片后重新上传。`)
  }
}

/** 只处理请求副本，不能写回原图或改动已有遮罩的坐标。 */
export async function prepareReferenceImages(dataUrls: string[], maskDataUrl?: string): Promise<string[]> {
  if (maskDataUrl) return dataUrls
  const prepared: string[] = []
  // 顺序解码避免多张手机原图同时占用大量 Canvas 内存。
  for (const dataUrl of dataUrls) {
    const mime = /^data:(image\/(?:jpeg|png|webp));base64,/i.exec(dataUrl)?.[1].toLowerCase()
    if (!mime || getDataUrlDecodedByteSize(dataUrl) <= REFERENCE_IMAGE_TARGET_BYTES) {
      prepared.push(dataUrl)
      continue
    }
    const image = await loadImage(dataUrl)
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('参考图片无法读取，请换一张有效图片')
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, REFERENCE_IMAGE_MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight))
    try {
      for (let attempt = 0; attempt < 7; attempt++) {
        const ratio = scale * 0.8 ** attempt
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio))
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio))
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('当前浏览器无法压缩参考图片，请手动缩小图片后重新上传')
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
        // PNG/WebP 可能带透明区域，不能转成 JPEG 后出现黑底。
        const blob = await canvasToBlob(canvas, mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9)
        if (blob.size <= REFERENCE_IMAGE_TARGET_BYTES) {
          prepared.push(await blobToDataUrl(blob))
          break
        }
        if (attempt === 6) throw new Error('参考图片过大，自动压缩后仍无法提交。请缩小图片后重新上传。')
      }
    } finally {
      canvas.width = 0
      canvas.height = 0
    }
  }
  return prepared
}
