import { describe, expect, it } from 'vitest'
import { appendStylePreset } from './stylePresets'

describe('style presets', () => {
  it('只在生成请求中拼接选中的风格', () => {
    expect(appendStylePreset('海边少女', 'portrait')).toContain('海边少女，真实人物摄影')
    expect(appendStylePreset('海边少女', 'missing')).toBe('海边少女')
    expect(appendStylePreset('  海边少女  ')).toBe('海边少女')
  })
})
