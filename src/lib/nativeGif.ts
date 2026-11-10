import type { ApiProfile, TaskParams, TaskRecord } from '../types'
import { dataUrlToBytes } from './dataUrl'

export function supportsNativeGif(profile: Pick<ApiProfile, 'provider' | 'apiMode' | 'model'> & { supportsNativeGif?: boolean }): boolean {
  return profile.provider === 'openai' && profile.apiMode === 'images'
    && (profile.supportsNativeGif ?? /^gpt-image-2\.6-(?:sunburst|flare)(?:-|$)/i.test(profile.model.trim()))
}

export function isNativeGifTask(task: Pick<TaskRecord, 'params' | 'professionalPreset'>): boolean {
  return task.params.output_format === 'gif' || task.professionalPreset === 'live-gif'
}

export function normalizeNativeGifParams(params: TaskParams): TaskParams {
  if (params.output_format !== 'gif') return params
  const frames = typeof params.frame_count === 'number' && Number.isFinite(params.frame_count) ? params.frame_count : 9
  const duration = typeof params.frame_duration_ms === 'number' && Number.isFinite(params.frame_duration_ms) ? params.frame_duration_ms : 200
  return {
    ...params,
    n: 1,
    frame_count: Math.max(2, Math.min(16, Math.trunc(frames))),
    // GIF 的帧延时精度是 10 毫秒，界面、请求和重载后应使用同一数值。
    frame_duration_ms: Math.max(20, Math.min(2000, Math.round(duration / 10) * 10)),
    transparent_output: false,
    output_compression: null,
  }
}

function invalidGif(detail: string) {
  // 上游可能已经收费生成，格式错误不能触发整单重新提交。
  return Object.assign(new Error(`原生 GIF 结果无效：${detail}。请联系管理员检查渠道的动图能力。`), { retryable: false })
}

/** 只读取 GIF 块结构和帧计时，不解码像素、不重编码原始动画。 */
export function inspectNativeGif(dataUrl: string): { width: number; height: number; frameCount: number; durationMs: number } {
  if (!/^data:[^,]*;base64,/i.test(dataUrl)) throw invalidGif('未收到有效的图片数据')
  let bytes: Uint8Array
  try {
    bytes = dataUrlToBytes(dataUrl).bytes
  } catch {
    throw invalidGif('图片数据编码不完整')
  }
  const signature = String.fromCharCode(...bytes.subarray(0, 6))
  if (signature !== 'GIF87a' && signature !== 'GIF89a') throw invalidGif('渠道返回的不是 GIF 图片')
  if (bytes.length < 13) throw invalidGif('文件头不完整')

  const width = bytes[6] | (bytes[7] << 8)
  const height = bytes[8] | (bytes[9] << 8)
  if (!width || !height) throw invalidGif('画面尺寸无效')
  let offset = 13 + ((bytes[10] & 0x80) ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0)
  let frameCount = 0
  let durationMs = 0
  let frameDelay = 0

  // 按长度跳过子块，不能把压缩数据或注释中的 0x2c 当成另一帧。
  const skipSubBlocks = () => {
    let size = 0
    while (offset < bytes.length) {
      const length = bytes[offset++]
      if (!length) return size
      if (offset + length > bytes.length) throw invalidGif('帧或扩展数据被截断')
      offset += length
      size += length
    }
    throw invalidGif('缺少数据块结束标记')
  }

  while (offset < bytes.length) {
    const marker = bytes[offset++]
    if (marker === 0x3b) {
      if (frameCount < 2) throw invalidGif('渠道只返回了静态图片，没有连续动画帧')
      return { width, height, frameCount, durationMs }
    }
    if (marker === 0x21) {
      if (offset >= bytes.length) throw invalidGif('扩展数据被截断')
      const label = bytes[offset++]
      if (label === 0xf9) {
        if (offset + 6 > bytes.length || bytes[offset] !== 4 || bytes[offset + 5] !== 0) throw invalidGif('帧控制信息不完整')
        frameDelay = (bytes[offset + 2] | (bytes[offset + 3] << 8)) * 10
        offset += 6
      } else {
        skipSubBlocks()
        if (label === 0x01) frameDelay = 0
      }
      continue
    }
    if (marker !== 0x2c) throw invalidGif('出现无法识别的数据块')
    if (offset + 9 > bytes.length) throw invalidGif('帧描述信息被截断')
    const left = bytes[offset] | (bytes[offset + 1] << 8)
    const top = bytes[offset + 2] | (bytes[offset + 3] << 8)
    const frameWidth = bytes[offset + 4] | (bytes[offset + 5] << 8)
    const frameHeight = bytes[offset + 6] | (bytes[offset + 7] << 8)
    const packed = bytes[offset + 8]
    if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height) throw invalidGif('动画帧超出画面范围')
    offset += 9 + ((packed & 0x80) ? 3 * 2 ** ((packed & 7) + 1) : 0)
    if (offset >= bytes.length) throw invalidGif('帧数据被截断')
    const codeSize = bytes[offset++]
    if (codeSize < 2 || codeSize > 8 || !skipSubBlocks()) throw invalidGif('帧数据无效')
    frameCount++
    durationMs += frameDelay
    frameDelay = 0
  }
  throw invalidGif('缺少文件结束标记')
}
