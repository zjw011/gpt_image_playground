import type { InputImage, QuickMotionOptions, TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { getImage, putImage, putTask } from './db'
import { cacheImage } from './imageCache'
import { preloadLiveFrames } from './livePhoto'
import { normalizeQuickMotionOptions } from './quickMotion'

export function isQuickMotionTask(task: TaskRecord) {
  return task.quickMotion !== undefined || task.professionalPreset === 'live-quick'
}

/** 旧备份中的非法参数仍保留本地运镜身份，不能回落成收费绘图任务。 */
export function normalizeQuickMotionTask(task: TaskRecord): TaskRecord {
  if (!isQuickMotionTask(task)) return task
  const options = normalizeQuickMotionOptions(task.quickMotion)
  if (task.quickMotion?.effect === options.effect && task.quickMotion.duration === options.duration && task.quickMotion.strength === options.strength && Object.keys(task.quickMotion).length === 3) return task
  return { ...task, quickMotion: options }
}

/** 作品仅保存原图引用与运镜参数，视频按需导出，不把编码 Blob 写入数据库。 */
export async function saveQuickMotionTask(input: InputImage, options: QuickMotionOptions, id: string, createdAt = Date.now()): Promise<TaskRecord> {
  const source = await getImage(input.id)
  const dataUrl = source?.dataUrl || input.dataUrl
  if (!/^data:image\//i.test(dataUrl)) throw new Error('原始图片已丢失，请重新上传后再试')
  let timer: ReturnType<typeof setTimeout> | undefined
  const [image] = await Promise.race([
    preloadLiveFrames([dataUrl]),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('图片读取超时，请重新上传后再试')), 15000)
    }),
  ]).finally(() => clearTimeout(timer))
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new Error('图片尺寸无效，请重新上传后再试')
  if (!source) {
    await putImage({ id: input.id, dataUrl, source: 'upload', createdAt, width: image.naturalWidth, height: image.naturalHeight })
  }

  const quickMotion = normalizeQuickMotionOptions(options)
  const effect = quickMotion.effect === 'zoom' ? '轻微缩放' : quickMotion.effect === 'pan-left' ? '轻微左移' : '轻微右移'
  const size = `${image.naturalWidth}x${image.naturalHeight}`
  const task: TaskRecord = {
    id,
    prompt: `快速运镜 · ${effect}`,
    professionalPreset: 'live-quick',
    quickMotion,
    params: { ...DEFAULT_PARAMS, n: 1, size },
    sourceMode: 'gallery',
    inputImageIds: [input.id],
    outputImages: [input.id],
    status: 'done',
    error: null,
    createdAt,
    finishedAt: Date.now(),
    elapsed: Math.max(0, Date.now() - createdAt),
  }
  await putTask(task)
  cacheImage(input.id, dataUrl)
  return task
}
