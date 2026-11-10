import { describe, expect, it } from 'vitest'
import { createResultObserver, readGenerationResult } from './generationResult.mjs'
import { SUB2API_DEFINITION } from './relayContract.mjs'

describe('最终成品计数', () => {
  it.each([true, false])('SSE 单项与最终汇总不会重复计图，汇总有前置文字，最终带ID=%s', (withId) => {
    const observer = createResultObserver({}, 'openai', true)
    observer.write(Buffer.from(`data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'image_generation_call', id: 'img-1', result: 'AAAA' } })}\n\n`))
    observer.write(Buffer.from(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', id: 'msg-1' }, { type: 'image_generation_call', ...(withId ? { id: 'img-1' } : {}), result: 'AAAA' }] } })}\n\n`))
    expect(observer.finish().count).toBe(1)
  })

  it('同一异步条目的 URL/Base64 是同一张图，running 预览不计成品', () => {
    const contract = { poll: SUB2API_DEFINITION.poll, result: SUB2API_DEFINITION.poll.result }
    const result = { data: [{ url: 'https://example.test/a.png', b64_json: 'AAAA' }] }
    expect(readGenerationResult({ status: 'running', result }, contract)).toMatchObject({ terminal: false, images: [] })
    expect(readGenerationResult({ status: 'completed', result }, contract).images).toHaveLength(1)
    expect(readGenerationResult({ status: 'failed', result }, contract).images).toHaveLength(0)
  })

  it('UTF8 中文在任意字节分块后仍保留完整自定义映射', () => {
    const observer = createResultObserver({ mapping: { result: { b64JsonPaths: ['图片.*.内容'] } } }, 'custom', false)
    const bytes = Buffer.from(JSON.stringify({ 图片: [{ 内容: 'AAAA' }] }))
    for (const byte of bytes) observer.write(Buffer.from([byte]))
    expect(observer.finish().count).toBe(1)
  })
})
