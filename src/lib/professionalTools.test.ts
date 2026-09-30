import { describe, expect, it } from 'vitest'
import { appendProfessionalPreset, isLiveProfessionalPreset } from './professionalTools'

describe('appendProfessionalPreset', () => {
  it('只在请求边界追加专业增强词', () => {
    expect(appendProfessionalPreset('香水瓶', 'ecommerce-clean')).toContain('香水瓶，专业电商主图设计')
  })

  it('未知预设不改写用户描述', () => {
    expect(appendProfessionalPreset('鞋子', 'missing')).toBe('鞋子')
  })
})

describe('isLiveProfessionalPreset', () => {
  it('只把 Live 微动作方案识别成连续帧任务', () => {
    expect(isLiveProfessionalPreset('live-blink')).toBe(true)
    expect(isLiveProfessionalPreset('live-breeze')).toBe(true)
    expect(isLiveProfessionalPreset('live-breath')).toBe(true)
    expect(isLiveProfessionalPreset('ecommerce-clean')).toBe(false)
  })
})
