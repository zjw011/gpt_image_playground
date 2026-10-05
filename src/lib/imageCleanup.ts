export type ImageCleanupStatus = 'cleaned' | 'partial' | 'unvalidated' | 'no_watermark'

export async function cleanVisibleWatermark(blob: Blob, signal?: AbortSignal) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw new Error('仅支持 PNG、JPG、WebP 静态图片')
  if (blob.size > 16 * 1024 * 1024) throw new Error('图片超过 16MB，请下载原图')
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = window.setTimeout(abort, 60_000)
  try {
    const response = await fetch('/api/image-cleanup', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob, signal: controller.signal })
    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error.error || '水印处理暂不可用')
    }
    const status = response.headers.get('X-Cleanup-Status') as ImageCleanupStatus
    if (!['cleaned', 'partial', 'unvalidated', 'no_watermark'].includes(status)) throw new Error('水印处理返回状态无效')
    const output = await response.blob()
    if (!output.size || output.size > 24 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(output.type)) throw new Error('水印处理返回图片无效')
    // 没有确认成功时保持原始字节，不把部分修复当成已去除。
    return { blob: status === 'cleaned' ? output : blob, status }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

export function imageCleanupMessage(status: ImageCleanupStatus) {
  if (status === 'cleaned') return '已处理可见 AI 水印，作品原图未修改；请检查修补区域'
  if (status === 'no_watermark') return '未识别到支持的可见 AI 水印，已下载原图'
  return '水印未能确认移除，已下载原图'
}
