// 零依赖 SMTP 客户端回归测试。
//
// 这个模块是手写的协议实现，光靠读代码看不出对不对，所以测试分两层：
// 1. 纯函数层——MIME 拼装、头部编码、配置清洗。这些错了会导致邮件显示乱码或结构损坏，
//    但本机就能验证，不需要网络。
// 2. 协议层——起一个真的 socket 服务器当对端，用的是仓库里那份自签证书，
//    把 465（隐式 TLS）和 587（STARTTLS）两条路都真跑一遍。
//
// 协议层里最要紧的两条断言是「明文阶段绝不允许出现密码」和「点号转义」：
// 前者关系到授权码会不会裸奔，后者错了会静默截断邮件正文。这两条不跑通不能上线。

import { describe, expect, it } from 'vitest'

import { decodeHeaderWord, extractMessageText, headerValue, startFakeSmtpServer } from './__fixtures__/fakeSmtp.mjs'
import {
  buildMimeMessage,
  describeSmtpError,
  encodeDataPayload,
  encodeHeaderValue,
  formatAddress,
  formatMailDate,
  generateMessageId,
  hintForCode,
  normalizeAddress,
  normalizeSmtpOptions,
  parseAddressInput,
  parseAuthMechanisms,
  parseCapabilities,
  sanitizeHeaderText,
  sendMail,
  SmtpError,
  verifyConnection,
  wrapBase64,
} from './smtp.mjs'
const HOST = '127.0.0.1'

// 假服务器实现在 __fixtures__ 里，注册流程的端到端测试也用同一份。
const startFakeServer = startFakeSmtpServer
const CREDENTIALS = { user: 'ops@example.com', password: 'sekret-authorization-code' }

function baseOptions(server, extra = {}) {
  return {
    host: HOST,
    port: server.port,
    ...CREDENTIALS,
    from: 'ops@example.com',
    to: 'user@example.net',
    subject: '验证码',
    text: '你的验证码是 123456',
    timeoutMs: 4000,
    totalTimeoutMs: 8000,
    ...extra,
  }
}

// ---------------------------------------------------------------- 纯函数

describe('parseCapabilities', () => {
  it('解析多行 EHLO 响应，跳过欢迎语，认 AUTH= 写法', () => {
    const capabilities = parseCapabilities([
      'fake.local at your service',
      'PIPELINING',
      'SIZE 35882577',
      'AUTH=LOGIN PLAIN',
      '8BITMIME',
      'STARTTLS',
    ])

    expect(capabilities.get('PIPELINING')).toBe('')
    expect(capabilities.get('SIZE')).toBe('35882577')
    expect(capabilities.get('AUTH')).toBe('LOGIN PLAIN')
    expect(capabilities.get('8BITMIME')).toBe('')
    expect(capabilities.has('STARTTLS')).toBe(true)
    // 欢迎语是主机名加一句客套话，不该被当成能力。
    expect(capabilities.has('FAKE')).toBe(false)
  })

  it('同名能力出现多次时把值合并，而不是互相覆盖', () => {
    const capabilities = parseCapabilities(['AUTH LOGIN', 'AUTH PLAIN'])
    expect(capabilities.get('AUTH')).toBe('LOGIN PLAIN')
  })

  it('parseAuthMechanisms 拆出全部机制名并大写', () => {
    const capabilities = parseCapabilities(['AUTH login plain xoauth2'])
    expect(parseAuthMechanisms(capabilities)).toEqual(['LOGIN', 'PLAIN', 'XOAUTH2'])
    expect(parseAuthMechanisms(new Map())).toEqual([])
  })
})

describe('encodeHeaderValue', () => {
  it('纯 ASCII 原样返回，不做无意义的编码', () => {
    expect(encodeHeaderValue('Your code is 123456')).toBe('Your code is 123456')
  })

  it('长 ASCII 按空格折行，行首用空格续行', () => {
    const value = 'Your verification code is 123456 and it will expire in ten minutes please do not share it with anyone'
    const encoded = encodeHeaderValue(value)
    expect(encoded).toContain('\r\n ')
    for (const line of encoded.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(80)
    }
    // 折行处的空白在解码时会被还原成一个空格，语义不变。
    expect(encoded.replace(/\r\n /g, ' ')).toBe(value)
  })

  it('中文走 RFC2047，每个 encoded-word 不超过 75 字符', () => {
    const subject = '【绘想】您的邮箱验证码是 123456，10 分钟内有效，请勿转发给他人。'
    const encoded = encodeHeaderValue(subject)
    const words = encoded.split('\r\n ')
    expect(words.length).toBeGreaterThan(1)
    for (const word of words) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
      expect(word.length).toBeLessThanOrEqual(75)
    }
  })

  it('按字符而不是字节切分，不会把一个汉字劈成乱码', () => {
    const subject = '验证码验证码验证码验证码验证码验证码验证码验证码验证码验证码'
    const encoded = encodeHeaderValue(subject)
    for (const word of encoded.split('\r\n ')) {
      const payload = word.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '')
      const decoded = Buffer.from(payload, 'base64').toString('utf-8')
      // 出现替换字符就说明 UTF-8 序列被切断了。
      expect(decoded).not.toContain('\uFFFD')
      expect(decoded).toBe(decoded.normalize('NFC'))
    }
  })

  it('编码后解码能一字不差地还原原文，空格也不丢', () => {
    const subject = '您好 您的验证码是 987654 请在 10 分钟内使用'
    const encoded = encodeHeaderValue(subject)
    const restored = encoded
      .split('\r\n ')
      .map((word) => {
        const match = /^=\?UTF-8\?B\?(.+)\?=$/.exec(word)
        return match ? Buffer.from(match[1], 'base64').toString('utf-8') : word
      })
      .join('')
    expect(restored).toBe(subject)
  })

  it('带换行的输入会被压成单行，挡住头部注入', () => {
    expect(encodeHeaderValue('hi\r\nBcc: attacker@evil.com')).not.toContain('\r\nBcc')
    expect(sanitizeHeaderText('hi\r\nBcc: a@b.com')).toBe('hi Bcc: a@b.com')
  })
})

describe('formatAddress', () => {
  it('没有昵称时只发尖括号地址', () => {
    expect(formatAddress({ address: 'a@b.com' })).toBe('<a@b.com>')
  })

  it('纯 ASCII 昵称直接写，含特殊字符的加引号', () => {
    expect(formatAddress({ address: 'a@b.com', name: 'GPT Image' })).toBe('GPT Image <a@b.com>')
    expect(formatAddress({ address: 'a@b.com', name: 'Image, Bot' })).toBe('"Image, Bot" <a@b.com>')
    expect(formatAddress({ address: 'a@b.com', name: 'Say "hi"' })).toBe('"Say \\"hi\\"" <a@b.com>')
  })

  it('中文昵称走编码', () => {
    const rendered = formatAddress({ address: 'a@b.com', name: '绘想' })
    expect(rendered).toMatch(/^=\?UTF-8\?B\?.+\?= <a@b\.com>$/)
  })
})

describe('地址与配置清洗', () => {
  it('normalizeAddress 剥掉尖括号，拒绝带注入和空白的输入', () => {
    expect(normalizeAddress('<a@b.com>')).toBe('a@b.com')
    expect(() => normalizeAddress('a@b.com\r\nBcc: x@y.com')).toThrow(/不合法/)
    expect(() => normalizeAddress('not-an-address')).toThrow(/不合法/)
    expect(normalizeAddress('  ')).toBe('')
  })

  it('parseAddressInput 认得「昵称 <地址>」这种粘贴格式', () => {
    expect(parseAddressInput('绘想 <noreply@example.com>')).toEqual({
      address: 'noreply@example.com',
      name: '绘想',
    })
    expect(parseAddressInput('"Bot" <a@b.com>')).toEqual({ address: 'a@b.com', name: 'Bot' })
    expect(parseAddressInput('a@b.com', '兜底')).toEqual({ address: 'a@b.com', name: '兜底' })
  })

  it('端口与加密方式互相推断，缺省落到 587 + STARTTLS', () => {
    expect(normalizeSmtpOptions({ host: 'h', user: 'a@b.com', to: 'c@d.com' })).toMatchObject({
      port: 587,
      encryption: 'starttls',
    })
    expect(normalizeSmtpOptions({ host: 'h', port: 465, user: 'a@b.com', to: 'c@d.com' })).toMatchObject({
      port: 465,
      encryption: 'ssl',
    })
    expect(normalizeSmtpOptions({ host: 'h', encryption: 'ssl', user: 'a@b.com', to: 'c@d.com' })).toMatchObject({
      port: 465,
      encryption: 'ssl',
    })
    expect(normalizeSmtpOptions({ host: 'h', port: 25, user: 'a@b.com', to: 'c@d.com' })).toMatchObject({
      encryption: 'none',
    })
  })

  it('缺服务器地址、发件人、收件人时直接报错，不做半吊子连接', () => {
    expect(() => normalizeSmtpOptions({ to: 'a@b.com' })).toThrow(/服务器地址/)
    expect(() => normalizeSmtpOptions({ host: 'h', to: 'a@b.com' })).toThrow(/发件人地址/)
    expect(() => normalizeSmtpOptions({ host: 'h', from: 'a@b.com' })).toThrow(/收件人地址/)
  })

  it('发件人缺省取登录账号，EHLO 主机名缺省取发件人域名', () => {
    const options = normalizeSmtpOptions({ host: 'h', user: 'ops@example.com', to: 'u@example.net' })
    expect(options.from.address).toBe('ops@example.com')
    expect(options.heloHostname).toBe('example.com')
  })

  it('多个收件人支持逗号、分号分隔', () => {
    const options = normalizeSmtpOptions({ host: 'h', from: 'a@b.com', to: 'x@y.com; z@y.com, w@y.com' })
    expect(options.recipients.map((item) => item.address)).toEqual(['x@y.com', 'z@y.com', 'w@y.com'])
  })
})

describe('buildMimeMessage', () => {
  const base = {
    from: { address: 'ops@example.com', name: '绘想' },
    recipients: [{ address: 'user@example.net' }],
    subject: '您的验证码',
    messageId: '<fixed@example.com>',
    date: new Date('2026-09-22T10:00:00Z'),
  }

  it('必填头部齐全，日期是 RFC 5322 格式', () => {
    const raw = buildMimeMessage({ ...base, text: 'code 123456' })
    expect(raw).toContain('From: =?UTF-8?B?')
    expect(raw).toContain('<ops@example.com>')
    expect(raw).toContain('To: <user@example.net>')
    expect(raw).toContain('Message-ID: <fixed@example.com>')
    expect(raw).toContain('MIME-Version: 1.0')
    expect(raw).toContain('Date: Tue, 22 Sep 2026 10:00:00 +0000')
    expect(raw).not.toContain('\n\n\n')
  })

  it('只有纯文本时是单段 text/plain + base64', () => {
    const raw = buildMimeMessage({ ...base, text: '你的验证码是 123456' })
    expect(raw).toContain('Content-Type: text/plain; charset="utf-8"')
    expect(raw).toContain('Content-Transfer-Encoding: base64')

    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4)
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf-8')).toBe('你的验证码是 123456')
  })

  it('同时给纯文本和 HTML 时是 multipart/alternative，纯文本在前', () => {
    const raw = buildMimeMessage({ ...base, text: '验证码 123456', html: '<p>验证码 <b>123456</b></p>' })
    const boundary = /boundary="([^"]+)"/.exec(raw)?.[1]
    expect(boundary).toBeTruthy()
    expect(raw).toContain('Content-Type: multipart/alternative;')

    const parts = raw.split(`--${boundary}`)
    expect(parts).toHaveLength(4) // 前导头、plain、html、结尾
    expect(parts[1]).toContain('text/plain')
    expect(parts[2]).toContain('text/html')
    expect(parts[3].trim()).toBe('--')

    const plain = Buffer.from(parts[1].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf-8')
    const html = Buffer.from(parts[2].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf-8')
    expect(plain).toBe('验证码 123456')
    expect(html).toBe('<p>验证码 <b>123456</b></p>')
  })

  it('正文为空时拒绝构建，而不是发一封没有内容的空信', () => {
    expect(() => buildMimeMessage({ ...base, text: '' })).toThrow(/正文/)
  })

  it('wrapBase64 按 76 字符折行', () => {
    const wrapped = wrapBase64(Buffer.alloc(500, 7))
    for (const line of wrapped.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76)
  })

  it('formatMailDate 兜住非法日期，不抛异常', () => {
    expect(formatMailDate(new Date('2026-09-22T10:00:00Z'))).toBe('Tue, 22 Sep 2026 10:00:00 +0000')
    expect(formatMailDate('完全不是日期')).toMatch(/^[A-Z][a-z]{2}, \d{2} /)
  })

  it('generateMessageId 用发件人域名，且每次都不一样', () => {
    const first = generateMessageId('ops@example.com')
    const second = generateMessageId('ops@example.com')
    expect(first).toMatch(/^<[0-9a-z]+\.[0-9a-f]+@example\.com>$/)
    expect(first).not.toBe(second)
    expect(generateMessageId('')).toMatch(/@localhost>$/)
  })
})

describe('encodeDataPayload', () => {
  it('裸 LF 统一成 CRLF，并补上结束行', () => {
    expect(encodeDataPayload('a\nb')).toBe('a\r\nb\r\n.\r\n')
    expect(encodeDataPayload('a\r\nb\r\n')).toBe('a\r\nb\r\n.\r\n')
  })

  it('行首的点号被转义成两个，否则会被当成结束标记截断正文', () => {
    const payload = encodeDataPayload('正常一行\r\n.隐藏的一行\r\n结束')
    expect(payload).toContain('\r\n..隐藏的一行\r\n')
    expect(payload.endsWith('\r\n.\r\n')).toBe(true)
  })

  it('只有点号的行会被转义，不会提前终结传输', () => {
    const payload = encodeDataPayload('开头\r\n.\r\n结尾')
    expect(payload).toBe('开头\r\n..\r\n结尾\r\n.\r\n')
  })
})

// ---------------------------------------------------------------- 协议层

describe('sendMail 明文投递', () => {
  it('走完 EHLO / AUTH / MAIL / RCPT / DATA / QUIT，正文完整到达', async () => {
    const server = await startFakeServer({ mode: 'net', ...CREDENTIALS })
    try {
      const result = await sendMail(baseOptions(server, {
        encryption: 'none',
        subject: '您的验证码',
        text: '验证码：123456',
      }))

      expect(result.accepted).toEqual(['user@example.net'])
      expect(result.authenticated).toBe(true)
      expect(result.response).toContain('queued')

      const session = server.session()
      expect(session.commands[0]).toContain('EHLO example.com')
      expect(session.commands[1]).toBe('AUTH LOGIN')
      expect(session.commands).toContain('MAIL FROM:<ops@example.com>')
      expect(session.commands).toContain('RCPT TO:<user@example.net>')
      expect(session.commands).toContain('DATA')
      expect(session.commands.at(-1)).toBe('QUIT')
      expect(session.authUser).toBe(CREDENTIALS.user)
      expect(session.authPassword).toBe(CREDENTIALS.password)

      // 服务器收到的是 dot-stuffed 后的字节，解码回来应当和原文一致。
      expect(session.data).toContain('Message-ID: ')
      const bodyBase64 = session.data.slice(session.data.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, '')
      expect(Buffer.from(bodyBase64, 'base64').toString('utf-8')).toBe('验证码：123456')
    } finally {
      await server.close()
    }
  })

  it('对端收到的字节与本地拼出来的信完全一致，中间没有多一个少一个换行', async () => {
    const server = await startFakeServer({ mode: 'net', ...CREDENTIALS })
    try {
      // 固定 date 与 messageId，这样本地能重建出一模一样的信来比对。
      const date = new Date('2026-09-22T10:00:00Z')
      const messageId = '<compare@example.com>'
      const options = {
        from: { address: 'ops@example.com', name: '绘想' },
        recipients: [{ address: 'user@example.net' }],
        subject: '您的验证码',
        text: '验证码：123456',
        date,
        messageId,
      }

      await sendMail(baseOptions(server, { encryption: 'none', ...options }))

      const expected = buildMimeMessage(options)
      const received = server.session().data

      // 反解 dot-stuffing。注意结尾要多补一个 CRLF：DATA 的结束行 `.\r\n` 会顶掉
      // 正文最后一行的换行符，所以对端按行重组出来天然比原文少一个尾部 CRLF，
      // 这是 SMTP 的正常现象，不是丢字节。
      const unstuffed = received.replace(/^\.\./gm, '.')
      expect(`${unstuffed}\r\n`).toBe(expected)

      // 没有任何一行以单个点号开头（那会被对端当成结束标记截断邮件）。
      for (const line of received.split('\r\n')) {
        expect(line.startsWith('.')).toBe(false)
      }
    } finally {
      await server.close()
    }
  })

  it('EHLO 被拒时退回 HELO，老服务器也能投递', async () => {
    const server = await startFakeServer({
      mode: 'net',
      ...CREDENTIALS,
      failVerbs: { EHLO: '500 Command not recognized' },
    })
    try {
      await sendMail(baseOptions(server, { encryption: 'none', user: '' }))
      const commands = server.session().commands
      expect(commands[0]).toContain('EHLO example.com')
      expect(commands[1]).toContain('HELO example.com')
      expect(commands).toContain('MAIL FROM:<ops@example.com>')
    } finally {
      await server.close()
    }
  })

  it('中文主题编码后能被标准解码器还原，用户看到的是正常中文而不是乱码', async () => {
    const server = await startFakeServer({ mode: 'net', ...CREDENTIALS })
    try {
      const subject = '【绘想】您的注册验证码是 884213'
      await sendMail(baseOptions(server, { encryption: 'none', subject }))
      const raw = server.session().data
      // 折行展开 + RFC2047 解码之后，必须与原文一字不差。
      expect(decodeHeaderWord(headerValue(raw, 'Subject'))).toBe(subject)
    } finally {
      await server.close()
    }
  })

  it('中文发件人昵称同样能还原，收件人看到的是「绘想」而不是一串 base64', async () => {
    const server = await startFakeServer({ mode: 'net', ...CREDENTIALS })
    try {
      await sendMail(baseOptions(server, { encryption: 'none', fromName: '绘想' }))
      const raw = server.session().data
      const from = decodeHeaderWord(headerValue(raw, 'From'))
      expect(from).toContain('绘想')
      expect(from).toContain('<ops@example.com>')
    } finally {
      await server.close()
    }
  })

  it('同时给纯文本和 HTML 时，对端拿到的纯文本段落里也有验证码', async () => {
    const server = await startFakeServer({ mode: 'net', ...CREDENTIALS })
    try {
      await sendMail(baseOptions(server, {
        encryption: 'none',
        text: '验证码 445566',
        html: '<p>验证码 <b>445566</b></p>',
      }))
      const text = extractMessageText(server.session())
      expect(text).toContain('445566')
    } finally {
      await server.close()
    }
  })
})

describe('认证失败与错误翻译', () => {
  it('535 报认证失败，提示里点名「授权码」而不是登录密码', async () => {
    const server = await startFakeServer({ mode: 'net', user: 'ops@example.com', password: '正确的授权码' })
    try {
      await expect(
        sendMail(baseOptions(server, { encryption: 'none', password: '错误的密码' })),
      ).rejects.toMatchObject({ code: '535', stage: 'auth' })

      const error = await sendMail(baseOptions(server, { encryption: 'none', password: 'x' })).catch((e) => e)
      expect(error.hint).toMatch(/授权码|专用密码/)
      expect(describeSmtpError(error)).toContain('身份认证')
    } finally {
      await server.close()
    }
  })

  it('收件人被拒时把服务器的原话带进错误里', async () => {
    const server = await startFakeServer({
      mode: 'net',
      ...CREDENTIALS,
      failVerbs: { RCPT: '550 No such user here' },
    })
    try {
      const error = await sendMail(baseOptions(server, { encryption: 'none' })).catch((e) => e)
      expect(error).toBeInstanceOf(SmtpError)
      expect(error.code).toBe('550')
      expect(error.stage).toBe('rcpt')
      expect(error.reply).toContain('No such user here')
      expect(describeSmtpError(error)).toContain('收件人')
    } finally {
      await server.close()
    }
  })

  it('连接被拒绝时错误可读，不是一句 ECONNREFUSED', async () => {
    const server = await startFakeServer({ mode: 'net', ...CREDENTIALS })
    const port = server.port
    await server.close()

    const error = await sendMail({ ...baseOptions({ port }), encryption: 'none' }).catch((e) => e)
    expect(error.stage).toBe('connect')
    expect(describeSmtpError(error)).toMatch(/连接被拒绝|超时/)
  })

  it('服务器中途不回话时按空闲超时中断，不会一直挂着', async () => {
    const server = await startFakeServer({ mode: 'net', ...CREDENTIALS, ignore: ['EHLO'] })
    try {
      const error = await sendMail(baseOptions(server, { encryption: 'none', timeoutMs: 1200 })).catch((e) => e)
      expect(error.code).toBe('ESOCKETTIMEDOUT')
      expect(error.stage).toBe('ehlo')
    } finally {
      await server.close()
    }
  })

  it('hintForCode 覆盖常见码，未知码返回空串', () => {
    expect(hintForCode('535')).toMatch(/授权码/)
    expect(hintForCode(421)).toMatch(/额度|频率/)
    expect(hintForCode('ECONNREFUSED')).toMatch(/防火墙|端口/)
    expect(hintForCode('999')).toBe('')
  })
})

describe('加密投递', () => {
  it('465 隐式 TLS：连上去就握手，认证与正文都在密文里走', async () => {
    const server = await startFakeServer({ mode: 'tls', ...CREDENTIALS })
    try {
      const result = await sendMail(baseOptions(server, {
        port: server.port,
        encryption: 'ssl',
        allowUnauthorized: true,
        text: '验证码 246810',
      }))

      expect(result.encryption).toBe('ssl')
      const session = server.session()
      expect(session.plainText).toBe('')
      expect(session.encryptedText).toContain('AUTH LOGIN')
      expect(session.authPassword).toBe(CREDENTIALS.password)
      const bodyBase64 = session.data.slice(session.data.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, '')
      expect(Buffer.from(bodyBase64, 'base64').toString('utf-8')).toBe('验证码 246810')
    } finally {
      await server.close()
    }
  })

  it('587 STARTTLS：先明文握手，再升级；授权码绝不在明文里出现', async () => {
    const server = await startFakeServer({ mode: 'starttls', ...CREDENTIALS })
    try {
      await sendMail(baseOptions(server, {
        port: server.port,
        encryption: 'starttls',
        allowUnauthorized: true,
      }))

      const session = server.session()
      expect(session.upgraded).toBe(true)

      // 明文阶段只允许出现 EHLO 和 STARTTLS，一个字节的凭据都不许有。
      expect(session.plainText).toContain('STARTTLS')
      expect(session.plainText).not.toContain('AUTH')
      expect(session.plainText).not.toContain(CREDENTIALS.password)
      expect(session.plainText).not.toContain(
        Buffer.from(CREDENTIALS.password, 'utf-8').toString('base64'),
      )
      expect(session.plainText).not.toContain(
        Buffer.from(CREDENTIALS.user, 'utf-8').toString('base64'),
      )

      // 升级之后必须重新 EHLO，能力表会变（多出 AUTH）。
      const verbs = session.commands
      expect(verbs.filter((line) => line.startsWith('EHLO'))).toHaveLength(2)
      expect(verbs.at(-1)).toBe('QUIT')
      expect(session.authPassword).toBe(CREDENTIALS.password)
    } finally {
      await server.close()
    }
  })

  it('服务器不支持 STARTTLS 时直接放弃，绝不降级成明文发凭据', async () => {
    const server = await startFakeServer({
      mode: 'net',
      ...CREDENTIALS,
      capabilities: ['fake.local', 'PIPELINING'], // 没有 STARTTLS
    })
    try {
      const error = await sendMail(baseOptions(server, {
        port: server.port,
        encryption: 'starttls',
        allowUnauthorized: true,
      })).catch((e) => e)

      expect(error).toBeInstanceOf(SmtpError)
      expect(error.stage).toBe('starttls')
      expect(describeSmtpError(error)).toMatch(/SSL|STARTTLS/)

      const session = server.session()
      expect(session.plainText).not.toContain('AUTH')
      expect(session.plainText).not.toContain(CREDENTIALS.password)
    } finally {
      await server.close()
    }
  })

  it('自签证书默认被拒，错误指向证书校验', async () => {
    const server = await startFakeServer({ mode: 'tls', ...CREDENTIALS })
    try {
      const error = await sendMail(baseOptions(server, {
        port: server.port,
        encryption: 'ssl',
        allowUnauthorized: false,
      })).catch((e) => e)

      expect(error.stage).toBe('connect')
      expect(describeSmtpError(error)).toMatch(/证书/)
    } finally {
      await server.close()
    }
  })
})

describe('verifyConnection', () => {
  it('探活只握手不投递，连 DATA 都不会发', async () => {
    const server = await startFakeServer({ mode: 'net', ...CREDENTIALS })
    try {
      const result = await verifyConnection({
        host: HOST,
        port: server.port,
        encryption: 'none',
        ...CREDENTIALS,
        to: 'probe@example.net',
        timeoutMs: 4000,
      })

      expect(result.authenticated).toBe(true)
      expect(result.mechanism).toBe('LOGIN')
      expect(result.capabilities).toContain('AUTH')
      expect(server.session().commands).not.toContain('DATA')
      expect(server.session().commands).not.toContain('MAIL FROM:<ops@example.com>')
    } finally {
      await server.close()
    }
  })

  it('不传 user 时就只握手不认证', async () => {
    const server = await startFakeServer({ mode: 'net' })
    try {
      const result = await verifyConnection({
        host: HOST,
        port: server.port,
        encryption: 'none',
        from: 'ops@example.com',
        to: 'probe@example.net',
        timeoutMs: 4000,
      })
      expect(result.authenticated).toBe(false)
      expect(server.session().commands.some((line) => line.startsWith('AUTH'))).toBe(false)
    } finally {
      await server.close()
    }
  })
})
