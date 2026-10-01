import { fileToDataUrl } from './dataUrl'

const AVATAR_SIZE = 320
const MAX_AVATAR_FILE_BYTES = 12 * 1024 * 1024

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('头像图片无法读取，请换一张图片'))
    image.src = src
  })
}

/** 居中裁成 320px WebP，避免把手机原图直接塞进账号配置。 */
export async function prepareProfileAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件')
  if (file.size > MAX_AVATAR_FILE_BYTES) throw new Error('头像原图不能超过 12MB')

  const image = await loadImage(await fileToDataUrl(file))
  const side = Math.min(image.naturalWidth, image.naturalHeight)
  if (!side) throw new Error('头像图片尺寸无效')

  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_SIZE
  canvas.height = AVATAR_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器无法处理头像图片')

  ctx.drawImage(
    image,
    (image.naturalWidth - side) / 2,
    (image.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_SIZE,
    AVATAR_SIZE,
  )
  return canvas.toDataURL('image/webp', 0.84)
}
