import type { ClipboardEvent } from 'react'

export function getPastedImages(data: DataTransfer | null): File[] {
  if (!data) return []
  const files = Array.from(data.files).filter((file) => file.type.startsWith('image/'))
  if (files.length) return files
  return Array.from(data.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

export function pasteImages(event: ClipboardEvent, upload: (files: File[]) => Promise<void>) {
  const files = getPastedImages(event.clipboardData)
  if (!files.length || event.defaultPrevented) return
  event.preventDefault()
  event.stopPropagation()
  void upload(files)
}

export async function readClipboardImages(): Promise<File[]> {
  if (!window.isSecureContext || !navigator.clipboard?.read) {
    throw new Error('当前浏览器无法直接读取剪贴板，请点击上传区域后按 Ctrl+V（Mac：⌘V），或选择本地图片')
  }
  const items = await navigator.clipboard.read()
  const files: File[] = []
  for (const item of items) {
    const type = item.types.find((type) => type.startsWith('image/'))
    if (!type) continue
    const blob = await item.getType(type)
    files.push(new File([blob], `clipboard-${files.length + 1}.${type.split('/')[1]}`, { type }))
  }
  if (!files.length) throw new Error('剪贴板里没有图片，请先复制图片本身或截图；图片链接不能直接粘贴为图片')
  return files
}
