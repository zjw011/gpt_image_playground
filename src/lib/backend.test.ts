// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyCreditsBalance,
  formatCardCodeInput,
  getCreditsConfig,
  getCreditsView,
  loadBackendBootstrap,
  pickErrorCode,
  backendAgentSettings,
  backendChannelToApiProfile,
  BACKEND_MANAGED_API_KEY,
  getRelayBaseUrl,
  readInviteFromUrl,
  type BackendBootstrap,
  type BackendChannel,
} from './backend'
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
    registrationOpen: false,
    credits: { enabled: false, costPerImage: 0, purchaseUrl: '', packs: [] },
    wechat: { enabled: false, loginMode: 'code', hasQrcodeImage: false },
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

describe('readInviteFromUrl', () => {
  it('从邀请链接里读出邀请码，并去掉两端空白', () => {
    window.history.replaceState({}, '', '/?invite=%20abcde-fghij%20')
    expect(readInviteFromUrl()).toBe('abcde-fghij')
  })

  it('没有 invite 参数时给空串，让门禁页照常显示登录表单', () => {
    window.history.replaceState({}, '', '/')
    expect(readInviteFromUrl()).toBe('')
  })
})

describe('formatCardCodeInput', () => {
  it('把用户抄来的卡密统一成 GIP-XXXX-XXXX-XXXX', () => {
    expect(formatCardCodeInput('gipabcdefghijkl')).toBe('GIP-ABCD-EFGH-IJKL')
  })

  it('小写、空格、分隔符混着来也能收敛到同一种形状', () => {
    expect(formatCardCodeInput(' gip abcd efgh ijkl ')).toBe('GIP-ABCD-EFGH-IJKL')
    expect(formatCardCodeInput('gip-abcd-efgh-ijkl')).toBe('GIP-ABCD-EFGH-IJKL')
  })

  it('超出长度就截断，不让用户把整段垃圾粘进来', () => {
    expect(formatCardCodeInput('gipabcdefghijklmnopqrst')).toBe('GIP-ABCD-EFGH-IJKL')
  })
})

describe('pickErrorCode', () => {
  it('有 code 就取出来，界面据此分流到充值入口', () => {
    expect(pickErrorCode(Object.assign(new Error('积分不足'), { code: 'insufficient-credits' }))).toBe('insufficient-credits')
  })

  it('普通 Error 给空串，走通用报错分支', () => {
    expect(pickErrorCode(new Error('boom'))).toBe('')
    expect(pickErrorCode(null)).toBe('')
  })
})

describe('积分字段的解析与本地覆盖', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 造一个只有 /api/bootstrap 会返回 JSON 的假服务端。 */
  function stubBootstrap(body: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
  }

  it('未登录时只有配置没有余额，界面不该显示一个假的 0', async () => {
    stubBootstrap({ backendMode: true, accessMode: 'wechat', authenticated: false, credits: { enabled: true, costPerImage: 2 } })
    const data = await loadBackendBootstrap()
    expect(getCreditsConfig()).toMatchObject({ enabled: true, costPerImage: 2 })
    expect(getCreditsView()).toBeNull()
  })

  it('登录后拿到余额视图，负数与非数都被夹住', async () => {
    stubBootstrap({
      backendMode: true,
      accessMode: 'wechat',
      authenticated: true,
      credits: { enabled: true, costPerImage: 2, balance: 30, reserved: 4, available: 26, totalIn: 50, totalOut: 20, ledger: [{ at: 1, type: 'spend', amount: 2, balanceAfter: 30, ref: 'ch-1', note: '渠道' }] },
    })
    await loadBackendBootstrap()
    expect(getCreditsView()).toMatchObject({ balance: 30, available: 26, totalIn: 50, totalOut: 20 })
    expect(getCreditsView()?.ledger[0]).toMatchObject({ type: 'spend', ref: 'ch-1' })
  })

  it('余额字段残缺时当没有余额，而不是显示半真的数字', async () => {
    stubBootstrap({ backendMode: true, accessMode: 'wechat', authenticated: true, credits: { enabled: true, available: 26 } })
    await loadBackendBootstrap()
    expect(getCreditsView()).toBeNull()
  })

  it('生图回执只带余额时按无在途占位推算可用额', async () => {
    stubBootstrap({
      backendMode: true,
      accessMode: 'wechat',
      authenticated: true,
      credits: { enabled: true, costPerImage: 2, balance: 30, reserved: 0, available: 30, totalIn: 30, totalOut: 0, ledger: [] },
    })
    await loadBackendBootstrap()
    applyCreditsBalance({ balance: 28 })
    expect(getCreditsView()).toMatchObject({ balance: 28, available: 28 })
  })

  it('微信配置解析：未知的 loginMode 退回验证码模式（未认证订阅号也能用）', async () => {
    stubBootstrap({ backendMode: true, accessMode: 'wechat', authenticated: false, wechat: { enabled: true, loginMode: 'something-else' } })
    const data = await loadBackendBootstrap()
    expect(data?.wechat).toMatchObject({ enabled: true, loginMode: 'code', hasQrcodeImage: false })
    expect(data?.accessMode).toBe('wechat')
  })
})
