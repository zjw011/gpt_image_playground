import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import type { CallApiOptions } from './imageApiShared'
import { generateLiveFrameSequence } from './liveGeneration'

describe('generateLiveFrameSequence', () => {
  it('固定以 n=1 串行请求，并把上一帧作为下一帧输入', async () => {
    const caller = vi.fn(async (options: CallApiOptions) => ({
      images: [`data:image/png;base64,frame-${caller.mock.calls.length}`],
      actualParams: options.params,
      actualParamsList: [options.params],
    }))
    const progress = vi.fn()

    const result = await generateLiveFrameSequence({
      settings: {} as never,
      prompt: '轻微眨眼',
      params: { ...DEFAULT_PARAMS, n: 8 },
      inputImageDataUrls: ['data:image/png;base64,original'],
    }, 3, progress, caller)

    expect(caller).toHaveBeenCalledTimes(3)
    expect(caller.mock.calls.map(([options]) => options.params.n)).toEqual([1, 1, 1])
    expect(caller.mock.calls.map(([options]) => options.inputImageDataUrls[0])).toEqual([
      'data:image/png;base64,original',
      'data:image/png;base64,frame-1',
      'data:image/png;base64,frame-2',
    ])
    expect(result.images).toEqual([
      'data:image/png;base64,frame-1',
      'data:image/png;base64,frame-2',
      'data:image/png;base64,frame-3',
    ])
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ completed: 3, total: 3 }))
  })

  it('中途失败时保留已完成帧并标记失败位置', async () => {
    const caller = vi.fn()
      .mockResolvedValueOnce({ images: ['data:image/png;base64,first'] })
      .mockRejectedValueOnce(new Error('channel unavailable'))

    const result = await generateLiveFrameSequence({
      settings: {} as never,
      prompt: '微风轻动',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: ['data:image/png;base64,original'],
    }, 4, undefined, caller)

    expect(result.images).toEqual(['data:image/png;base64,first'])
    expect(result.failedRequests).toEqual([{ requestIndex: 1, error: '第 2 帧生成失败：channel unavailable' }])
  })

  it('第一帧失败时继续抛错，让现有渠道故障转移接管', async () => {
    const caller = vi.fn().mockRejectedValue(new Error('first failed'))
    await expect(generateLiveFrameSequence({
      settings: {} as never,
      prompt: '呼吸起伏',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: ['data:image/png;base64,original'],
    }, 6, undefined, caller)).rejects.toThrow('first failed')
  })
})
