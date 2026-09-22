// 微信公众号「扫码关注即登录」。
//
// 两种模式，产出同一个结果（一个 openid → 一个账号 → 一个会话 cookie）：
//
// 【验证码模式 · 默认】任何账号类型都能用，包括未认证的个人订阅号。
//   1. 前端 POST /api/wechat/login 拿一个 6 位数字码，页面显示它并开始轮询。
//   2. 用户在公众号对话框里把这串数字发过来。微信把 text 消息 POST 到 /api/wechat/callback。
//   3. 服务端匹配到票据，标记为"已被某 openid 认领"，顺手回一条"登录成功"。
//   4. 前端轮询拿到 openid，建号/找号并下发会话 cookie。
//
// 【扫码模式 · 需微信认证服务号】用户扫二维码后自动完成，不用回消息。
//   1. 前端 POST /api/wechat/qrcode —— 调微信「生成带参临时二维码」，拿 ticket，
//      顺手把二维码图片抓回来缓存在内存，返回一个同源图片地址给前端。
//   2. 用户用微信扫码。没关注过 → 微信推 subscribe 事件；关注过 → 推 SCAN 事件，
//      两者都带 scene。微信把事件 POST 到 /api/wechat/callback。
//   3. 服务端从事件里取出 openid 与 scene，把这个 scene 标记成"已被某 openid 扫过"。
//   4. 前端轮询 /api/wechat/poll?scene=xxx，拿到 openid 后建号/找号并下发会话 cookie。
//
// 为什么默认验证码，以及为什么不用网页授权：
// - 带参二维码（qrcode/create）在官方接口权限表里**只对微信认证服务号开放**，未认证
//   订阅号、微信认证订阅号、未认证服务号一概没有。而个人主体只能注册订阅号、注册不了
//   服务号，两种类型还不可互转——所以个人号上"扫码自动登录"这条路是封死的，**去做
//   个人认证也解锁不了**。验证码模式只依赖"服务器配置能收发消息"，而这项权限所有账号
//   类型都有，因此对个人号是唯一可行的路径，且不需要任何认证。
// - 网页授权（snsapi_userinfo）要求用户**在微信内打开网页**，而这里的主场景是
//   "电脑上扫码，电脑上出图"，覆盖不到。
//
// 关于昵称头像：`cgi-bin/user/info` 需要账号**已认证**——微信认证订阅号和认证服务号
// 都有这个权限，**未认证**的订阅号没有（会返回 48001 api unauthorized）。这是个人认证
// 对本项目唯一有实际价值的一项：认证后才能显示用户真人昵称和头像，否则回落成
// 「微信用户 abcd」加首字母头像。它是可选增强，拉不到绝不让登录失败。

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto'

/** 微信 access_token 有效期 7200 秒。提前 5 分钟刷新，避免边界上刚好过期。 */
const TOKEN_EARLY_REFRESH_MS = 300 * 1000
const TOKEN_TTL_MS = 7200 * 1000

/** 二维码有效期。10 分钟够用户掏出手机扫码，又短到不会积压一堆无人认领的 scene。 */
export const QRCODE_TTL_SECONDS = 600
const QRCODE_TTL_MS = QRCODE_TTL_SECONDS * 1000

/** 微信服务器在 5 秒内没收到响应就会重试（共 3 次）。所有出站请求的硬超时都要留出余量。 */
const WECHAT_API_TIMEOUT_MS = 8_000

/** 去重窗口：微信重试间隔 5 秒，留 5 分钟足够覆盖。 */
const DEDUPE_TTL_MS = 5 * 60 * 1000

const API_BASE = 'https://api.weixin.qq.com'

/** scene 用无歧义小写字母表，长度 16 → 32^16 空间，不可能被猜中。 */
const SCENE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const SCENE_LENGTH = 16

/** 登录验证码有效期与长度。 */
const LOGIN_CODE_TTL_MS = 10 * 60 * 1000
const LOGIN_CODE_DIGITS = 6

/**
 * 轮询令牌长度（字节）。
 * 前端拿它来轮询，而不是直接拿验证码——验证码只有 6 位数字，用它当查询键的话
 * 理论上可以逐个猜出别人的登录会话。令牌 18 字节随机，猜不出来。
 */
const POLL_TOKEN_BYTES = 18

// ===== 内存状态 =====

let tokenCache = { token: '', expiresAt: 0 }
/** scene -> 扫码状态。只存内存：有效期 10 分钟，重启后用户重新点一次即可，不值得落盘。 */
const scenes = new Map()
/** scene -> 二维码 PNG。同样只存内存。 */
const qrcodes = new Map()
/** 登录验证码 -> 登录状态。 */
const loginCodes = new Map()
/**
 * 轮询令牌 -> 底层登录会话。
 * 两种登录方式（带参二维码 / 回复验证码）都收敛到同一张令牌表上，
 * 前端只需要记住一个 token，服务端也只需要维护一套轮询逻辑。
 */
const pollTokens = new Map()
/** 微信消息去重键 -> 时间戳。 */
const seenMessages = new Map()

function prune() {
  const now = Date.now()
  for (const [key, item] of scenes) {
    if (item.expiresAt <= now) scenes.delete(key)
  }
  for (const [key, item] of qrcodes) {
    if (item.expiresAt <= now) qrcodes.delete(key)
  }
  for (const [key, item] of loginCodes) {
    if (item.expiresAt <= now) loginCodes.delete(key)
  }
  for (const [key, item] of pollTokens) {
    if (item.expiresAt <= now) pollTokens.delete(key)
  }
  for (const [key, at] of seenMessages) {
    if (now - at > DEDUPE_TTL_MS) seenMessages.delete(key)
  }
}

/** 测试与"改了 AppSecret 想立刻生效"时用得上。 */
export function resetWechatCache() {
  tokenCache = { token: '', expiresAt: 0 }
  scenes.clear()
  qrcodes.clear()
  loginCodes.clear()
  pollTokens.clear()
  seenMessages.clear()
}

function issuePollToken(mode, key, expiresAt) {
  const token = randomBytes(POLL_TOKEN_BYTES).toString('base64url')
  pollTokens.set(token, { mode, key, expiresAt })
  return token
}

/**
 * 用轮询令牌查登录进度。
 * 底层那张表只说"绑没绑上"，这里把它翻译成前端要的三态。
 */
export function readLoginSession(pollToken) {
  prune()
  const session = pollTokens.get(String(pollToken ?? ''))
  if (!session) return { status: 'expired' }

  const source = session.mode === 'code' ? loginCodes.get(session.key) : scenes.get(session.key)
  if (!source) return { status: 'expired' }
  if (source.status === 'pending') return { status: 'pending', mode: session.mode }
  return { status: 'bound', mode: session.mode, openid: source.openid, key: session.key }
}

/** 登录成功后把令牌和底层的码一起作废，同一张二维码换不到第二次会话。 */
export function consumeLoginSession(pollToken) {
  const token = String(pollToken ?? '')
  const session = pollTokens.get(token)
  if (!session) return false
  pollTokens.delete(token)
  if (session.mode === 'code') consumeLoginCode(session.key)
  else consumeScene(session.key)
  return true
}

// ===== 配置 =====

export function isWechatConfigured(wechat) {
  return Boolean(wechat?.enabled && wechat.appId && wechat.appSecret && wechat.token)
}

/**
 * 回调地址。微信要求这里是**公网可访问的 80/443 地址**，
 * 且必须与公众号后台「服务器配置」里填的完全一致，所以后台要把这段直接展示给管理员复制。
 */
export function wechatCallbackPath() {
  return '/api/wechat/callback'
}

// ===== 出站调用 =====

/** 所有微信接口调用都要过这里：统一超时 + 统一把 errcode 翻成人话。 */
async function wechatFetch(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(WECHAT_API_TIMEOUT_MS) })
  const text = await response.text()
  if (!response.ok) throw new Error(`微信接口 HTTP ${response.status}：${text.slice(0, 200)}`)

  const payload = (() => {
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`微信接口返回了非 JSON 内容：${text.slice(0, 200)}`)
    }
  })()

  if (payload.errcode) throw new Error(describeErrcode(payload.errcode, payload.errmsg))
  return payload
}

/** 微信错误码翻成人话。后台配错了要能一眼看出错在哪，而不是对着 40164 发懵。 */
export function describeErrcode(errcode, errmsg = '') {
  const code = Number(errcode)
  const known = {
    40001: 'AppSecret 不正确，请到公众号后台「基本配置」重新复制',
    40013: 'AppID 无效，请核对是否填成了开放平台的 AppID',
    40014: 'access_token 无效，请稍后重试',
    40125: 'AppSecret 无效，请重新复制',
    40164: `调用来源 IP 不在白名单内（${errmsg}）。请把服务器公网 IP 加入公众号后台「基本配置 → IP 白名单」`,
    41001: '缺少 access_token 参数',
    45009: '微信接口调用频率超限，请稍后再试',
    48001: '该接口未授权。未认证的公众号没有拉取用户资料的权限，昵称头像将退化为占位值；完成个人认证即可获得该权限',
    50002: '账号受限，请检查公众号状态',
  }
  if (known[code]) return `${known[code]}（errcode ${code}）`
  return `微信接口报错：${errmsg || '未知错误'}（errcode ${code}）`
}

/**
 * 取 access_token。
 * 微信对 token 的获取次数有限制（2000 次/天），而每次出图都可能触发扫码流程，
 * 所以必须缓存复用——这里是全进程唯一一处取 token 的地方。
 */
export async function getAccessToken(wechat, options = {}) {
  const now = Date.now()
  if (!options.force && tokenCache.token && tokenCache.expiresAt > now) return tokenCache.token

  const url = `${API_BASE}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(wechat.appId)}&secret=${encodeURIComponent(wechat.appSecret)}`
  const payload = await wechatFetch(url)
  if (!payload.access_token) throw new Error('微信未返回 access_token')

  tokenCache = {
    token: payload.access_token,
    expiresAt: now + Math.max(60_000, (Number(payload.expires_in) || 7200) * 1000 - TOKEN_EARLY_REFRESH_MS),
  }
  return tokenCache.token
}

function newScene() {
  const chars = Array.from({ length: SCENE_LENGTH }, () => SCENE_ALPHABET[randomInt(SCENE_ALPHABET.length)])
  return chars.join('')
}

/**
 * 生成一张带参临时二维码，并把二维码图片本体也抓回来缓存。
 *
 * 之所以由服务端代抓图片而不是让前端直接 <img src="https://mp.weixin.qq.com/...">：
 * 一是企业网络/代理环境下浏览mp.weixin.qq.com 并不总是通，走同源最稳；
 * 二是不把 ticket 暴露到浏览器，少一个被滥用的面。
 */
export async function createLoginQrcode(wechat) {
  prune()
  const token = await getAccessToken(wechat)
  const scene = newScene()

  const payload = await wechatFetch(`${API_BASE}/cgi-bin/qrcode/create?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // 永久二维码（QR_LIMIT_STR_SCENE）有 10 万个的数量上限，登录场景用临时码更合适。
      expire_seconds: QRCODE_TTL_SECONDS,
      action_name: 'QR_STR_SCENE',
      action_info: { scene: { scene_str: scene } },
    }),
  })
  if (!payload.ticket) throw new Error('微信未返回二维码 ticket')

  const image = await fetchQrcodeImage(payload.ticket)
  const expiresAt = Date.now() + QRCODE_TTL_MS

  scenes.set(scene, { status: 'pending', openid: '', at: Date.now(), expiresAt })
  qrcodes.set(scene, { buffer: image, expiresAt })

  return {
    scene,
    expiresIn: QRCODE_TTL_SECONDS,
    // 前端把它塞进 <img src>。同源路径，顺带把缓存也交给浏览器。
    qrUrl: `/api/wechat/qr/${scene}.png`,
    targetUrl: typeof payload.url === 'string' ? payload.url : '',
    pollToken: issuePollToken('qrcode', scene, expiresAt),
  }
}

async function fetchQrcodeImage(ticket) {
  const response = await fetch(`${API_BASE}/showqrcode?ticket=${encodeURIComponent(ticket)}`, {
    signal: AbortSignal.timeout(WECHAT_API_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`二维码图片下载失败：HTTP ${response.status}`)

  const buffer = Buffer.from(await response.arrayBuffer())
  // 微信出错时会返回一小段 JSON 而不是图片，体积明显偏小。
  if (buffer.length < 200) throw new Error(`二维码图片异常（仅 ${buffer.length} 字节），请检查公众号配置`)
  return buffer
}

export function getQrcodeImage(scene) {
  prune()
  return qrcodes.get(String(scene ?? ''))?.buffer ?? null
}

/** 轮询用：这个 scene 现在是什么状态。 */
export function readScene(scene) {
  prune()
  const item = scenes.get(String(scene ?? ''))
  if (!item) return { status: 'expired' }
  return { status: item.status, openid: item.openid }
}

/**
 * 把一个 scene 标记成"已被某个 openid 扫过"。
 * 微信会重试推送，所以这个函数必须幂等——重复调用不改变结果。
 */
export function bindSceneToOpenid(scene, openid) {
  prune()
  const item = scenes.get(String(scene ?? ''))
  if (!item) return { ok: false, reason: 'unknown-scene' }
  if (item.status === 'scanned' && item.openid === openid) return { ok: true, duplicated: true }
  // 已经绑定了别人的话不覆盖：一个二维码只对应一次登录。
  if (item.status === 'scanned' && item.openid !== openid) return { ok: false, reason: 'already-bound' }

  item.status = 'scanned'
  item.openid = openid
  item.at = Date.now()
  return { ok: true }
}

/** 登录成功后把这个 scene 作废，防止同一张二维码被重复用来换会话。 */
export function consumeScene(scene) {
  const item = scenes.get(String(scene ?? ''))
  if (!item || item.status !== 'scanned') return false
  item.status = 'consumed'
  scenes.delete(String(scene))
  return true
}

// ===== 验证码登录（未认证订阅号的可行路径）=====
//
// 「生成带参数的二维码」只有**认证**的公众号才能调用。未认证订阅号上这条路是死的，
// 但服务器配置与消息接收是开放的，于是换成一条等效路径：
//
//   网页显示 6 位验证码 → 用户扫码关注 → 在公众号里回复这 6 位 → 电脑端自动登录
//
// 比纯扫码多一步操作，但换来的是**任何类型的公众号都能用**，而且完全不依赖
// access_token 和 IP 白名单——少两个部署时最容易卡住的环节。

/** 发一个登录验证码。6 位数字，10 分钟内有效。 */
export function issueLoginCode() {
  prune()
  let code = ''
  // 撞上正在使用的码就重摇。同时最多几十个待登录会话，重摇一两次就能命中。
  for (let attempt = 0; attempt < 30; attempt += 1) {
    code = String(randomInt(10 ** (LOGIN_CODE_DIGITS - 1), 10 ** LOGIN_CODE_DIGITS))
    if (!loginCodes.has(code)) break
  }

  const expiresAt = Date.now() + LOGIN_CODE_TTL_MS
  loginCodes.set(code, { status: 'pending', openid: '', at: Date.now(), expiresAt })
  return { code, pollToken: issuePollToken('code', code, expiresAt), expiresIn: Math.floor(LOGIN_CODE_TTL_MS / 1000) }
}

export function readLoginCode(code) {
  prune()
  const item = loginCodes.get(String(code ?? '').trim())
  if (!item) return { status: 'expired' }
  return { status: item.status, openid: item.openid }
}

/** 微信推送的文本消息里如果有验证码，就把它和发送者绑起来。幂等，微信重试也安全。 */
export function bindCodeToOpenid(code, openid) {
  prune()
  const item = loginCodes.get(String(code ?? '').trim())
  if (!item) return { ok: false, reason: 'unknown-code' }
  if (item.status === 'bound' && item.openid === openid) return { ok: true, duplicated: true }
  if (item.status === 'bound' && item.openid !== openid) return { ok: false, reason: 'already-bound' }

  item.status = 'bound'
  item.openid = openid
  item.at = Date.now()
  return { ok: true }
}

export function consumeLoginCode(code) {
  const key = String(code ?? '').trim()
  const item = loginCodes.get(key)
  if (!item || item.status !== 'bound') return false
  loginCodes.delete(key)
  return true
}

/**
 * 从用户在公众号里发的文本里提取验证码。
 *
 * 容忍各种写法：「482913」「登录 482913」「登入：482913」「code 482913」。
 * 只认 6 位连续数字，且**必须**是当前有效的验证码才算数——随便一句带数字的话
 * 不会误触发登录。
 */
export function parseLoginCode(content) {
  const match = /(\d{6})/.exec(String(content ?? ''))
  return match ? match[1] : ''
}

// ===== 微信服务器推送 =====

/** 微信服务器配置的 URL 校验：sha1 排序拼接后比对 signature。 */
export function verifyWechatSignature(token, query) {
  const signature = String(query?.signature ?? '')
  if (!signature || !token) return false

  const parts = [String(token), String(query?.timestamp ?? ''), String(query?.nonce ?? '')]
  const computed = createHash('sha1').update(parts.sort().join('')).digest('hex')
  return computed === signature
}

/**
 * 安全模式下的签名校验：把密文也参与进去，算法换成 msg_signature。
 * 兼容模式会同时给 signature 和 msg_signature，两个都认。
 */
export function verifyWechatMsgSignature(token, query, encrypt) {
  const msgSignature = String(query?.msg_signature ?? '')
  if (!msgSignature || !token) return false

  const parts = [String(token), String(query?.timestamp ?? ''), String(query?.nonce ?? ''), String(encrypt ?? '')]
  const computed = createHash('sha1').update(parts.sort().join('')).digest('hex')
  return computed === msgSignature
}

export function wechatSignature(token, timestamp, nonce, encrypt = '') {
  const parts = [String(token), String(timestamp), String(nonce)]
  if (encrypt) parts.push(String(encrypt))
  return createHash('sha1').update(parts.sort().join('')).digest('hex')
}

// ===== 消息加解密（微信的 aes-256-cbc + PKCS#7）=====
//
// 公众号后台的消息加解密方式有三种：明文、兼容、安全（推荐）。安全模式下收到的
// XML 只有 <Encrypt> 一段密文，不解开就什么都读不到。而**默认被推荐的就是安全模式**，
// 所以这条路必须支持，否则管理员按默认配置走完会发现"扫码没反应"却毫无线索。
//
// 明文模式下没有 <Encrypt> 字段，调用方据此分支即可。

/** EncodingAESKey 是 43 位 base64（缺一个 =），补上后正好解出 32 字节 AES 密钥。 */
function aesKeyOf(encodingAesKey) {
  const key = Buffer.from(`${String(encodingAesKey ?? '').trim()}=`, 'base64')
  if (key.length !== 32) throw new Error('EncodingAESKey 不是合法的 43 位密钥')
  return key
}

/** 微信的填充块大小是 32 而不是 AES 默认的 16，必须手动处理。 */
function stripPkcs7(buffer, blockSize) {
  const pad = buffer[buffer.length - 1]
  if (!pad || pad > blockSize || pad > buffer.length) return buffer
  return buffer.subarray(0, buffer.length - pad)
}

function addPkcs7(buffer, blockSize) {
  const pad = blockSize - (buffer.length % blockSize)
  return Buffer.concat([buffer, Buffer.alloc(pad, pad)])
}

/**
 * 解密一条微信推送。
 * 明文格式：随机 16 字节 + 消息长度(4 字节大端) + 消息体 + AppID。
 * 尾部带 AppID 是微信的防伪设计——能确认这条密文确实是发给自己的。
 */
export function decryptWechatMessage(encodingAesKey, encrypt) {
  const key = aesKeyOf(encodingAesKey)
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)

  const plain = stripPkcs7(
    Buffer.concat([decipher.update(Buffer.from(String(encrypt ?? ''), 'base64')), decipher.final()]),
    32,
  )
  if (plain.length < 20) throw new Error('解密后的内容过短，EncodingAESKey 可能不匹配')

  const msgLength = plain.readUInt32BE(16)
  if (20 + msgLength > plain.length) throw new Error('解密后的消息长度越界')

  return {
    message: plain.subarray(20, 20 + msgLength).toString('utf-8'),
    appId: plain.subarray(20 + msgLength).toString('utf-8'),
  }
}

/** 加密一条被动回复。安全模式下回复也必须是密文，否则微信会当作无效响应。 */
export function encryptWechatMessage(encodingAesKey, appId, message) {
  const key = aesKeyOf(encodingAesKey)
  const lengthBuffer = Buffer.alloc(4)
  const messageBuffer = Buffer.from(String(message ?? ''), 'utf-8')
  lengthBuffer.writeUInt32BE(messageBuffer.length, 0)

  const payload = addPkcs7(
    Buffer.concat([randomBytes(16), lengthBuffer, messageBuffer, Buffer.from(String(appId), 'utf-8')]),
    32,
  )

  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(payload), cipher.final()]).toString('base64')
}

/** 安全 / 兼容模式下的被动回复报文。 */
export function buildEncryptedReply(encrypt, signature, timestamp, nonce) {
  return `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt><MsgSignature><![CDATA[${signature}]]></MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce><![CDATA[${nonce}]]></Nonce></xml>`
}

/**
 * 从微信推送的 XML 里取字段。
 *
 * 故意不引入 XML 解析库：本项目服务端零运行时依赖是硬约束，而微信推送的结构完全固定，
 * 只需要把 <Tag><![CDATA[value]]></Tag> 和 <Tag>value</Tag> 两种形态都认下来。
 *
 * 无 CDATA 那一支限定 `[^<]*` 而不是 `[\s\S]*?`：否则最外层的 <xml> 会把整段内层
 * 内容当成自己的值吞掉，取出来的字段全是空的。
 */
export function parseWechatXml(xml) {
  const result = {}
  if (typeof xml !== 'string' || !xml) return result

  const pattern = /<(\w+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g
  let match = pattern.exec(xml)
  while (match) {
    result[match[1]] = match[2] ?? match[3] ?? ''
    match = pattern.exec(xml)
  }
  return result
}

/**
 * 从事件里解析出「扫码登录」的意图。
 *
 * - subscribe：用户**首次关注**并扫了码，EventKey 形如 `qrscene_<scene>`
 * - SCAN：用户**已关注**后扫码，EventKey 就是 `<scene>`
 *
 * 其它事件（取关、菜单点击等）返回 null，由调用方忽略。
 */
export function parseScanEvent(fields) {
  if (fields.MsgType !== 'event') return null
  const event = String(fields.Event ?? '').toLowerCase()
  const eventKey = String(fields.EventKey ?? '')

  if (event === 'subscribe') {
    // 普通搜索关注没有 EventKey，只有扫码关注才有 qrscene_ 前缀。
    if (!eventKey.startsWith('qrscene_')) return { kind: 'subscribe', scene: '' }
    return { kind: 'subscribe', scene: eventKey.slice('qrscene_'.length) }
  }
  if (event === 'scan') return { kind: 'scan', scene: eventKey }
  return null
}

/** 微信消息去重。返回 true 表示这条已经处理过了。 */
export function markMessageSeen(key) {
  const now = Date.now()
  if (seenMessages.has(key)) return true
  seenMessages.set(key, now)
  if (seenMessages.size > 5_000) prune()
  return false
}

/**
 * 把一条推送归成"这次登录想干什么"。
 *
 * 返回四种之一：
 * - `{ kind: 'scan', scene }`     带了带参二维码的扫码（需要已认证公众号）
 * - `{ kind: 'code', code }`      用户回复了登录验证码（任何公众号都能用）
 * - `{ kind: 'subscribe' }`       首次关注但没带 scene——该回一条引导语
 * - `null`                        与登录无关的消息（取关、菜单点击、普通闲聊等）
 */
export function parseIncomingMessage(fields) {
  const scan = parseScanEvent(fields)
  if (scan) {
    if (scan.scene) return { kind: 'scan', scene: scan.scene, event: scan.kind }
    return { kind: 'subscribe' }
  }

  if (fields.MsgType === 'text') {
    const code = parseLoginCode(fields.Content)
    if (code) return { kind: 'code', code }
  }

  return null
}

/** 被动回复一条文本消息。微信要求 5 秒内响应，且必须回 'success' 或一段合法 XML。 */
export function buildTextReply(toUser, fromUser, content) {
  const escaped = String(content ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<xml><ToUserName><![CDATA[${toUser}]]></ToUserName><FromUserName><![CDATA[${fromUser}]]></FromUserName><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${escaped}]]></Content></xml>`
}

// ===== 用户资料 =====

/**
 * 拉取关注者昵称头像。
 * 需要账号已认证——认证订阅号和认证服务号都有这个权限，未认证的订阅号会返回 48001。
 * 所以这里**吞掉异常返回 null**，让登录流程继续走降级路径，而不是因为拿不到头像就把人挡在门外。
 */
export async function fetchUserProfile(wechat, openid) {
  try {
    const token = await getAccessToken(wechat)
    const url = `${API_BASE}/cgi-bin/user/info?access_token=${encodeURIComponent(token)}&openid=${encodeURIComponent(openid)}&lang=zh_CN`
    const payload = await wechatFetch(url)
    return {
      openid,
      nickname: typeof payload.nickname === 'string' ? payload.nickname : '',
      avatar: typeof payload.headimgurl === 'string' ? payload.headimgurl : '',
      unionid: typeof payload.unionid === 'string' ? payload.unionid : '',
      subscribed: payload.subscribe === 1,
    }
  } catch (err) {
    console.warn('拉取微信用户资料失败（将使用占位昵称）：', err instanceof Error ? err.message : err)
    return null
  }
}

/** 拿不到真实昵称时的占位名。用 openid 尾部而不是随机数，至少同一个人每次登录是同一个名字。 */
export function fallbackNickname(openid) {
  const tail = String(openid ?? '').slice(-4).toUpperCase() || '0000'
  return `微信用户${tail}`
}

/**
 * 派生一个合法用户名。
 * 用户名限制是 `[a-zA-Z0-9][a-zA-Z0-9_.-]{1,31}`，而 openid 里可能有 - 和 _，
 * 所以直接取字母数字部分，再补前缀保证以字母开头。
 */
export function deriveUsername(openid) {
  const cleaned = String(openid ?? '').replace(/[^a-zA-Z0-9]/g, '')
  return `wx_${cleaned.slice(-16) || 'unknown'}`
}
