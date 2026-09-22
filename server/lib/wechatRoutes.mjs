// 微信登录相关接口。
//
// 两种登录方式共用一套对前端的契约（发起 → 轮询），差异全在这里消化掉：
//
//   code 模式（默认）  前端显示「公众号二维码 + 6 位验证码」，
//                      用户扫码关注后在公众号里回复验证码，电脑端轮询到即可登录。
//                      未认证订阅号也能用，且不需要 access_token 与 IP 白名单。
//
//   qrcode 模式        直接生成「带参数二维码」，扫码即登录。
//                      体验更好，但只有已认证的公众号才能调用该接口。
//
// 用户建号与下发会话都发生在**轮询**这一步，而不是微信推送那一步——
// 推送是微信服务器发来的，拿不到浏览器上下文，自然也就种不了 cookie。

import { randomBytes } from 'node:crypto'

import { grantSignupBonus, userCreditsView } from './credits.mjs'
import { HttpError, readRawBody, sendBinary, sendJson, sendText, setCookie } from './http.mjs'
import { GUEST_COOKIE, createSession } from './sessions.mjs'
import { findUserById, findUserByOpenId, getConfig, normalizeUser, toPublicUser, updateConfig } from './store.mjs'
import {
  bindCodeToOpenid,
  bindSceneToOpenid,
  buildEncryptedReply,
  buildTextReply,
  consumeLoginSession,
  createLoginQrcode,
  decryptWechatMessage,
  encryptWechatMessage,
  fallbackNickname,
  fetchUserProfile,
  getQrcodeImage,
  isWechatConfigured,
  issueLoginCode,
  markMessageSeen,
  parseIncomingMessage,
  parseWechatXml,
  readLoginSession,
  verifyWechatMsgSignature,
  verifyWechatSignature,
  wechatSignature,
} from './wechat.mjs'

/** 微信推送的 XML 很小，256KB 已经远远够用，设上限只是防滥用。 */
const MAX_CALLBACK_BYTES = 256 * 1024

function genUserId() {
  return `u-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

/** 默认文案。管理员可以用后台的「关注回复文案」覆盖最常用的那一条。 */
const DEFAULT_SUBSCRIBE_REPLY = '欢迎关注！请把电脑网页上显示的 6 位数字发给我，即可完成登录。'
const DEFAULT_CODE_OK_REPLY = '登录成功，请回到电脑网页继续操作。'
const DEFAULT_CODE_FAIL_REPLY = '这个验证码不对或已经过期了，请回网页刷新后重新获取。'

/**
 * 关注引导语支持自定义——它是用户唯一一次会认真读的说明，值得让管理员自己措辞。
 * 成功/失败回执保持内置：它们没有措辞空间，多两个配置项只是多两处会配错的地方。
 */
function resolveSubscribeReply(site) {
  return String(site.wechat?.replyText ?? '').trim() || DEFAULT_SUBSCRIBE_REPLY
}

// ===== 发起登录 =====

export async function startWechatLogin(req, res) {
  const site = getConfig().site
  if (!isWechatConfigured(site.wechat)) {
    throw new HttpError(503, '管理员尚未完成微信登录配置（需要 AppID、AppSecret 与 Token）')
  }

  if (site.wechat.loginMode === 'qrcode') {
    try {
      const result = await createLoginQrcode(site.wechat)
      return sendJson(res, 200, {
        mode: 'qrcode',
        pollToken: result.pollToken,
        qrUrl: result.qrUrl,
        expiresIn: result.expiresIn,
      })
    } catch (err) {
      // 未认证订阅号调用「生成带参数的二维码」必然失败。把原因说清楚，
      // 并把界面降级到验证码模式——总好过让用户在登录页上干瞪眼。
      const message = err instanceof Error ? err.message : '二维码生成失败'
      const result = issueLoginCode()
      return sendJson(res, 200, {
        mode: 'code',
        pollToken: result.pollToken,
        code: result.code,
        expiresIn: result.expiresIn,
        qrImage: site.wechat.qrcodeImage || '',
        degraded: true,
        degradedReason: `${message}。已自动切换到验证码登录。`,
      })
    }
  }

  const result = issueLoginCode()
  return sendJson(res, 200, {
    mode: 'code',
    pollToken: result.pollToken,
    code: result.code,
    expiresIn: result.expiresIn,
    qrImage: site.wechat.qrcodeImage || '',
  })
}

// ===== 轮询登录结果 =====

export async function pollWechatLogin(req, res, ctx) {
  const token = new URLSearchParams(ctx.search ?? '').get('t') ?? ''
  const state = readLoginSession(token)

  if (state.status === 'pending') return sendJson(res, 200, { status: 'pending' })
  if (state.status === 'expired') return sendJson(res, 200, { status: 'expired' })

  const user = await ensureWechatUser(state.openid)
  if (!user) throw new HttpError(403, '该账号已被停用，请联系管理员')
  if (!user.enabled) throw new HttpError(403, '该账号已被停用，请联系管理员')

  // 令牌只在成功这一次有效，避免同一张二维码被反复用来换会话。
  consumeLoginSession(token)

  const session = createSession('guest', user.id)
  setCookie(req, res, GUEST_COOKIE, session.token, session.maxAgeSeconds)

  return sendJson(res, 200, {
    status: 'ok',
    user: toPublicUser(user),
    workspaceId: user.id,
    credits: getConfig().site.credits.enabled ? userCreditsView(user.id) : null,
  })
}

/**
 * 按 openid 找号，找不到就建一个。
 *
 * 昵称头像是可选增强：`cgi-bin/user/info` 只有已认证服务号能调，
 * 订阅号会返回 48001。所以拉不到就用「微信用户 xxxx」占位，
 * 绝不允许"拿不到昵称"变成"登录失败"。
 */
async function ensureWechatUser(openid) {
  const existing = findUserByOpenId(openid)
  if (existing) {
    // 顺带刷新一下最近登录时间，同时把订阅状态更新掉（用户可能中途取关又回关）。
    updateConfig((config) => {
      const idx = config.users.findIndex((user) => user.id === existing.id)
      if (idx >= 0) config.users[idx] = { ...config.users[idx], lastSeenAt: Date.now() }
      return config
    })
    return findUserById(existing.id)
  }

  const site = getConfig().site
  const profile = site.wechat.fetchProfile
    ? await fetchUserProfile(site.wechat, openid)
    : null

  const now = Date.now()
  const id = genUserId()
  const nickname = profile?.nickname || fallbackNickname(openid)

  updateConfig((config) => {
    config.users.push(normalizeUser({
      id,
      // 用户名只是给后台看的标识，真正的主键是 openid。用 openid 派生保证唯一且合法。
      username: deriveUniqueUsername(config, openid),
      displayName: nickname,
      passwordHash: '',
      enabled: true,
      note: '微信扫码登录',
      createdVia: 'wechat',
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      wechatOpenId: openid,
      wechatUnionId: profile?.unionid ?? '',
      wechatNickname: profile?.nickname ?? '',
      wechatAvatar: profile?.avatar ?? '',
      wechatSubscribed: profile?.subscribed ?? true,
    }, id))
    return config
  })

  // 注册赠送只在新号上发一次，老用户重新登录不会重复领。
  const bonus = getConfig().site.credits.signupBonus
  if (bonus > 0) grantSignupBonus(id, bonus, { ref: 'wechat' })

  return findUserById(id)
}

/** openid 派生用户名，撞名时补后缀。用户名本身不参与登录，只要唯一且合法即可。 */
function deriveUniqueUsername(config, openid) {
  const base = `wx_${String(openid).replace(/[^a-zA-Z0-9]/g, '').slice(-16) || randomBytes(4).toString('hex')}`
  if (!config.users.some((user) => user.username.toLowerCase() === base.toLowerCase())) return base
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}_${i}`
    if (!config.users.some((user) => user.username.toLowerCase() === candidate.toLowerCase())) return candidate
  }
  return `${base}_${randomBytes(3).toString('hex')}`
}

// ===== 图片 =====

/** 带参数二维码图片。同源转发，省得前端去连 mp.weixin.qq.com。 */
export function serveSceneQrcode(res, scene) {
  const buffer = getQrcodeImage(scene)
  if (!buffer) return sendText(res, 404, '二维码已过期，请刷新页面重新获取')
  return sendBinary(res, 200, buffer, 'image/png', 300)
}

/** 公众号的固定二维码图片（管理员上传的那张），验证码模式下显示给用户扫。 */
export function serveFixedQrcode(res) {
  const raw = String(getConfig().site.wechat.qrcodeImage ?? '').trim()
  if (!raw) return sendText(res, 404, '管理员尚未上传公众号二维码图片')

  const match = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,([\s\S]+)$/i.exec(raw)
  if (!match) return sendText(res, 404, '二维码图片不是受支持的内联格式，请在后台重新上传')

  const mime = match[1].toLowerCase() === 'svg+xml' ? 'image/svg+xml' : `image/${match[1].toLowerCase()}`
  return sendBinary(res, 200, Buffer.from(match[2], 'base64'), mime, 3600)
}

// ===== 微信服务器推送 =====

/**
 * 微信服务器配置的校验与事件回调。
 *
 * GET  微信保存配置时会打过来一次，要求原样回显 echostr。
 * POST 用户扫码 / 发消息时推过来，要在 **5 秒内**响应，否则微信会重试三次。
 *      所以这里只做内存操作与一次同步落盘，不做任何外部调用。
 */
export async function handleWechatCallback(req, res, ctx) {
  const site = getConfig().site
  const wechat = site.wechat
  if (!isWechatConfigured(wechat)) throw new HttpError(503, '微信登录未配置')

  const query = Object.fromEntries(new URLSearchParams(ctx.search ?? ''))

  if (req.method === 'GET') {
    if (!verifyWechatSignature(wechat.token, query)) throw new HttpError(403, '签名校验失败，请核对 Token 是否与后台一致')
    return sendText(res, 200, String(query.echostr ?? ''))
  }

  if (req.method !== 'POST') throw new HttpError(405, '方法不允许')

  const raw = await readRawBody(req, MAX_CALLBACK_BYTES)
  const outer = parseWechatXml(raw)
  const encrypted = typeof outer.Encrypt === 'string' ? outer.Encrypt : ''

  // 安全模式与兼容模式的报文带 <Encrypt>，签名也换成 msg_signature。
  // 解开失败时回 'success' 而不是抛错：抛错会让微信判定推送失败并重试三次，
  // 而问题多半是密钥配错了，重试一万次也解不开，不如安静记一条日志让管理员去查。
  const payload = (() => {
    if (!encrypted) {
      if (!verifyWechatSignature(wechat.token, query)) throw new HttpError(403, '签名校验失败')
      return { xml: raw, encrypted: false }
    }
    if (!verifyWechatMsgSignature(wechat.token, query, encrypted)) {
      throw new HttpError(403, '签名校验失败（安全模式）')
    }
    if (!wechat.encodingAesKey) {
      console.warn('收到加密推送但未配置 EncodingAESKey，请到后台「微信登录」补齐')
      return null
    }
    try {
      return { xml: decryptWechatMessage(wechat.encodingAesKey, encrypted).message, encrypted: true }
    } catch (err) {
      console.warn('微信推送解密失败，请核对 EncodingAESKey：', err instanceof Error ? err.message : err)
      return null
    }
  })()

  if (!payload) return sendText(res, 200, 'success')

  const fields = parseWechatXml(payload.xml)
  const reply = buildReply(site, wechat, fields)
  if (!reply) return sendText(res, 200, 'success')

  if (!payload.encrypted) return sendText(res, 200, reply)

  const timestamp = String(query.timestamp ?? Math.floor(Date.now() / 1000))
  const nonce = String(query.nonce ?? '')
  const cipher = encryptWechatMessage(wechat.encodingAesKey, wechat.appId, reply)
  return sendText(res, 200, buildEncryptedReply(cipher, wechatSignature(wechat.token, timestamp, nonce, cipher), timestamp, nonce))
}

/**
 * 处理一条推送，返回要回给微信的内容（XML）或 null（表示只回 'success'）。
 * 副作用都在这里发生：绑定 scene 或验证码到 openid。
 */
function buildReply(site, wechat, fields) {
  const fromUser = String(fields.FromUserName ?? '')
  const toUser = String(fields.ToUserName ?? '')
  if (!fromUser) return null

  // 微信会重试推送，用「发送者 + 时间 + 事件」去重，避免一条消息被处理两次。
  const dedupeKey = `${fromUser}|${fields.CreateTime ?? ''}|${fields.Event ?? ''}|${fields.MsgId ?? ''}|${fields.Content ?? ''}`
  if (markMessageSeen(dedupeKey)) return null

  const message = parseIncomingMessage(fields)
  if (!message) return null

  if (message.kind === 'scan') {
    bindSceneToOpenid(message.scene, fromUser)
    return buildTextReply(fromUser, toUser, DEFAULT_CODE_OK_REPLY)
  }

  if (message.kind === 'subscribe') {
    return buildTextReply(fromUser, toUser, resolveSubscribeReply(site))
  }

  if (message.kind === 'code') {
    const result = bindCodeToOpenid(message.code, fromUser)
    return buildTextReply(fromUser, toUser, result.ok ? DEFAULT_CODE_OK_REPLY : DEFAULT_CODE_FAIL_REPLY)
  }

  return null
}
