import { describe, expect, it } from 'vitest'

import { getClientIp, parseCookies } from './http.mjs'

function req(headers = {}, remoteAddress = '203.0.113.10') {
  return { headers, socket: { remoteAddress } }
}

describe('getClientIp', () => {
  it('损坏 Cookie 不抛出异常且保留其他合法 Cookie', () => {
    expect(parseCookies('broken=%E0%A4%A; gip_guest=valid%20token; other=%')).toEqual({ gip_guest: 'valid token' })
  })
  it('默认忽略客户端可伪造的代理头', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' }), false)).toBe('203.0.113.10')
  })

  it('显式信任代理时优先使用 X-Real-IP', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '198.51.100.8' }), true)).toBe('198.51.100.8')
  })

  it('没有 X-Real-IP 时取转发链最右一跳', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '1.2.3.4, 198.51.100.9' }), true)).toBe('198.51.100.9')
  })
})
