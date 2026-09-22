// 微信登录回归测试。
//
// 这个模块有两个特别容易出错、又特别难在真机上复现的地方：
// 一是**签名校验**（算错了微信服务器配置永远验证不通过，且没有任何有意义的报错），
// 二是**扫码事件的解析**（subscribe 带 `qrscene_` 前缀而 SCAN 不带，少处理一种就等于
// 一半用户登录不了）。所以这两块用真实报文形态覆盖。
//
// 出站请求全部用 stub 替身，不触网。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bindCodeToOpenid,
  bindSceneToOpenid,
  buildEncryptedReply,
  buildTextReply,
  consumeLoginCode,
  consumeScene,
  createLoginQrcode,
  decryptWechatMessage,
  deriveUsername,
  describeErrcode,
  encryptWechatMessage,
  fallbackNickname,
  fetchUserProfile,
  getAccessToken,
  getQrcodeImage,
  isWechatConfigured,
  issueLoginCode,
  markMessageSeen,
  parseIncomingMessage,
  parseLoginCode,
  parseScanEvent,
  parseWechatXml,
  readLoginCode,
  readScene,
  resetWechatCache,
  verifyWechatMsgSignature,
  verifyWechatSignature,
  wechatSignature,
} from './wechat.mjs'
import { createHash } from 'node:crypto'

const WECHAT = { enabled: true, appId: 'wx1234567890', appSecret: 'secret-abc', token: 'my-token' }

/** 43 位 EncodingAESKey，微信随机生成的就是这个长度与字符集。 */
const AES_KEY = 'CJ68nVKvKhUqAsZy8aDphTroCCCUh7SFBzlbrjbhDKk'

/** 造一个够用的 Response 替身。 */
function jsonResponse(payload, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(payload), arrayBuffer: async () => new ArrayBuffer(0) }
}

function imageResponse(bytes) {
  const buffer = Buffer.alloc(bytes, 1)
  return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) }
}

/** 一次性把「取 token → 建二维码 → 下载图片」三个出站请求都安排好。 */
function stubHappyPath() {
  const mock = vi.fn(async (url) => {
    if (String(url).includes('/cgi-bin/token')) return jsonResponse({ access_token: 'tok-1', expires_in: 7200 })
    if (String(url).includes('/cgi-bin/qrcode/create')) {
      return jsonResponse({ ticket: 'TICKET-1', expire_seconds: 600, url: 'http://weixin.qq.com/q/abcdef' })
    }
    if (String(url).includes('/showqrcode')) return imageResponse(2048)
    throw new Error(`没预料到的请求：${url}`)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

beforeEach(() => {
  resetWechatCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('verifyWechatSignature', () => {
  it('按微信规则做 sha1 排序拼接', () => {
    const timestamp = '1409659589'
    const nonce = '263014780'
    const expected = createHash('sha1').update(['my-token', timestamp, nonce].sort().join('')).digest('hex')

    expect(verifyWechatSignature('my-token', { signature: expected, timestamp, nonce })).toBe(true)
  })

  it('缺参数、错签名、错 token 一律不通过', () => {
    const timestamp = '1409659589'
    const nonce = '263014780'
    const good = createHash('sha1').update(['my-token', timestamp, nonce].sort().join('')).digest('hex')

    expect(verifyWechatSignature('my-token', { timestamp, nonce })).toBe(false)
    expect(verifyWechatSignature('my-token', { signature: 'deadbeef', timestamp, nonce })).toBe(false)
    expect(verifyWechatSignature('other-token', { signature: good, timestamp, nonce })).toBe(false)
    expect(verifyWechatSignature('', { signature: good, timestamp, nonce })).toBe(false)
  })
})

describe('parseWechatXml', () => {
  it('认得 CDATA 形态——微信推送实际用的就是这种', () => {
    const xml = `<xml><ToUserName><![CDATA[gh_abc]]></ToUserName><FromUserName><![CDATA[oUser123]]></FromUserName><CreateTime>1348831860</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event><EventKey><![CDATA[qrscene_abcxyz]]></EventKey></xml>`
    expect(parseWechatXml(xml)).toMatchObject({
      ToUserName: 'gh_abc',
      FromUserName: 'oUser123',
      CreateTime: '1348831860',
      MsgType: 'event',
      Event: 'subscribe',
      EventKey: 'qrscene_abcxyz',
    })
  })

  it('也认得无 CDATA 的朴素形态', () => {
    expect(parseWechatXml('<xml><MsgType>text</MsgType><Content>你好</Content></xml>'))
      .toEqual({ MsgType: 'text', Content: '你好' })
  })

  it('内容里带尖括号或换行也不会串味', () => {
    const xml = '<xml><Content><![CDATA[<a> & </a>\n第二行]]></Content></xml>'
    expect(parseWechatXml(xml).Content).toBe('<a> & </a>\n第二行')
  })

  it('非字符串与空串返回空对象而不是抛错', () => {
    expect(parseWechatXml('')).toEqual({})
    expect(parseWechatXml(undefined)).toEqual({})
    expect(parseWechatXml(123)).toEqual({})
  })
})

describe('parseScanEvent', () => {
  it('首次关注的扫码：EventKey 带 qrscene_ 前缀，要去掉', () => {
    expect(parseScanEvent({ MsgType: 'event', Event: 'subscribe', EventKey: 'qrscene_abc123' }))
      .toEqual({ kind: 'subscribe', scene: 'abc123' })
  })

  it('已关注用户扫码：走 SCAN 事件，EventKey 就是 scene 本身', () => {
    expect(parseScanEvent({ MsgType: 'event', Event: 'scan', EventKey: 'abc123' }))
      .toEqual({ kind: 'scan', scene: 'abc123' })
  })

  it('搜索直接关注（没有 EventKey）识别为普通关注，不带 scene', () => {
    expect(parseScanEvent({ MsgType: 'event', Event: 'subscribe' })).toEqual({ kind: 'subscribe', scene: '' })
  })

  it('取关、菜单点击、普通文本消息都不是扫码，返回 null', () => {
    expect(parseScanEvent({ MsgType: 'event', Event: 'unsubscribe' })).toBeNull()
    expect(parseScanEvent({ MsgType: 'event', Event: 'CLICK', EventKey: 'MENU_1' })).toBeNull()
    expect(parseScanEvent({ MsgType: 'text', Content: '你好' })).toBeNull()
  })

  it('事件名大小写不敏感——微信偶尔推大写的 SCAN', () => {
    expect(parseScanEvent({ MsgType: 'event', Event: 'SCAN', EventKey: 'abc' })).toEqual({ kind: 'scan', scene: 'abc' })
  })
})

describe('buildTextReply', () => {
  it('收发双方互换，且把内容里的 XML 元字符转义掉', () => {
    const xml = buildTextReply('oUser', 'gh_abc', '登录成功 <请回到网页>')
    expect(xml).toContain('<ToUserName><![CDATA[oUser]]></ToUserName>')
    expect(xml).toContain('<FromUserName><![CDATA[gh_abc]]></FromUserName>')
    expect(xml).toContain('登录成功 &lt;请回到网页&gt;')
    expect(xml).toContain('<MsgType><![CDATA[text]]></MsgType>')
  })
})

describe('scene 状态机', () => {
  it('scene 不存在时报过期，而不是报未知', () => {
    expect(readScene('nope')).toEqual({ status: 'expired' })
  })

  it('绑定后变为 scanned 并带回 openid', async () => {
    stubHappyPath()
    const { scene } = await createLoginQrcode(WECHAT)

    expect(readScene(scene)).toEqual({ status: 'pending', openid: '' })
    expect(bindSceneToOpenid(scene, 'oUser123')).toEqual({ ok: true })
    expect(readScene(scene)).toEqual({ status: 'scanned', openid: 'oUser123' })
  })

  it('微信重试推送时绑定是幂等的，不会因为重复调用出错', async () => {
    stubHappyPath()
    const { scene } = await createLoginQrcode(WECHAT)

    bindSceneToOpenid(scene, 'oUser123')
    expect(bindSceneToOpenid(scene, 'oUser123')).toEqual({ ok: true, duplicated: true })
  })

  it('同一张二维码不会被第二个 openid 抢走', async () => {
    stubHappyPath()
    const { scene } = await createLoginQrcode(WECHAT)
    bindSceneToOpenid(scene, 'oFirst')

    expect(bindSceneToOpenid(scene, 'oSecond')).toEqual({ ok: false, reason: 'already-bound' })
    expect(readScene(scene).openid).toBe('oFirst')
  })

  it('未知 scene 不会凭空建出状态', () => {
    expect(bindSceneToOpenid('ghost', 'oUser')).toEqual({ ok: false, reason: 'unknown-scene' })
    expect(readScene('ghost').status).toBe('expired')
  })

  it('登录成功后 scene 被消费掉，同一张二维码不能换第二次会话', async () => {
    stubHappyPath()
    const { scene } = await createLoginQrcode(WECHAT)
    bindSceneToOpenid(scene, 'oUser123')

    expect(consumeScene(scene)).toBe(true)
    expect(consumeScene(scene)).toBe(false)
    expect(readScene(scene).status).toBe('expired')
  })

  it('还没被扫过的 scene 不允许消费', async () => {
    stubHappyPath()
    const { scene } = await createLoginQrcode(WECHAT)
    expect(consumeScene(scene)).toBe(false)
    expect(readScene(scene).status).toBe('pending')
  })
})

describe('createLoginQrcode', () => {
  it('返回同源图片地址，并缓存二维码图片本体', async () => {
    stubHappyPath()
    const result = await createLoginQrcode(WECHAT)

    expect(result.scene).toMatch(/^[a-z2-9]{16}$/)
    expect(result.expiresIn).toBe(600)
    expect(result.qrUrl).toBe(`/api/wechat/qr/${result.scene}.png`)
    expect(result.targetUrl).toBe('http://weixin.qq.com/q/abcdef')
    expect(getQrcodeImage(result.scene)).toBeInstanceOf(Buffer)
    expect(getQrcodeImage(result.scene).length).toBe(2048)
  })

  it('每次生成都是全新的 scene', async () => {
    stubHappyPath()
    const first = await createLoginQrcode(WECHAT)
    const second = await createLoginQrcode(WECHAT)
    expect(first.scene).not.toBe(second.scene)
  })

  it('图片体积明显偏小（微信返回了 JSON 错误体）时直接判失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/cgi-bin/token')) return jsonResponse({ access_token: 'tok-1' })
      if (String(url).includes('/cgi-bin/qrcode/create')) return jsonResponse({ ticket: 'TICKET-1' })
      return imageResponse(10)
    }))

    await expect(createLoginQrcode(WECHAT)).rejects.toThrow(/二维码图片异常/)
  })

  it('未知 scene 的图片返回 null，而不是抛错', () => {
    expect(getQrcodeImage('nonexistent')).toBeNull()
  })
})

describe('getAccessToken', () => {
  it('第二次调用复用缓存，不会重复找微信要 token（微信有每日次数限制）', async () => {
    const mock = stubHappyPath()
    await getAccessToken(WECHAT)
    await getAccessToken(WECHAT)

    const tokenCalls = mock.mock.calls.filter(([url]) => String(url).includes('/cgi-bin/token'))
    expect(tokenCalls).toHaveLength(1)
  })

  it('force 时强制刷新', async () => {
    const mock = stubHappyPath()
    await getAccessToken(WECHAT)
    await getAccessToken(WECHAT, { force: true })

    const tokenCalls = mock.mock.calls.filter(([url]) => String(url).includes('/cgi-bin/token'))
    expect(tokenCalls).toHaveLength(2)
  })

  it('AppSecret 配错时给出可操作的中文提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ errcode: 40125, errmsg: 'invalid appsecret' })))
    await expect(getAccessToken(WECHAT)).rejects.toThrow(/AppSecret 无效/)
  })

  it('IP 不在白名单时提示要加白名单——这是自建服务最常见的坑', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      errcode: 40164,
      errmsg: 'invalid ip 1.2.3.4, not in whitelist',
    })))
    await expect(getAccessToken(WECHAT)).rejects.toThrow(/IP 白名单/)
  })
})

describe('describeErrcode', () => {
  it('已知错误码翻成中文，未知错误码带上原始 errmsg', () => {
    expect(describeErrcode(40013)).toMatch(/AppID/)
    expect(describeErrcode(48001)).toMatch(/订阅号/)
    expect(describeErrcode(99999, 'something odd')).toMatch(/something odd/)
  })
})

describe('用户资料', () => {
  it('服务号能拿到昵称头像', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/cgi-bin/token')) return jsonResponse({ access_token: 'tok-1' })
      return jsonResponse({
        subscribe: 1,
        openid: 'oUser123',
        nickname: '张三',
        headimgurl: 'https://thirdwx.qlogo.cn/xxx',
        unionid: 'u-1',
      })
    }))

    expect(await fetchUserProfile(WECHAT, 'oUser123')).toEqual({
      openid: 'oUser123',
      nickname: '张三',
      avatar: 'https://thirdwx.qlogo.cn/xxx',
      unionid: 'u-1',
      subscribed: true,
    })
  })

  it('订阅号没有该接口权限时返回 null，绝不让登录因此失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/cgi-bin/token')) return jsonResponse({ access_token: 'tok-1' })
      return jsonResponse({ errcode: 48001, errmsg: 'api unauthorized' })
    }))

    expect(await fetchUserProfile(WECHAT, 'oUser123')).toBeNull()
  })

  it('网络异常同样降级为 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    }))
    expect(await fetchUserProfile(WECHAT, 'oUser123')).toBeNull()
  })

  it('占位昵称用 openid 尾部，同一个人每次登录名字一致', () => {
    expect(fallbackNickname('oABCDefgh1234')).toBe('微信用户1234')
    expect(fallbackNickname('')).toBe('微信用户0000')
  })

  it('派生用户名以字母开头且只含合法字符', () => {
    expect(deriveUsername('oAb-c_1234567890XYZ')).toMatch(/^wx_[a-zA-Z0-9]+$/)
    expect(deriveUsername('-_-')).toBe('wx_unknown')
  })
})

describe('消息去重', () => {
  it('同一个消息键第二次进来会被识别为重复', () => {
    expect(markMessageSeen('oUser|1348831860|subscribe')).toBe(false)
    expect(markMessageSeen('oUser|1348831860|subscribe')).toBe(true)
    expect(markMessageSeen('oUser|1348831861|subscribe')).toBe(false)
  })
})

describe('isWechatConfigured', () => {
  it('四个条件缺一不可', () => {
    expect(isWechatConfigured(WECHAT)).toBe(true)
    expect(isWechatConfigured({ ...WECHAT, enabled: false })).toBe(false)
    expect(isWechatConfigured({ ...WECHAT, appId: '' })).toBe(false)
    expect(isWechatConfigured({ ...WECHAT, appSecret: '' })).toBe(false)
    expect(isWechatConfigured({ ...WECHAT, token: '' })).toBe(false)
    expect(isWechatConfigured(null)).toBe(false)
  })
})

describe('消息加解密', () => {
  it('加密再解密能拿回原文与 AppID', () => {
    const xml = '<xml><MsgType><![CDATA[text]]></MsgType></xml>'
    const encrypted = encryptWechatMessage(AES_KEY, 'wx1234567890', xml)
    const result = decryptWechatMessage(AES_KEY, encrypted)

    expect(result.message).toBe(xml)
    expect(result.appId).toBe('wx1234567890')
  })

  it('每次加密结果都不同——随机前缀必须是随机的', () => {
    const xml = '<xml>same</xml>'
    const first = encryptWechatMessage(AES_KEY, 'wx1234567890', xml)
    const second = encryptWechatMessage(AES_KEY, 'wx1234567890', xml)

    expect(first).not.toBe(second)
    expect(decryptWechatMessage(AES_KEY, first).message).toBe(xml)
    expect(decryptWechatMessage(AES_KEY, second).message).toBe(xml)
  })

  it('密钥长度不对时给出明确的报错，而不是抛一段神秘的 crypto 异常', () => {
    expect(() => decryptWechatMessage('too-short', 'AAAA')).toThrow(/EncodingAESKey/)
  })

  it('用错密钥解不出正确内容（尾部 AppID 校验的意义所在）', () => {
    const encrypted = encryptWechatMessage(AES_KEY, 'wx1234567890', '<xml>hi</xml>')
    const other = 'BmiqBL3N9EylF4vBaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    expect(() => decryptWechatMessage(other, encrypted)).toThrow()
  })

  it('中文内容能原样往返——扫码登录的引导语全是中文', () => {
    const xml = '<xml><Content><![CDATA[登录成功，请回到电脑页面]]></Content></xml>'
    const encrypted = encryptWechatMessage(AES_KEY, 'wx1234567890', xml)
    expect(decryptWechatMessage(AES_KEY, encrypted).message).toBe(xml)
  })

  it('安全模式的签名把密文也算进去', () => {
    const timestamp = '1409659589'
    const nonce = '263014780'
    const encrypt = 'abc123ciphertext'
    const expected = createHash('sha1')
      .update(['my-token', timestamp, nonce, encrypt].sort().join(''))
      .digest('hex')

    expect(verifyWechatMsgSignature('my-token', { msg_signature: expected, timestamp, nonce }, encrypt)).toBe(true)
    // 换成别的密文就签不出来了。
    expect(verifyWechatMsgSignature('my-token', { msg_signature: expected, timestamp, nonce }, 'other')).toBe(false)
    expect(verifyWechatSignature('my-token', { signature: expected, timestamp, nonce })).toBe(false)
  })

  it('wechatSignature 不带密文时退化成普通签名', () => {
    const plain = createHash('sha1').update(['my-token', '1', '2'].sort().join('')).digest('hex')
    expect(wechatSignature('my-token', '1', '2')).toBe(plain)
    expect(wechatSignature('my-token', '1', '2', 'x')).not.toBe(plain)
  })

  it('加密回复报文带上签名、时间戳与随机串', () => {
    const xml = buildEncryptedReply('CIPHER', 'SIG', 1234567890, 'NONCE')
    expect(xml).toContain('<Encrypt><![CDATA[CIPHER]]></Encrypt>')
    expect(xml).toContain('<MsgSignature><![CDATA[SIG]]></MsgSignature>')
    expect(xml).toContain('<TimeStamp>1234567890</TimeStamp>')
    expect(xml).toContain('<Nonce><![CDATA[NONCE]]></Nonce>')
  })
})

describe('验证码登录', () => {
  it('发出的是 6 位数字码，初始状态是 pending', () => {
    const { code, expiresIn } = issueLoginCode()
    expect(code).toMatch(/^\d{6}$/)
    expect(expiresIn).toBe(600)
    expect(readLoginCode(code)).toEqual({ status: 'pending', openid: '' })
  })

  it('同时发出多个码互不相同', () => {
    const codes = new Set(Array.from({ length: 50 }, () => issueLoginCode().code))
    expect(codes.size).toBe(50)
  })

  it('回复验证码即完成绑定，且能容忍各种写法', () => {
    const { code } = issueLoginCode()

    for (const text of [code, `登录 ${code}`, `登入：${code}`, `code ${code}`, `  ${code}  `]) {
      expect(parseLoginCode(text)).toBe(code)
    }
    expect(bindCodeToOpenid(code, 'oUser123')).toEqual({ ok: true })
    expect(readLoginCode(code)).toEqual({ status: 'bound', openid: 'oUser123' })
  })

  it('绑定是幂等的，微信重试推送也不会出错', () => {
    const { code } = issueLoginCode()
    bindCodeToOpenid(code, 'oUser123')
    expect(bindCodeToOpenid(code, 'oUser123')).toEqual({ ok: true, duplicated: true })
  })

  it('一个验证码不能被两个 openid 抢', () => {
    const { code } = issueLoginCode()
    bindCodeToOpenid(code, 'oFirst')
    expect(bindCodeToOpenid(code, 'oSecond')).toEqual({ ok: false, reason: 'already-bound' })
    expect(readLoginCode(code).openid).toBe('oFirst')
  })

  it('未知或已过期的码不会被误绑', () => {
    expect(bindCodeToOpenid('000000', 'oUser')).toEqual({ ok: false, reason: 'unknown-code' })
    expect(readLoginCode('000000')).toEqual({ status: 'expired' })
    expect(readLoginCode('')).toEqual({ status: 'expired' })
  })

  it('登录成功后作废，同一码换不到第二次会话', () => {
    const { code } = issueLoginCode()
    bindCodeToOpenid(code, 'oUser123')

    expect(consumeLoginCode(code)).toBe(true)
    expect(consumeLoginCode(code)).toBe(false)
    expect(readLoginCode(code).status).toBe('expired')
  })

  it('还没绑定的码不允许消费', () => {
    const { code } = issueLoginCode()
    expect(consumeLoginCode(code)).toBe(false)
    expect(readLoginCode(code).status).toBe('pending')
  })

  it('不含 6 位数字的闲聊不会被当成验证码', () => {
    expect(parseLoginCode('你好')).toBe('')
    expect(parseLoginCode('在吗')).toBe('')
    expect(parseLoginCode('12345')).toBe('')
    expect(parseLoginCode(undefined)).toBe('')
  })
})

/** 有些测试之间要隔离验证码表，但 resetWechatCache 只在 beforeEach 调一次，这里补一个。 */
function initIssue() {
  // 不做额外清理：验证码空间足够大，串测试的概率可以忽略。保留函数以表明意图。
}

describe('parseIncomingMessage', () => {
  it('带 scene 的关注与扫码都归为扫码登录', () => {
    expect(parseIncomingMessage({ MsgType: 'event', Event: 'subscribe', EventKey: 'qrscene_abc' }))
      .toEqual({ kind: 'scan', scene: 'abc', event: 'subscribe' })
    expect(parseIncomingMessage({ MsgType: 'event', Event: 'scan', EventKey: 'abc' }))
      .toEqual({ kind: 'scan', scene: 'abc', event: 'scan' })
  })

  it('不带 scene 的关注归为"该回引导语"', () => {
    expect(parseIncomingMessage({ MsgType: 'event', Event: 'subscribe' })).toEqual({ kind: 'subscribe' })
  })

  it('文本消息里带验证码就归为验证码登录', () => {
    expect(parseIncomingMessage({ MsgType: 'text', Content: '登录 482913' }))
      .toEqual({ kind: 'code', code: '482913' })
  })

  it('纯闲聊返回 null，服务端不会做任何事', () => {
    expect(parseIncomingMessage({ MsgType: 'text', Content: '你们这个怎么用' })).toBeNull()
    expect(parseIncomingMessage({ MsgType: 'event', Event: 'unsubscribe' })).toBeNull()
  })
})
