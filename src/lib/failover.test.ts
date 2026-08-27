import { describe, expect, it } from 'vitest'
import { createFailoverAttempt, formatFailoverError, getFailoverCandidates, getFailoverTimeoutBudget, isFailoverableError, withFailoverStreamingDisabled } from './failover'
import { DEFAULT_SETTINGS } from './apiProfiles'
import type { ApiProfile, AppSettings } from '../types'

function createProfile(id: string, patch: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id,
    name: `渠道 ${id}`,
    provider: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-image-2',
    timeout: 60,
    apiMode: 'images',
    codexCli: false,
    apiProxy: false,
    streamImages: false,
    streamPartialImages: 1,
    transparentBackgroundMethod: 'api',
    ...patch,
  }
}

function createSettings(profiles: ApiProfile[], patch: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    profiles,
    activeProfileId: profiles[0]?.id ?? '',
    channelFailover: true,
    channelFailoverMaxAttempts: 0,
    ...patch,
  }
}

describe('isFailoverableError', () => {
  it('本地校验类错误不参与故障转移', () => {
    expect(isFailoverableError(new Error('图像输入有效负载总大小过大：600.0 MiB，上限为 512.0 MiB'))).toBe(false)
    expect(isFailoverableError(new Error('输入图片已不存在'))).toBe(false)
    expect(isFailoverableError(new Error('找不到此任务所使用的 API 配置。'))).toBe(false)
  })

  it('上游报错与网络错误可以换渠道重试', () => {
    expect(isFailoverableError(new Error('HTTP 429: rate limit exceeded'))).toBe(true)
    expect(isFailoverableError(new Error('Failed to fetch'))).toBe(true)
  })
})

describe('getFailoverCandidates', () => {
  const first = createProfile('a')
  const second = createProfile('b')
  const third = createProfile('c')

  it('起始渠道排第一，其余按配置顺序补齐', () => {
    const candidates = getFailoverCandidates(createSettings([first, second, third]), second)
    expect(candidates.map((profile) => profile.id)).toEqual(['b', 'a', 'c'])
  })

  it('关闭故障转移时只返回起始渠道', () => {
    const candidates = getFailoverCandidates(createSettings([first, second], { channelFailover: false }), first)
    expect(candidates.map((profile) => profile.id)).toEqual(['a'])
  })

  it('按上限截断候选数量', () => {
    const candidates = getFailoverCandidates(createSettings([first, second, third], { channelFailoverMaxAttempts: 2 }), first)
    expect(candidates.map((profile) => profile.id)).toEqual(['a', 'b'])
  })

  it('跳过配置不完整的渠道', () => {
    const broken = createProfile('broken', { apiKey: '' })
    const candidates = getFailoverCandidates(createSettings([first, broken, third]), first)
    expect(candidates.map((profile) => profile.id)).toEqual(['a', 'c'])
  })
})

describe('withFailoverStreamingDisabled', () => {
  it('还有后续候选时关闭流式', () => {
    const streaming = createProfile('a', { streamImages: true })
    expect(withFailoverStreamingDisabled(streaming, true).streamImages).toBe(false)
    expect(withFailoverStreamingDisabled(streaming, false)).toBe(streaming)
  })
})

describe('getFailoverTimeoutBudget', () => {
  it('累加所有候选渠道的超时预算', () => {
    expect(getFailoverTimeoutBudget([createProfile('a', { timeout: 60 }), createProfile('b', { timeout: 120 })])).toBe(180)
  })
})

describe('formatFailoverError', () => {
  it('单次尝试直接返回原始错误', () => {
    const attempts = [createFailoverAttempt(createProfile('a'), new Error('boom'))]
    expect(formatFailoverError(attempts, 'boom')).toBe('boom')
  })

  it('多次尝试汇总每个渠道的首行错误', () => {
    const attempts = [
      createFailoverAttempt(createProfile('a'), new Error('429 too many requests')),
      createFailoverAttempt(createProfile('b'), new Error('500 upstream error\n更多细节')),
    ]
    const message = formatFailoverError(attempts, '500 upstream error\n更多细节')
    expect(message).toContain('已尝试 2 个渠道，全部失败')
    expect(message).toContain('1. 渠道 a：429 too many requests')
    expect(message).toContain('2. 渠道 b：500 upstream error')
    expect(message).not.toContain('2. 渠道 b：500 upstream error\n更多细节')
  })
})
