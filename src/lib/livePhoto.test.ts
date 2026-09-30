import { describe, expect, it } from 'vitest'
import { getLiveMotionFrame } from './livePhoto'

describe('getLiveMotionFrame', () => {
  it('缩放模式随进度推进', () => {
    expect(getLiveMotionFrame(1, 'slow-zoom').scale).toBeGreaterThan(getLiveMotionFrame(0, 'slow-zoom').scale)
  })

  it('平移模式限制输入进度', () => {
    expect(getLiveMotionFrame(-1, 'horizontal-pan').x).toBeCloseTo(-0.04)
    expect(getLiveMotionFrame(2, 'horizontal-pan').x).toBeCloseTo(0.04)
  })
})
