// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { backendChannelToApiProfile, BACKEND_MANAGED_API_KEY, getRelayBaseUrl, type BackendChannel } from './backend'
import { buildApiUrl } from './devProxy'

function createChannel(patch: Partial<BackendChannel> = {}): BackendChannel {
  return {
    id: 'ch-1',
    name: '主渠道',
    description: '',
    provider: 'openai',
    model: 'gpt-image-2',
    apiMode: 'images',
    timeout: 600,
    codexCli: false,
    responseFormatB64Json: false,
    streamImages: false,
    streamPartialImages: 1,
    transparentBackgroundMethod: 'api',
    ...patch,
  }
}

describe('getRelayBaseUrl', () => {
  it('结尾带 / 让 buildApiUrl 直接拼接端点，不再插入 /v1', () => {
    const baseUrl = getRelayBaseUrl('ch-1')
    expect(baseUrl.endsWith('/api/relay/ch-1/')).toBe(true)
    expect(buildApiUrl(baseUrl, 'images/generations')).toBe(`${window.location.origin}/api/relay/ch-1/images/generations`)
    expect(buildApiUrl(baseUrl, '/responses')).toBe(`${window.location.origin}/api/relay/ch-1/responses`)
  })

  it('渠道 id 会被转义，避免拼出越界路径', () => {
    expect(getRelayBaseUrl('a/../b')).toBe(`${window.location.origin}/api/relay/a%2F..%2Fb/`)
  })
})

describe('backendChannelToApiProfile', () => {
  it('密钥用占位值，地址指向同源中继', () => {
    const profile = backendChannelToApiProfile(createChannel())
    expect(profile.id).toBe('backend-ch-1')
    expect(profile.apiKey).toBe(BACKEND_MANAGED_API_KEY)
    expect(profile.baseUrl).toBe(`${window.location.origin}/api/relay/ch-1/`)
    expect(profile.apiProxy).toBe(false)
  })

  it('保留后台配置的渠道行为开关', () => {
    const profile = backendChannelToApiProfile(createChannel({
      apiMode: 'responses',
      codexCli: true,
      streamImages: true,
      streamPartialImages: 3,
      transparentBackgroundMethod: 'local',
      description: '备用线路',
    }))
    expect(profile.apiMode).toBe('responses')
    expect(profile.codexCli).toBe(true)
    expect(profile.streamImages).toBe(true)
    expect(profile.streamPartialImages).toBe(3)
    expect(profile.transparentBackgroundMethod).toBe('local')
    expect(profile.description).toBe('备用线路')
  })
})
