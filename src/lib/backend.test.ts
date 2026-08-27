// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { backendAgentSettings, backendChannelToApiProfile, BACKEND_MANAGED_API_KEY, getRelayBaseUrl, type BackendBootstrap, type BackendChannel } from './backend'
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

function createBootstrap(site: Partial<BackendBootstrap['site']> = {}): BackendBootstrap {
  return {
    backendMode: true,
    initialized: true,
    accessMode: 'open',
    guestPasswordSet: false,
    userCount: 0,
    authenticated: true,
    user: null,
    workspaceId: 'shared',
    site: {
      title: 'T',
      failoverEnabled: true,
      failoverMaxAttempts: 0,
      allowGuestParamOverride: true,
      agentMode: 'off',
      agentTextChannelId: '',
      agentImageChannelId: '',
      agentMaxToolRounds: 15,
      agentWebSearch: false,
      ...site,
    },
    channels: [],
    customProviders: [],
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

describe('backendAgentSettings', () => {
  it('渠道 id 补上 backend- 前缀，才对得上生成的 profile id', () => {
    const settings = backendAgentSettings(createBootstrap({
      agentMode: 'hybrid',
      agentTextChannelId: 'ch-text',
      agentImageChannelId: 'ch-image',
      agentMaxToolRounds: 20,
      agentWebSearch: true,
    }))
    expect(settings.agentApiConfigMode).toBe('hybrid')
    expect(settings.agentTextProfileId).toBe('backend-ch-text')
    expect(settings.agentImageProfileId).toBe('backend-ch-image')
    expect(settings.agentMaxToolRounds).toBe(20)
    expect(settings.agentWebSearch).toBe(true)
  })

  it('后台没指定渠道时给 null，而不是拼出一个 backend- 的空 id', () => {
    const settings = backendAgentSettings(createBootstrap())
    expect(settings.agentApiConfigMode).toBe('off')
    expect(settings.agentTextProfileId).toBeNull()
    expect(settings.agentImageProfileId).toBeNull()
  })
})
