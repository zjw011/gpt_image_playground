import { describe, expect, it } from 'vitest'
import { createLiveFrameSequence } from './livePhoto'

describe('createLiveFrameSequence', () => {
  it('让 AI 关键帧往返播放，避免结尾突然跳回开头', () => {
    expect(createLiveFrameSequence(6)).toEqual([0, 1, 2, 3, 4, 5, 4, 3, 2, 1])
  })

  it('没有足够帧时安全回落到首帧', () => {
    expect(createLiveFrameSequence(0)).toEqual([0])
    expect(createLiveFrameSequence(1)).toEqual([0])
  })
})
