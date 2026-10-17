import { describe, expect, it } from 'vitest'
import { getApiErrorMessage, maybeAppendStreamingHint } from './imageApiShared'
import { isImageSizeError } from './taskFailure'

describe('参考图超限错误跨接口保留', () => {
  it.each(['Bad Request', '<html>Request rejected</html>'])('413 的非结构化正文也能识别', async (body) => {
    const message = await getApiErrorMessage(new Response(body, { status: 413 }))
    expect(isImageSizeError(message)).toBe(true)
    expect(message).toContain(body)
  })
  it('413 JSON 正文没有大小关键词时仍保留状态码', async () => {
    const message = await getApiErrorMessage(new Response(JSON.stringify({ error: { message: 'Rejected' } }), { status: 413 }))
    expect(message).toBe('HTTP 413: Rejected')
  })
  it.each([400, 413])('大小错误不建议用户关闭流式传输（%s）', (status) => {
    expect(maybeAppendStreamingHint('invalid request: file too large', status, true)).toBe('invalid request: file too large')
  })
  it('其他明确的参数错误仍保留原行为', () => {
    expect(maybeAppendStreamingHint('unsupported parameter', 400, true)).toContain('流式传输')
  })
})
