// 零依赖 SMTP 客户端：只为「发注册验证码」这类事务邮件服务。
//
// 为什么手写而不是引 nodemailer：
// 本项目的服务端有一条硬约束——**零运行时依赖**。deploy/Dockerfile.server 只把
// dist / server / package.json 拷进镜像然后 `node server/index.mjs`，运行时根本
// 没有 node_modules。发验证码只需要「连上去 → EHLO → AUTH → 投一封信 → 退出」这五步，
// 用 node:net / node:tls 直连比引一个上百 KB 的库更可控，也少一个供应链风险面。
//
// 三种加密方式，覆盖主流邮箱：
// - ssl      （默认端口 465）连上去就是 TLS。QQ / 163 / 腾讯企业邮的默认选择。
// - starttls （默认端口 587）先明文握手，在 AUTH **之前**升级成 TLS。Gmail、Postfix、
//            多数自建邮局走这条。升级失败一律中止，绝不把授权码明文发出去。
// - none     （默认端口 25）完全明文。只给「同机 / 内网中继」用，比如 docker network
//            里的 postfix 或本地 MailHog。选它意味着授权码会以明文过网，界面要警告。
//
// 关于凭证：QQ / 163 / 企业邮这类个人邮箱**不能用网页登录密码**，必须先在邮箱后台
// 开启 SMTP 服务并生成「授权码 / 客户端专用密码」，那才是这里的 password。踩这个坑
// 的人非常多，所以 535 的错误提示专门点了这件事。

import { randomBytes } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { connect as tlsConnect } from 'node:tls'

/** 单次读写的空闲超时：这段时间内服务器一个字节都没发，就认定它挂了。 */
const DEFAULT_IDLE_TIMEOUT_MS = 15_000

/** 整封信的总预算。防的是「服务器慢速滴字节」把连接拖住不放手。 */
const DEFAULT_TOTAL_TIMEOUT_MS = 30_000

/** 一次响应最多多少行。EHLO 的能力列表可能很长，但 200 行足够，再多一定是服务器坏了。 */
const MAX_REPLY_LINES = 200

/** 错误信息里回显服务器原文的长度上限，避免把一大坨 HTML 错误页塞进日志。 */
const MAX_REPLY_TEXT = 300

/**
 * 一个 encoded-word 里最多塞多少**原始 UTF-8 字节**。
 * RFC 2047 规定 encoded-word 整体不超过 75 字符，其中 `=?UTF-8?B?` 占 10、`?=` 占 2，
 * 所以 base64 部分最多 63 字符。取 42 字节（→ 56 个 base64 字符 → 整体 68 字符）是为了
 * 给 `Subject: ` 这类头部前缀留出空间，让折行后每行都不超过 RFC 5322 建议的 78 字符。
 */
const MAX_ENCODED_WORD_BYTES = 42

/** base64 正文的折行宽度，RFC 2045 规定不得超过 76。 */
const BASE64_LINE_LENGTH = 76

/** 需要引号包起来的 ASCII 字符之外的东西；含空格是合法的 atext 扩展。 */
const PLAIN_ATEXT = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~. ]+$/

/** 加密方式。`none` 是明文，只给内网中继用。 */
export const SMTP_ENCRYPTIONS = new Set(['ssl', 'starttls', 'none'])

/**
 * 常见邮箱的连通参数，给管理后台做下拉预设用。
 * `note` 会原样显示在界面上，专门用来提醒「密码填授权码」这类必踩的坑。
 */
export const SMTP_PRESETS = [
  {
    id: 'qq',
    label: 'QQ 邮箱 / Foxmail',
    host: 'smtp.qq.com',
    port: 465,
    encryption: 'ssl',
    note: '要先在「设置 → 账号 → POP3/IMAP/SMTP 服务」里开启 SMTP 服务，然后拿到一串 16 位授权码。下面密码栏填授权码，不是 QQ 登录密码。',
  },
  {
    id: 'qq-exmail',
    label: '腾讯企业邮',
    host: 'smtp.exmail.qq.com',
    port: 465,
    encryption: 'ssl',
    note: '用完整企业邮箱地址登录，密码填「客户端专用密码」。发信额度比个人版高得多，长期运营建议换这个。',
  },
  {
    id: '163',
    label: '网易 163 / 126',
    host: 'smtp.163.com',
    port: 465,
    encryption: 'ssl',
    note: '密码栏填「客户端授权密码」，在网易邮箱设置里开启 SMTP 后生成。',
  },
  {
    id: 'aliyun',
    label: '阿里云企业邮',
    host: 'smtp.qiye.aliyun.com',
    port: 465,
    encryption: 'ssl',
    note: '用完整邮箱地址登录，密码填客户端专用密码。',
  },
  {
    id: 'gmail',
    label: 'Gmail',
    host: 'smtp.gmail.com',
    port: 465,
    encryption: 'ssl',
    note: '需要先开启两步验证并生成「应用专用密码」。注意国内服务器连 Gmail 通常不通，且发往国内邮箱极易进垃圾箱。',
  },
  {
    id: 'starttls',
    label: '标准 SMTP + STARTTLS（587）',
    host: '',
    port: 587,
    encryption: 'starttls',
    note: 'Postfix、Mailcow 等自建邮局的常见配置。',
  },
]

/**
 * SMTP 错误。带上出错阶段、服务器原始回应和一句人话提示，
 * 让管理后台能直接显示「哪里错了、大概怎么改」，而不是甩一个 535。
 */
export class SmtpError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'SmtpError'
    /** 出错的阶段：connect / greeting / ehlo / starttls / auth / from / rcpt / data / quit */
    this.stage = options.stage ?? ''
    /** SMTP 三位码（字符串）或 Node 的错误码（ECONNREFUSED 等）。 */
    this.code = String(options.code ?? '')
    /** 服务器回的原始文字。 */
    this.reply = options.reply ?? ''
    /** 人话提示，给非技术管理员看的。 */
    this.hint = options.hint ?? ''
  }
}

// ---------------------------------------------------------------- 错误码翻译

const CODE_HINTS = {
  // --- SMTP 三位码 ---
  421: '服务器暂时不可用，最常见的原因是发信频率或当日额度超限。等一会儿再试，或换个发信邮箱。',
  450: '对方服务器暂时拒绝，通常是收件人不存在或对方在限流。',
  451: '服务器处理时出错，稍后重试。',
  452: '服务器存储空间不足，稍后重试。',
  500: '服务器不认识这条指令，一般是服务器地址或端口配错了。',
  501: '指令参数不合法，多半是邮箱地址格式有问题。',
  502: '服务器未实现该指令，换个端口或加密方式试试。',
  503: '指令顺序不对。服务器要求先加密或先认证时会出现，检查加密方式有没有选对。',
  504: '服务器不支持该参数，常见于它不支持你选的认证方式。',
  530: '服务器要求先认证。STARTTLS 没生效或用户名密码没填时会出现。',
  534: '服务器不允许这种认证方式，请改用邮箱授权码而不是登录密码。',
  535: '认证失败：账号或密码不对。QQ、163 等邮箱这里必须填「SMTP 授权码 / 客户端专用密码」，不是网页登录密码。',
  538: '服务器要求先加密再认证，检查端口和加密方式是否匹配（465 配 ssl、587 配 starttls）。',
  550: '收件地址被拒。可能是地址不存在、被对方拉黑，或发件地址与登录账号不是同一个邮箱。',
  551: '收件地址不可达。',
  552: '对方邮箱已满。',
  553: '发件地址不合法，要填完整邮箱地址（形如 someone@example.com）。',
  554: '服务器拒绝本次投递，通常是内容被判成垃圾邮件了。',

  // --- Node / 系统错误码 ---
  EINVAL: '配置不完整或格式不对，检查服务器地址、端口和收发件人。',
  ECONNREFUSED: '连接被拒绝：主机或端口不对，也可能被防火墙拦了。',
  ENOTFOUND: '域名解析失败，检查 SMTP 服务器地址有没有拼错。',
  EAI_AGAIN: '域名解析暂时失败，稍后重试。',
  ETIMEDOUT: '连接超时：网络不通，或被服务器、防火墙丢包了。',
  ESOCKETTIMEDOUT: '连接超时：网络不通，或被服务器、防火墙丢包了。',
  ECONNRESET: '连接被服务器重置。常见于明文连接被要求加密的严格邮局。',
  EHOSTUNREACH: '主机不可达，检查网络和端口。',
  EPIPE: '连接中途断开，可能是服务器主动关闭了连接。',
  EPROTO: 'TLS 协商失败，通常是端口与加密方式不匹配（465 要 SSL，587 要 STARTTLS）。',
  ERR_SSL_WRONG_VERSION_NUMBER: '按明文去连一个只接受 SSL 的端口了，把加密方式改成 SSL。',
  ERR_SSL_PACKET_LENGTH_TOO_LONG: '加密方式选错了：这个端口不接受 SSL，试试 STARTTLS。',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '服务器证书无法验证。自建邮局常见，确认证书链完整，或勾选「跳过证书校验」。',
  DEPTH_ZERO_SELF_SIGNED_CERT: '服务器用的是自签证书。确认是可信的自建邮局后再勾选「跳过证书校验」。',
  SELF_SIGNED_CERT_IN_CHAIN: '证书链里混进了自签证书。确认可信后勾选「跳过证书校验」。',
  CERT_HAS_EXPIRED: '服务器证书已过期，需要对方更换证书。',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书上的域名和服务器地址对不上，检查服务器地址是否写错。',
  ERR_TLS_HANDSHAKE_TIMEOUT: 'TLS 握手超时，检查端口和加密方式是否匹配。',
}

/** 把错误码（SMTP 三位码或 Node 错误码）翻成一句人话。查不到返回空串。 */
export function hintForCode(code) {
  const key = String(code ?? '')
  return CODE_HINTS[key] ?? ''
}

/** 任何异常都归一成 SmtpError，免得上层要同时处理 Error / SmtpError 两套形状。 */
export function toSmtpError(error, stage = '') {
  if (error instanceof SmtpError) return error
  const code = String(error?.code ?? '')
  const message = error?.message ? String(error.message) : 'SMTP 操作失败'
  return new SmtpError(message, { stage, code, hint: hintForCode(code) })
}

/**
 * 给管理后台用的错误文案：把「发生了什么」和「怎么改」拼成一句。
 * 前台永远看不到这个——验证码发不出去时只会告诉用户"稍后重试"。
 */
export function describeSmtpError(error) {
  const detail = toSmtpError(error)
  const hint = detail.hint || hintForCode(detail.code)
  const where = detail.stage ? `（阶段：${describeStage(detail.stage)}）` : ''
  const reply = detail.reply ? `，服务器回应：${truncate(detail.reply)}` : ''
  const head = `${detail.message}${where}${reply}`
  return hint ? `${head} —— ${hint}` : head
}

/** 阶段名翻译，出现在错误文案里，得是人话。 */
export function describeStage(stage) {
  const names = {
    connect: '建立连接',
    greeting: '读取欢迎语',
    ehlo: 'EHLO 握手',
    starttls: 'STARTTLS 加密升级',
    auth: '身份认证',
    from: '发件人',
    rcpt: '收件人',
    data: '传输正文',
    quit: '断开连接',
  }
  return names[stage] ?? stage
}

function truncate(text, limit = MAX_REPLY_TEXT) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

// ---------------------------------------------------------------- 小工具

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeInt(value, fallback, min, max) {
  const num = Math.trunc(Number(value))
  if (!Number.isFinite(num)) return fallback
  return Math.min(Math.max(num, min), max)
}

function domainOf(address) {
  const parts = String(address ?? '').split('@')
  return parts.length === 2 && parts[1] ? parts[1] : ''
}

/**
 * 邮件头部注入防护。
 * 邮件头是靠 CRLF 分行的，任何来自用户输入（主题、昵称、邮箱名）的换行
 * 都可能伪造出额外的头部（比如塞一个 Bcc 进去）。统一把换行压成空格。
 */
export function sanitizeHeaderText(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
}

/**
 * 只接受一个干净的邮箱地址。
 * 允许外面包尖括号；拒绝任何空白或不安全字符——这同时也是注入防线。
 */
export function normalizeAddress(value) {
  const raw = sanitizeHeaderText(value).replace(/^<+|>+$/g, '').trim()
  if (!raw) return ''
  if (!/^[^\s@<>,;:\\"()[\]]+@[^\s@<>,;:\\"()[\]]+$/.test(raw)) {
    throw new SmtpError(`邮箱地址格式不合法：${truncate(raw)}`, { code: 'EINVAL', stage: 'connect' })
  }
  return raw
}

/**
 * 解析「昵称 <a@b.com>」或裸地址。
 * 管理后台里管理员经常直接从别处复制一整个 "GPT Image <a@b.com>" 粘进来，
 * 直接当地址校验会失败，所以这里顺手拆一下。
 */
export function parseAddressInput(value, fallbackName = '') {
  // 也接受 { address, name } 形状，这样 buildMimeMessage 的入参能直接喂进来。
  if (isRecord(value)) {
    const name = sanitizeHeaderText(value.name)
    return { address: normalizeAddress(value.address), name: name || fallbackName }
  }
  const text = sanitizeHeaderText(value)
  const withName = /^(.*?)\s*<([^>]+)>\s*$/.exec(text)
  if (withName) {
    const name = withName[1].replace(/^"(.*)"$/, '$1').trim()
    return { address: normalizeAddress(withName[2]), name: name || fallbackName }
  }
  return { address: normalizeAddress(text), name: fallbackName }
}

/** 收件人允许多个：字符串按逗号/分号/换行拆，也接受数组。 */
function toRecipientList(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(/[,;\n]+/)
  const recipients = []
  for (const item of items) {
    const parsed = parseAddressInput(item)
    if (parsed.address) recipients.push(parsed)
  }
  return recipients
}

// ---------------------------------------------------------------- MIME 拼装

/** 纯 ASCII 可见字符就不用编码：可读性最好，兼容性也最好。 */
function needsEncoding(text) {
  if (/[^\x20-\x7e]/.test(text)) return true
  // 控制字符（含 tab）会让头部结构变形，一并编码掉。
  if (/[\x00-\x1f\x7f]/.test(text)) return true
  // ASCII 但长得像 encoded-word 的，原样发出去可能被对方解码器误判。
  return /=\?[^?]*\?[bBqQ]\?/.test(text)
}

/**
 * 长 ASCII 值按空格折行。折行处的空白在解码时会被还原成一个空格，语义不变。
 * 单个超长词（比如一条长 URL）折不开放弃折行，RFC 允许一行到 998 字符。
 */
function foldAsciiHeader(text, maxLength = 76) {
  if (text.length <= maxLength) return text
  const words = text.split(' ')
  const lines = []
  let line = ''
  for (const word of words) {
    if (!line) {
      line = word
      continue
    }
    if (line.length + 1 + word.length > maxLength) {
      lines.push(line)
      line = word
      continue
    }
    line += ` ${word}`
  }
  if (line) lines.push(line)
  return lines.join('\r\n ')
}

/**
 * RFC 2047 头部编码。非 ASCII（中文主题、中文发件人昵称）必须走这里，
 * 否则邮件客户端会显示成一堆乱码，或者干脆判成非法头部丢信。
 *
 * 切分时优先切在空格后面，并且**把空格本身留在前一段里**——
 * 这样空格是被 base64 编码保护的，而 encoded-word 之间用来折行的那个空白
 * 会被解码器丢掉，两者不会互相污染，解码后原文一字不差。
 */
export function encodeHeaderValue(value, maxBytesPerWord = MAX_ENCODED_WORD_BYTES) {
  const text = sanitizeHeaderText(value)
  if (!text) return ''
  if (!needsEncoding(text)) return foldAsciiHeader(text)

  const chars = [...text]
  const words = []
  let start = 0

  while (start < chars.length) {
    let bytes = 0
    let index = start
    let cutAt = -1
    let cutBytes = 0

    while (index < chars.length) {
      const charBytes = Buffer.byteLength(chars[index], 'utf-8')
      if (bytes + charBytes > maxBytesPerWord) break
      bytes += charBytes
      // 空格作为候选切点：切在它后面，它自己留在本段内被编码。
      if (chars[index] === ' ') {
        cutAt = index + 1
        cutBytes = bytes
      }
      index += 1
    }

    // 剩下的全部装得下，收工。
    if (index >= chars.length) {
      words.push(chars.slice(start).join(''))
      break
    }
    // 一个字符就超限（4 字节的 emoji 也远小于上限，正常到不了这里），强行推进一步防死循环。
    if (index === start) index = start + 1

    if (cutAt > start) {
      words.push(chars.slice(start, cutAt).join(''))
      start = cutAt
    } else {
      words.push(chars.slice(start, index).join(''))
      start = index
    }
    void cutBytes
  }

  return words
    .filter((word) => word.length > 0)
    .map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf-8').toString('base64')}?=`)
    .join('\r\n ')
}

/** 按 RFC 5322 的输出地址：`昵称 <a@b.com>`，需要时给昵称编码或加引号。 */
export function formatAddress(entry) {
  const address = sanitizeHeaderText(entry?.address ?? '')
  const name = sanitizeHeaderText(entry?.name ?? '')
  if (!name) return `<${address}>`
  const rendered = needsEncoding(name)
    ? encodeHeaderValue(name)
    : PLAIN_ATEXT.test(name)
      ? name
      : `"${name.replace(/(["\\])/g, '\\$1')}"`
  return `${rendered} <${address}>`
}

/** RFC 5322 日期，形如 `Mon, 22 Sep 2026 17:00:00 +0000`。 */
export function formatMailDate(input) {
  const date = input instanceof Date ? input : input ? new Date(input) : new Date()
  const valid = Number.isFinite(date.getTime()) ? date : new Date()
  return valid.toUTCString().replace(/GMT$/, '+0000')
}

/** Message-ID 的域名部分取自发件人地址：多数反垃圾策略会核对这一点。 */
export function generateMessageId(fromAddress) {
  const domain = domainOf(fromAddress).replace(/[^A-Za-z0-9.-]/g, '') || 'localhost'
  return `<${Date.now().toString(36)}.${randomBytes(8).toString('hex')}@${domain}>`
}

export function generateBoundary() {
  return `----=_Part_${randomBytes(12).toString('hex')}`
}

/** base64 按 76 字符折行。不折行的话一行几千字符会撞上 SMTP 的 998 字节上限。 */
export function wrapBase64(buffer, lineLength = BASE64_LINE_LENGTH) {
  const raw = buffer.toString('base64')
  const lines = []
  for (let index = 0; index < raw.length; index += lineLength) {
    lines.push(raw.slice(index, index + lineLength))
  }
  return lines.join('\r\n')
}

/**
 * 拼一封完整的 RFC 5322 邮件。
 *
 * 正文一律 base64：中文正文用 8bit 裸传要赌每一跳都支持 8BITMIME，
 * 而 base64 是纯 ASCII，任何环境下都不会被中间环节改坏。
 * 同时给纯文本和 HTML 时用 multipart/alternative，客户端自己挑。
 */
export function buildMimeMessage(options) {
  const from = { address: options.from?.address, name: options.from?.name }
  const recipients = (options.recipients ?? []).filter((item) => item?.address)
  const text = options.text == null ? '' : String(options.text)
  const html = options.html ? String(options.html) : ''
  if (!html && !text) {
    throw new SmtpError('邮件正文是空的', { code: 'EINVAL', stage: 'data' })
  }

  const headers = [
    `From: ${formatAddress(from)}`,
    `To: ${recipients.map(formatAddress).join(', ')}`,
    `Subject: ${encodeHeaderValue(options.subject)}`,
    `Date: ${formatMailDate(options.date)}`,
    `Message-ID: ${options.messageId ?? generateMessageId(from.address)}`,
    'MIME-Version: 1.0',
  ]

  if (html && text) {
    const boundary = options.boundary ?? generateBoundary()
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    const body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(Buffer.from(text, 'utf-8')),
      `--${boundary}`,
      'Content-Type: text/html; charset="utf-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(Buffer.from(html, 'utf-8')),
      `--${boundary}--`,
    ]
    return `${headers.join('\r\n')}\r\n\r\n${body.join('\r\n')}\r\n`
  }

  const single = html || text
  headers.push(`Content-Type: text/${html ? 'html' : 'plain'}; charset="utf-8"`)
  headers.push('Content-Transfer-Encoding: base64')
  return `${headers.join('\r\n')}\r\n\r\n${wrapBase64(Buffer.from(single, 'utf-8'))}\r\n`
}

/**
 * 把整封信转成 DATA 阶段的字节。
 * 两件事必须做对，否则会静默损坏邮件：
 * 1. 换行统一成 CRLF——SMTP 只认 CRLF，裸 LF 会被部分服务器当成正文的一部分。
 * 2. dot-stuffing——正文里单独成行的 `.` 是结束标记，必须写成 `..`。
 * 最后补上独立的 `.\r\n` 作为结束行。
 */
export function encodeDataPayload(message) {
  const normalized = String(message).replace(/\r\n|\r|\n/g, '\r\n')
  const stuffed = normalized.replace(/^\./gm, '..')
  const terminated = stuffed.endsWith('\r\n') ? stuffed : `${stuffed}\r\n`
  return `${terminated}.\r\n`
}

// ---------------------------------------------------------------- 会话

/**
 * 一次 SMTP 会话。只做两件事：按行读、按行写。
 *
 * 用「单个等待者」而不是队列：SMTP 是严格的请求-响应协议，
 * 同一时刻只可能有一个读挂在上面。
 */
class SmtpSession {
  constructor(socket, idleTimeoutMs) {
    this.socket = socket
    this.idleTimeoutMs = idleTimeoutMs
    this.stage = 'connect'
    this.failure = null
    this.buffer = ''
    this.waiter = null
    this.closed = false
    this.detached = false
    this.decoder = new StringDecoder('utf-8')

    this._onData = (chunk) => {
      this.buffer += this.decoder.write(chunk)
      this._deliver()
    }
    this._onError = (error) => this._fail(toSmtpError(error, this.stage))
    this._onClose = () => {
      // 有些服务器最后一行不带换行就断开，把残留的字节补成一行再判连接结束。
      if (this.buffer) {
        this.buffer += '\n'
        this._deliver()
      }
      this._fail(new SmtpError('连接已被服务器关闭', { stage: this.stage, code: 'ECONNRESET', hint: hintForCode('ECONNRESET') }))
    }
    this._onTimeout = () => {
      const seconds = Math.round(this.idleTimeoutMs / 1000)
      this.socket.destroy(new SmtpError(`服务器 ${seconds} 秒无响应`, {
        stage: this.stage,
        code: 'ESOCKETTIMEDOUT',
        hint: hintForCode('ESOCKETTIMEDOUT'),
      }))
    }

    socket.on('data', this._onData)
    socket.on('error', this._onError)
    socket.on('close', this._onClose)
    socket.on('timeout', this._onTimeout)
    socket.setTimeout(idleTimeoutMs)
  }

  _fail(error) {
    this.closed = true
    if (!this.failure) this.failure = error
    this._deliver()
  }

  /** 把已缓冲的完整行交给等待者；没有可交付内容时，若已失败则立刻报错。 */
  _deliver() {
    while (this.waiter) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) break
      let line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      const waiter = this.waiter
      this.waiter = null
      waiter.resolve(line)
    }
    if (this.waiter && this.failure) {
      const waiter = this.waiter
      this.waiter = null
      waiter.reject(this.failure)
    }
  }

  readLine() {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
      this._deliver()
    })
  }

  write(data) {
    return new Promise((resolve, reject) => {
      if (this.closed || this.socket.destroyed) {
        reject(this.failure ?? new SmtpError('连接已关闭', { stage: this.stage, code: 'EPIPE' }))
        return
      }
      // 用 flush 回调而不是忽略返回值：大正文要等真正写完再发下一条指令，
      // 否则 250 和正文可能交错，服务器看到的就是一堆乱码。
      this.socket.write(data, (error) => (error ? reject(toSmtpError(error, this.stage)) : resolve()))
    })
  }

  /** 读一条完整响应（含多行续行）。 */
  async readReply(stage) {
    this.stage = stage ?? this.stage
    const lines = []
    let code = 0
    let terminated = false

    for (let index = 0; index < MAX_REPLY_LINES; index += 1) {
      const line = await this.readLine()
      const match = /^(\d{3})([ -])([\s\S]*)$/.exec(line)
      if (!match) {
        // 少数服务器会在响应之间插空行，容忍它。
        if (line.trim() === '') continue
        throw new SmtpError(`服务器响应无法解析：${truncate(line)}`, { stage: this.stage, code: 'EPROTO' })
      }
      code = Number(match[1])
      lines.push(match[3])
      // 分隔符是 `-` 表示还有续行，是空格表示这条响应到此为止。
      if (match[2] === ' ') {
        terminated = true
        break
      }
    }

    if (!terminated) {
      throw new SmtpError('服务器响应行数异常（没有正常结束）', { stage: this.stage, code: 'EPROTO' })
    }
    return { code, message: lines.join(' '), lines }
  }

  async command(line, stage) {
    this.stage = stage ?? this.stage
    await this.write(`${line}\r\n`)
    return this.readReply(stage)
  }

  /** INDEX 阶段前的摘监听：把 socket 让给 tls.connect，但不留下无人处理的 error 事件。 */
  detach() {
    if (this.detached) return
    this.detached = true
    this.socket.setTimeout(0)
    this.socket.removeListener('data', this._onData)
    this.socket.removeListener('error', this._onError)
    this.socket.removeListener('close', this._onClose)
    this.socket.removeListener('timeout', this._onTimeout)
    // TLS 升级期间底层 socket 的 error 会由 TLSSocket 转发，这里挂个空处理器
    // 只是为了让它在交接的空档里不至于"无人监听"导致进程直接崩掉。
    this.socket.on('error', () => {})
  }

  destroy(error) {
    if (!this.socket.destroyed) this.socket.destroy(error)
  }
}

// ---------------------------------------------------------------- 能力解析

/**
 * 把 EHLO 的多行响应解析成能力表。
 * 形如：
 *   250-smtp.qq.com at your service
 *   250-SIZE 73400320
 *   250-AUTH LOGIN PLAIN
 *   250 STARTTLS
 * 注意 `AUTH=LOGIN PLAIN` 也是一种合法写法，两种都要认。
 */
export function parseCapabilities(lines) {
  const capabilities = new Map()
  for (const raw of lines ?? []) {
    const text = String(raw ?? '').trim()
    if (!text || / at your service$/i.test(text)) continue
    const match = /^([A-Za-z0-9][A-Za-z0-9-]*)(?:[= ]([\s\S]*))?$/.exec(text)
    if (!match) continue
    const keyword = match[1].toUpperCase()
    const value = (match[2] ?? '').trim()
    if (!capabilities.has(keyword)) capabilities.set(keyword, value)
    else if (value) capabilities.set(keyword, `${capabilities.get(keyword)} ${value}`)
  }
  return capabilities
}

export function parseAuthMechanisms(capabilities) {
  const raw = capabilities?.get?.('AUTH') ?? ''
  return raw
    .split(/[\s,]+/)
    .map((item) => item.toUpperCase())
    .filter(Boolean)
}

// ---------------------------------------------------------------- 配置清洗

/**
 * 洗一遍入参。
 * 端口与加密方式互相推断：只给 465 就按 SSL 理解，只给 SSL 就按 465 理解，
 * 两者都缺时退回业界默认的 587 + STARTTLS。
 */
export function normalizeSmtpOptions(input) {
  const raw = isRecord(input) ? input : {}

  const host = String(raw.host ?? '').trim()
  if (!host) throw new SmtpError('未配置 SMTP 服务器地址', { stage: 'connect', code: 'EINVAL' })

  let port = normalizeInt(raw.port, 0, 0, 65535)

  const encryptionInput = String(raw.encryption ?? '').trim().toLowerCase()
  let encryption = SMTP_ENCRYPTIONS.has(encryptionInput) ? encryptionInput : ''
  if (!encryption) {
    if (port === 465) encryption = 'ssl'
    else if (port === 25 || port === 2525) encryption = 'none'
    else encryption = 'starttls'
  }
  if (!port) port = encryption === 'ssl' ? 465 : encryption === 'none' ? 25 : 587

  const user = String(raw.user ?? '').trim()
  const password = String(raw.password ?? '')
  const from = parseAddressInput(raw.from || user, String(raw.fromName ?? '').trim())
  if (!from.address) throw new SmtpError('未配置发件人地址', { stage: 'connect', code: 'EINVAL' })

  const recipients = toRecipientList(raw.to)
  if (!recipients.length) throw new SmtpError('缺少收件人地址', { stage: 'rcpt', code: 'EINVAL' })

  return {
    host,
    port,
    encryption,
    user,
    password,
    from,
    recipients,
    allowUnauthorized: raw.allowUnauthorized === true,
    heloHostname: String(raw.heloHostname ?? '').trim() || domainOf(from.address) || 'localhost',
    idleTimeoutMs: normalizeInt(raw.timeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 1000, 120_000),
    totalTimeoutMs: normalizeInt(raw.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS, 0, 600_000),
    date: raw.date,
    messageId: raw.messageId,
  }
}

// ---------------------------------------------------------------- 连接

function connectSocket(options) {
  return new Promise((resolve, reject) => {
    const useTls = options.encryption === 'ssl'
    const socket = useTls
      ? tlsConnect({
          host: options.host,
          port: options.port,
          servername: options.host,
          rejectUnauthorized: !options.allowUnauthorized,
        })
      : netConnect({ host: options.host, port: options.port })

    let settled = false
    const label = `${options.host}:${options.port}`

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new SmtpError(`连接 ${label} 超时`, {
        stage: 'connect',
        code: 'ETIMEDOUT',
        hint: hintForCode('ETIMEDOUT'),
      }))
    }, options.idleTimeoutMs)

    // error 监听保留到会话接手，交接空档里出错也不会变成未捕获异常。
    socket.on('error', (error) => {
      if (settled) {
        socket.destroy()
        return
      }
      settled = true
      clearTimeout(timer)
      reject(toSmtpError(error, 'connect'))
    })

    socket.once(useTls ? 'secureConnect' : 'connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(socket)
    })
  })
}

/** 发 EHLO；极老的服务器不认 EHLO，退回 HELO（HELO 没有任何扩展能力）。 */
async function greet(session, heloHostname) {
  let reply = await session.command(`EHLO ${heloHostname}`, 'ehlo')
  if (reply.code >= 500) {
    reply = await session.command(`HELO ${heloHostname}`, 'ehlo')
    assertReply(reply, [250], 'ehlo', 'HELO')
    return new Map()
  }
  assertReply(reply, [250], 'ehlo', 'EHLO')
  return parseCapabilities(reply.lines)
}

/** STARTTLS 升级。只有在拿到 220 之后才动手，且旧缓冲区必须是空的。 */
function upgradeToTls(session, options) {
  const plain = session.socket
  session.detach()

  if (session.buffer.trim()) {
    // 220 之后不该再有任何明文——有的话说明对面不是正常的邮局，直接放弃。
    throw new SmtpError('STARTTLS 升级前收到了多余的明文数据', { stage: 'starttls', code: 'EPROTO' })
  }

  return new Promise((resolve, reject) => {
    const secured = tlsConnect({
      socket: plain,
      servername: options.host,
      rejectUnauthorized: !options.allowUnauthorized,
    })

    let settled = false
    secured.once('error', (error) => {
      if (settled) return
      settled = true
      secured.destroy()
      reject(toSmtpError(error, 'starttls'))
    })
    secured.once('secureConnect', () => {
      if (settled) return
      settled = true
      secured.removeListener('error', () => {})
      resolve(new SmtpSession(secured, options.idleTimeoutMs))
    })
  })
}

async function openSession(options, state) {
  const socket = await connectSocket(options)
  let session = new SmtpSession(socket, options.idleTimeoutMs)
  state.session = session

  const greeting = await session.readReply('greeting')
  assertReply(greeting, [220], 'greeting', '服务器欢迎语')

  let capabilities = await greet(session, options.heloHostname)

  if (options.encryption === 'starttls') {
    if (!capabilities.has('STARTTLS')) {
      throw new SmtpError('服务器没有声明支持 STARTTLS', {
        stage: 'starttls',
        code: 'EPROTO',
        hint: '换成 SSL（465 端口）再试，或确认服务器地址与端口是否正确。绝不能在明文连接上继续发送授权码。',
      })
    }
    const starttls = await session.command('STARTTLS', 'starttls')
    assertReply(starttls, [220], 'starttls', 'STARTTLS')
    session = await upgradeToTls(session, options)
    state.session = session
    // RFC 3207：升级后必须丢掉旧能力表重新 EHLO，否则会误以为服务器还是明文的那些能力。
    capabilities = await greet(session, options.heloHostname)
  }

  return { session, capabilities }
}

// ---------------------------------------------------------------- 认证

function assertReply(reply, expected, stage, label) {
  if (expected.includes(reply.code)) return reply
  throw new SmtpError(`${label}被服务器拒绝（${reply.code}）`, {
    stage,
    code: reply.code,
    reply: reply.message,
    hint: hintForCode(reply.code),
  })
}

async function authLogin(session, options) {
  const start = await session.command('AUTH LOGIN', 'auth')
  assertReply(start, [334], 'auth', 'AUTH LOGIN')

  const userReply = await session.command(Buffer.from(options.user, 'utf-8').toString('base64'), 'auth')
  assertReply(userReply, [334], 'auth', '用户名')

  const passReply = await session.command(Buffer.from(options.password, 'utf-8').toString('base64'), 'auth')
  assertReply(passReply, [235], 'auth', '密码')
}

async function authPlain(session, options) {
  const payload = Buffer.from(`\u0000${options.user}\u0000${options.password}`, 'utf-8').toString('base64')
  let reply = await session.command(`AUTH PLAIN ${payload}`, 'auth')
  // 有的服务器要求先发空的 AUTH PLAIN，拿到 334 再送载荷。
  if (reply.code === 334) reply = await session.command(payload, 'auth')
  assertReply(reply, [235], 'auth', 'AUTH PLAIN')
}

async function authenticate(session, options) {
  const mechanisms = parseAuthMechanisms(options.capabilities)

  // 优先 LOGIN：QQ / 163 / 企业邮都支持它，而且不像 PLAIN 那样把
  // 「用户名 + 密码」拼在一个字段里，日志里更不容易被误读。
  const order = []
  if (mechanisms.includes('LOGIN') || mechanisms.length === 0) order.push('LOGIN')
  if (mechanisms.includes('PLAIN')) order.push('PLAIN')
  if (!order.length) order.push('LOGIN')

  let lastError
  for (let index = 0; index < order.length; index += 1) {
    const mechanism = order[index]
    try {
      if (mechanism === 'LOGIN') await authLogin(session, options)
      else await authPlain(session, options)
      return mechanism
    } catch (error) {
      const smtpError = toSmtpError(error, 'auth')
      lastError = smtpError
      // 504 表示"服务器不认这种认证方式"，值得换一种再试；
      // 其它错误（尤其 535 认证失败）重试没有意义，而且有些服务器失败后
      // 会直接断开连接，重试只会把真正的错误盖成"连接已关闭"。
      if (smtpError.code !== '504' || index === order.length - 1) throw smtpError
    }
  }
  throw lastError
}

// ---------------------------------------------------------------- 对外接口

/**
 * 发一封邮件。成功返回投递凭据，失败抛 SmtpError（用 describeSmtpError 拿人话文案）。
 *
 * options:
 *   host / port / encryption('ssl'|'starttls'|'none') / user / password
 *   from / fromName / to（字符串或数组）
 *   subject / text / html
 *   allowUnauthorized  自签证书的自建邮局用，默认 false
 *   timeoutMs          单次读写的空闲超时，默认 15s
 *   totalTimeoutMs     整封信的总预算，默认 30s
 *   heloHostname       默认取发件人域名
 */
export async function sendMail(input) {
  const options = normalizeSmtpOptions(input)
  const messageId = options.messageId ?? generateMessageId(options.from.address)

  const message = buildMimeMessage({
    from: options.from,
    recipients: options.recipients,
    subject: input.subject,
    text: input.text,
    html: input.html,
    date: options.date,
    messageId,
  })
  const payload = encodeDataPayload(message)

  const state = { session: null }
  let timer = null

  try {
    if (options.totalTimeoutMs > 0) {
      timer = setTimeout(() => {
        const seconds = Math.round(options.totalTimeoutMs / 1000)
        const error = new SmtpError(`发送邮件整体超时（${seconds} 秒）`, {
          stage: state.session?.stage ?? 'connect',
          code: 'ETIMEDOUT',
          hint: hintForCode('ETIMEDOUT'),
        })
        state.session?.destroy(error)
      }, options.totalTimeoutMs)
    }

    const { session, capabilities } = await openSession(options, state)

    if (options.user) {
      await authenticate(session, { ...options, capabilities })
    }

    assertReply(
      await session.command(`MAIL FROM:<${options.from.address}>`, 'from'),
      [250],
      'from',
      '发件人地址',
    )

    for (const recipient of options.recipients) {
      // 251 表示"用户不在本地，会转发"，252 表示"无法验证但会尝试投递"，都算成功。
      assertReply(
        await session.command(`RCPT TO:<${recipient.address}>`, 'rcpt'),
        [250, 251, 252],
        'rcpt',
        '收件人地址',
      )
    }

    assertReply(await session.command('DATA', 'data'), [354], 'data', 'DATA 指令')

    await session.write(payload)

    const delivered = await session.readReply('data')
    assertReply(delivered, [250], 'data', '邮件投递')

    try {
      const quit = await session.command('QUIT', 'quit')
      if (quit.code !== 221) {
        // 有些服务器回 250 或者直接断开。信已经收了，这不影响结果。
      }
    } catch {
      // 服务器收完信就关连接是很常见的，QUIT 失败不该让整次发送算失败。
    }

    return {
      messageId,
      accepted: options.recipients.map((item) => item.address),
      response: delivered.message,
      encryption: options.encryption,
      authenticated: Boolean(options.user),
    }
  } finally {
    if (timer) clearTimeout(timer)
    state.session?.destroy()
  }
}

/**
 * 探活：连上去、EHLO、认证，然后 QUIT，不投递任何邮件。
 * 管理后台的「测试连接」按钮用它，比真发一封信更轻，也不会消耗发信额度。
 */
export async function verifyConnection(input) {
  const options = normalizeSmtpOptions({ ...input, to: input.to || input.from || input.user || 'probe@localhost' })
  const state = { session: null }
  let timer = null

  try {
    if (options.totalTimeoutMs > 0) {
      timer = setTimeout(() => {
        const error = new SmtpError(`连接探测超时（${Math.round(options.totalTimeoutMs / 1000)} 秒）`, {
          stage: state.session?.stage ?? 'connect',
          code: 'ETIMEDOUT',
          hint: hintForCode('ETIMEDOUT'),
        })
        state.session?.destroy(error)
      }, options.totalTimeoutMs)
    }

    const { session, capabilities } = await openSession(options, state)
    const mechanism = options.user ? await authenticate(session, { ...options, capabilities }) : ''
    try {
      await session.command('QUIT', 'quit')
    } catch {
      // 同上，QUIT 失败不影响结论。
    }

    return {
      host: options.host,
      port: options.port,
      encryption: options.encryption,
      authenticated: Boolean(options.user),
      mechanism,
      capabilities: [...capabilities.keys()],
    }
  } finally {
    if (timer) clearTimeout(timer)
    state.session?.destroy()
  }
}
