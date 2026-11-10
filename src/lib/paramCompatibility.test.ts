import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import { getOutputImageLimitForSettings, normalizeParamsForSettings } from './paramCompatibility'

describe('parameter compatibility', () => {
  it('limits OpenAI output count to 10', () => {
    const openAIProfile = createDefaultOpenAIProfile({ apiKey: 'test-key', streamImages: false })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [openAIProfile],
      activeProfileId: openAIProfile.id,
    })

    expect(getOutputImageLimitForSettings(settings)).toBe(10)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 12 }, settings).n).toBe(10)
  })

  it('uses the 1:1 size shown by the new studio instead of sending auto to compatible gateways', () => {
    const openAIProfile = createDefaultOpenAIProfile({ apiKey: 'test-key' })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [openAIProfile],
      activeProfileId: openAIProfile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: 'auto' }, settings).size).toBe('1024x1024')
  })

  it('limits fal.ai output count to 4', () => {
    const falProfile = createDefaultFalProfile({ apiKey: 'fal-key' })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [falProfile],
      activeProfileId: falProfile.id,
    })

    expect(getOutputImageLimitForSettings(settings)).toBe(4)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 8 }, settings).n).toBe(4)
  })

  it('原生 GIF 保留自动尺寸并移除不兼容的静态图选项', () => {
    const profile = createDefaultOpenAIProfile({ model: 'gpt-image-2.6-sunburst', apiKey: 'test-key' })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })
    const params = normalizeParamsForSettings({
      ...DEFAULT_PARAMS,
      output_format: 'gif',
      n: 6,
      transparent_output: true,
      output_compression: 50,
      frame_count: 12,
      frame_duration_ms: 350,
    }, settings)

    expect(params).toMatchObject({ size: 'auto', n: 1, output_compression: null, transparent_output: false, frame_count: 12, frame_duration_ms: 350 })
    expect(normalizeParamsForSettings({ ...params, size: '1024x1536' }, settings).size).toBe('1024x1536')
  })

  it('keeps OpenAI streaming output count so the request can disable streaming', () => {
    const openAIProfile = createDefaultOpenAIProfile({ apiKey: 'test-key', streamImages: true })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [openAIProfile],
      activeProfileId: openAIProfile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 4 }, settings).n).toBe(4)
  })

  it('only replaces fal.ai auto size in text-to-image mode', () => {
    const falProfile = createDefaultFalProfile({ apiKey: 'fal-key' })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [falProfile],
      activeProfileId: falProfile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: 'auto' }, settings).size).toBe('1360x1024')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: 'auto' }, settings, { hasInputImages: true }).size).toBe('auto')
  })

  it('limits Codex CLI custom sizes to 1K while preserving auto', () => {
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', codexCli: true })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [profile],
      activeProfileId: profile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '2048x2048' }, settings).size).toBe('1024x1024')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: 'auto' }, settings).size).toBe('auto')
  })

  it('applies Codex CLI parameter limits to custom providers', () => {
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      customProviders: [{
        id: 'custom-provider',
        name: 'Custom Provider',
        submit: { path: 'images/generations' },
      }],
      profiles: [{
        ...createDefaultOpenAIProfile(),
        provider: 'custom-provider',
        codexCli: true,
      }],
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '2048x2048', quality: 'high' }, settings)).toMatchObject({
      size: '1024x1024',
      quality: DEFAULT_PARAMS.quality,
    })
  })

  it('does not apply Codex CLI parameter limits to fal.ai', () => {
    const profile = createDefaultFalProfile({ codexCli: true })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      codexCli: true,
      profiles: [profile],
      activeProfileId: profile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '2048x2048' }, settings).size).toBe('2048x2048')
  })
})
