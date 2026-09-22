// 测试用的假 SMTP 服务器。
//
// 它不是通用实现，只负责按脚本回应，并把「客户端到底发了什么」原样记下来供断言。
// 之所以要真开一个 socket 而不是 mock 掉：手写的协议实现，只有真走一遍 TCP
// 才能发现"响应读串了""明文阶段泄漏了凭据"这类问题。
//
// 放在 __fixtures__ 下是为了标明它只在测试里用。

import { readFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { createSecureContext, createServer as createTlsServer, TLSSocket } from 'node:tls'

const CERT = readFileSync(new URL('./smtp-test-cert.pem', import.meta.url))
const KEY = readFileSync(new URL('./smtp-test-key.pem', import.meta.url))
const SECURE_CONTEXT = createSecureContext({ key: KEY, cert: CERT })

const HOST = '127.0.0.1'

/**
 * 起一个假 SMTP 服务器。
 *
 * config:
 *   mode          'net'（明文）| 'tls'（隐式 TLS）| 'starttls'（需升级）
 *   capabilities  EHLO 回的能力列表；starttls 模式会自动带上 STARTTLS
 *   user/password 期望的认证凭据；不设则接受任意
 *   ignore        这些动词收到了也不回应，用来测超时
 *   failVerbs     { EHLO: '500 ...' } 之类，用来注入错误
 *   silentGreeting 完全不出声，用来测"连上了但不回欢迎语"
 */
export async function startFakeSmtpServer(config = {}) {
  const state = { sessions: [], connections: 0 }

  const capabilities = config.capabilities ?? [
    'fake.local at your service',
    'PIPELINING',
    'SIZE 35882577',
    '8BITMIME',
    'AUTH LOGIN PLAIN',
    ...(config.mode === 'starttls' ? ['STARTTLS'] : []),
  ]

  const handleConnection = (socket, encryptedAlready) => {
    state.connections += 1
    const session = {
      plainText: '',
      encryptedText: '',
      commands: [],
      data: '',
      authUser: '',
      authPassword: '',
      upgraded: false,
    }
    state.sessions.push(session)

    const context = { state, session, encrypted: encryptedAlready, config, capabilities }
    attachSession(socket, context)

    if (!config.silentGreeting) socket.write('220 fake.local ESMTP ready\r\n')
  }

  function attachSession(socket, context) {
    const { session, config: cfg } = context
    const decoder = new StringDecoder('utf-8')
    let buffer = ''
    let inData = false
    let dataLines = []
    let authStep = ''

    const reply = (line) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`)
    }
    const replyMultiline = (code, lines) => {
      lines.forEach((line, index) => {
        reply(`${code}${index === lines.length - 1 ? ' ' : '-'}${line}`)
      })
    }

    const upgradeToTls = () => {
      socket.removeAllListeners('data')
      socket.removeAllListeners('error')
      socket.removeAllListeners('close')
      socket.on('error', () => {})
      const secured = new TLSSocket(socket, { isServer: true, secureContext: SECURE_CONTEXT })
      context.encrypted = true
      session.upgraded = true
      attachSession(secured, context)
    }

    function checkPassword(payload, plain) {
      const decoded = plain ? Buffer.from(payload, 'base64').toString('utf-8') : payload
      if (plain) {
        const parts = decoded.split('\u0000')
        session.authUser = parts[1] ?? ''
        session.authPassword = parts[2] ?? ''
      } else {
        session.authPassword = decoded
      }

      if (cfg.user && (session.authUser !== cfg.user || session.authPassword !== cfg.password)) {
        reply('535 Error: authentication failed')
        return
      }
      reply('235 Authentication successful')
    }

    const handleCommand = (line) => {
      const spaceIndex = line.indexOf(' ')
      const verb = (spaceIndex < 0 ? line : line.slice(0, spaceIndex)).toUpperCase()
      const argument = spaceIndex < 0 ? '' : line.slice(spaceIndex + 1)

      if (cfg.ignore?.includes(verb)) return
      if (cfg.failVerbs?.[verb]) {
        reply(cfg.failVerbs[verb])
        return
      }

      switch (verb) {
        case 'EHLO':
          replyMultiline(250, capabilities)
          return
        case 'HELO':
          reply('250 fake.local')
          return
        case 'STARTTLS':
          if (cfg.mode !== 'starttls') {
            reply('454 TLS not available')
            return
          }
          reply('220 Ready to start TLS')
          upgradeToTls()
          return
        case 'AUTH': {
          const mechanism = argument.split(' ')[0].toUpperCase()
          if (mechanism === 'LOGIN') {
            authStep = 'user'
            reply('334 VXNlcm5hbWU6')
            return
          }
          if (mechanism === 'PLAIN') {
            const payload = argument.split(' ').slice(1).join(' ')
            if (payload) {
              checkPassword(payload, true)
              return
            }
            authStep = 'plain'
            reply('334 ')
            return
          }
          reply('504 Unrecognized authentication type')
          return
        }
        case 'MAIL':
          reply('250 OK')
          return
        case 'RCPT':
          reply('250 OK')
          return
        case 'DATA':
          reply('354 End data with <CR><LF>.<CR><LF>')
          inData = true
          dataLines = []
          return
        case 'QUIT':
          reply('221 Bye')
          socket.end()
          return
        default:
          reply('500 Command not recognized')
      }
    }

    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      if (!context.encrypted) session.plainText += chunk.toString('utf-8')
      else session.encryptedText += chunk.toString('utf-8')

      buffer += decoder.write(chunk)

      let index = buffer.indexOf('\r\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)

        if (authStep) {
          const step = authStep
          const value = Buffer.from(line, 'base64').toString('utf-8')
          if (step === 'user') {
            session.authUser = value
            authStep = 'password'
            reply('334 UGFzc3dvcmQ6')
          } else if (step === 'password') {
            authStep = ''
            checkPassword(value, false)
          } else {
            authStep = ''
            checkPassword(line, true)
          }
          index = buffer.indexOf('\r\n')
          continue
        }

        if (inData) {
          if (line === '.') {
            inData = false
            session.data = dataLines.join('\r\n')
            reply('250 OK: queued as FAKE0001')
          } else {
            dataLines.push(line)
          }
          index = buffer.indexOf('\r\n')
          continue
        }

        session.commands.push(line)
        handleCommand(line)
        index = buffer.indexOf('\r\n')
      }
    })
  }

  const server =
    config.mode === 'tls'
      ? createTlsServer({ key: KEY, cert: CERT }, (socket) => handleConnection(socket, true))
      : createNetServer((socket) => handleConnection(socket, false))

  await new Promise((resolve) => server.listen(0, HOST, resolve))
  const port = server.address().port

  return {
    host: HOST,
    port,
    state,
    session: () => state.sessions.at(-1),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/**
 * 从假服务器收到的 DATA 里把 base64 正文解出来。
 * 正文是 multipart/alternative 时返回纯文本那一段（验证码在纯文本里也有一份）。
 */
export function extractMessageText(session) {
  const raw = session?.data ?? ''
  const headerEnd = raw.indexOf('\r\n\r\n')
  if (headerEnd < 0) return ''
  const body = raw.slice(headerEnd + 4)

  const boundaryMatch = /boundary="([^"]+)"/.exec(raw.slice(0, headerEnd))
  const segments = boundaryMatch ? body.split(`--${boundaryMatch[1]}`) : [body]

  for (const segment of segments) {
    if (boundaryMatch && !/text\/plain/i.test(segment)) continue
    const split = segment.indexOf('\r\n\r\n')
    const encoded = (split >= 0 ? segment.slice(split + 4) : segment).replace(/\r\n/g, '').trim()
    if (!encoded) continue
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
      if (decoded.trim()) return decoded
    } catch {
      // 不是 base64 就跳过这一段。
    }
  }
  return ''
}

/** 从邮件里把 6 位验证码抠出来。 */
export function extractCode(session) {
  return /(\d{6})/.exec(extractMessageText(session))?.[1] ?? ''
}

/** 把邮件头部按 RFC2047 解码，用来断言中文主题没有变成乱码。 */
export function decodeHeaderWord(value) {
  // 相邻 encoded-word 之间那个空白是折行加进去的，RFC 2047 要求解码时丢掉。
  // 不丢的话，长主题还原出来会凭空多出空格。
  const joined = String(value ?? '').replace(/\?=\s+=\?/g, '?==?')
  return joined.replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, payload) =>
    Buffer.from(payload, 'base64').toString('utf-8'))
}

/** 从原始邮件里取出某个头部的值，并把折行展开（保留折行处的空白）。 */
export function headerValue(raw, name) {
  const text = String(raw ?? '')
  const headerEnd = text.indexOf('\r\n\r\n')
  const lines = text.slice(0, headerEnd < 0 ? text.length : headerEnd).split('\r\n')
  const prefix = `${name.toLowerCase()}:`
  const index = lines.findIndex((line) => line.toLowerCase().startsWith(prefix))
  if (index < 0) return ''
  // 冒号后面的那个空格不属于头部值本身。
  let value = lines[index].slice(name.length + 1).replace(/^[ \t]+/, '')
  for (let i = index + 1; i < lines.length && lines[i].startsWith(' '); i += 1) value += lines[i]
  return value
}
