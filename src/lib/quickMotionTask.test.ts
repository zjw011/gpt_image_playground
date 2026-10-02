import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuickMotionOptions, TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'

vi.mock('./db', () => ({ getImage: vi.fn(), putImage: vi.fn(), putTask: vi.fn() }))
vi.mock('./imageCache', () => ({ cacheImage: vi.fn() }))
vi.mock('./livePhoto', () => ({ preloadLiveFrames: vi.fn() }))

import { getImage, putImage, putTask } from './db'
import { cacheImage } from './imageCache'
import { preloadLiveFrames } from './livePhoto'
import { isQuickMotionTask, normalizeQuickMotionTask, saveQuickMotionTask } from './quickMotionTask'

const image = { id: 'original-image', dataUrl: 'data:image/png;base64,original' }
const options: QuickMotionOptions = { effect: 'zoom', duration: 2, strength: 3 }

describe('quick motion local task persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getImage).mockResolvedValue(undefined)
    vi.mocked(putTask).mockResolvedValue('local-task')
    vi.mocked(putImage).mockResolvedValue(image.id)
    vi.mocked(preloadLiveFrames).mockResolvedValue([{ naturalWidth: 1024, naturalHeight: 1024 } as HTMLImageElement])
  })

  afterEach(() => vi.useRealTimers())

  it('keeps the original image ID and persists the recipe without a video Blob or channel', async () => {
    const task = await saveQuickMotionTask(image, options, 'local-task', 1)
    expect(putImage).toHaveBeenCalledWith({ ...image, createdAt: 1, source: 'upload', width: 1024, height: 1024 })
    expect(task).toMatchObject({
      id: 'local-task',
      quickMotion: options,
      inputImageIds: [image.id],
      outputImages: [image.id],
      status: 'done',
      params: { n: 1, size: '1024x1024' },
    })
    expect(task.apiProfileId).toBeUndefined()
    expect(task.apiProvider).toBeUndefined()
    expect(Object.values(task).some((value) => value instanceof Blob)).toBe(false)
    expect(putTask).toHaveBeenCalledWith(task)
    expect(cacheImage).toHaveBeenCalledWith(image.id, image.dataUrl)
  })

  it('reuses the already stored original and its real dimensions without overwriting it', async () => {
    vi.mocked(getImage).mockResolvedValue({ ...image, width: 768, height: 1024, source: 'generated', createdAt: 1 })
    vi.mocked(preloadLiveFrames).mockResolvedValue([{ naturalWidth: 768, naturalHeight: 1024 } as HTMLImageElement])
    const task = await saveQuickMotionTask({ id: image.id, dataUrl: 'data:image/png;base64,changed' }, options, 'local-task')
    expect(putImage).not.toHaveBeenCalled()
    expect(task.params.size).toBe('768x1024')
    expect(cacheImage).toHaveBeenCalledWith(image.id, image.dataUrl)
  })

  it('uses persisted image data when the editor has no data URL after refresh', async () => {
    vi.mocked(getImage).mockResolvedValue(image)
    expect((await saveQuickMotionTask({ id: image.id, dataUrl: '' }, options, 'local-task')).outputImages).toEqual([image.id])
  })

  it('does not persist a task when the source cannot be read or no longer exists', async () => {
    vi.mocked(getImage).mockRejectedValueOnce(new Error('数据库读取失败'))
    await expect(saveQuickMotionTask(image, options, 'local-task')).rejects.toThrow('数据库读取失败')
    await expect(saveQuickMotionTask({ id: image.id, dataUrl: '' }, options, 'local-task')).rejects.toThrow('原始图片已丢失')
    expect(putTask).not.toHaveBeenCalled()
    expect(cacheImage).not.toHaveBeenCalled()
  })

  it('propagates image or task storage failure without caching a false success', async () => {
    vi.mocked(putImage).mockRejectedValueOnce(new Error('空间不足'))
    await expect(saveQuickMotionTask(image, options, 'local-task')).rejects.toThrow('空间不足')
    expect(putTask).not.toHaveBeenCalled()
    vi.mocked(putTask).mockRejectedValueOnce(new Error('作品写入失败'))
    await expect(saveQuickMotionTask(image, options, 'local-task')).rejects.toThrow('作品写入失败')
    expect(cacheImage).not.toHaveBeenCalled()
  })

  it('rejects damaged or zero-size images before writing any image or work', async () => {
    vi.mocked(preloadLiveFrames).mockRejectedValueOnce(new Error('图片读取失败'))
    await expect(saveQuickMotionTask(image, options, 'local-task')).rejects.toThrow('图片读取失败')
    vi.mocked(preloadLiveFrames).mockResolvedValueOnce([{ naturalWidth: 0, naturalHeight: 0 } as HTMLImageElement])
    await expect(saveQuickMotionTask(image, options, 'local-task')).rejects.toThrow('图片尺寸无效')
    expect(putImage).not.toHaveBeenCalled()
    expect(putTask).not.toHaveBeenCalled()
    expect(cacheImage).not.toHaveBeenCalled()
  })

  it('times out image decoding without writing a task and releases its timer', async () => {
    vi.useFakeTimers()
    let resolve!: (images: HTMLImageElement[]) => void
    vi.mocked(preloadLiveFrames).mockImplementationOnce(() => new Promise((res) => { resolve = res }))
    const saving = saveQuickMotionTask(image, options, 'local-task')
    const rejected = expect(saving).rejects.toThrow('图片读取超时')
    await vi.advanceTimersByTimeAsync(15000)
    await rejected
    resolve([{ naturalWidth: 1024, naturalHeight: 1024 } as HTMLImageElement])
    await Promise.resolve()
    expect(putImage).not.toHaveBeenCalled()
    expect(putTask).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('normalizes malformed backup recipes and preserves local identity', () => {
    const task: TaskRecord = {
      id: 'restored', prompt: 'old', params: DEFAULT_PARAMS,
      inputImageIds: [image.id], outputImages: [image.id], status: 'done', error: null,
      createdAt: 1, finishedAt: 1, elapsed: 0,
      quickMotion: { effect: 'invalid', duration: Infinity, strength: -100 } as unknown as QuickMotionOptions,
    }
    expect(normalizeQuickMotionTask(task).quickMotion).toEqual({ effect: 'zoom', duration: 2, strength: 2 })
    expect(normalizeQuickMotionTask({ ...task, quickMotion: null } as unknown as TaskRecord).quickMotion).toEqual(options)
    const { quickMotion: _, ...ordinary } = task
    expect(normalizeQuickMotionTask(ordinary)).toBe(ordinary)
    const valid = { ...task, quickMotion: options }
    expect(normalizeQuickMotionTask(valid)).toBe(valid)
    expect(normalizeQuickMotionTask({ ...task, quickMotion: { ...options, obsolete: 'ignored' } } as TaskRecord).quickMotion).toEqual(options)
    expect(isQuickMotionTask({ ...ordinary, quickMotion: undefined })).toBe(false)
    expect(normalizeQuickMotionTask({ ...ordinary, professionalPreset: 'live-quick' }).quickMotion).toEqual(options)
  })
})
