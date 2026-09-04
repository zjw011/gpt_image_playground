// 渠道自检的判定回归测试：判错一条就等于让管理员删掉一条本来能用的渠道，
// 或者把欠费的渠道一直留在链路里拖慢所有人。

import { describe, expect, it } from 'vitest'

import { classifyAuditFailure } from './channelAudit.mjs'

describe('classifyAuditFailure', () => {
  it('错误码优先于状态码：OpenAI 的欠费也是 429，只有 code 能区分', () => {
    expect(classifyAuditFailure(429, 'insufficient_quota', 'You exceeded your current quota')).toBe('no-balance')
    expect(classifyAuditFailure(429, 'rate_limit_exceeded', 'Rate limit reached')).toBe('rate-limit')
  })

  it('402 直接判没余额，不用看文案', () => {
    expect(classifyAuditFailure(402, '', '')).toBe('no-balance')
  })

  it('认得中文网关的各种欠费说法', () => {
    const messages = [
      '当前分组上游负载已饱和，余额不足',
      '该令牌额度已用尽',
      '用户额度不足',
      '配额已耗尽，请充值后重试',
      '账户已欠费，请先充值',
      '预扣费失败，余额不足',
    ]
    for (const message of messages) {
      expect(classifyAuditFailure(400, '', message), message).toBe('no-balance')
    }
  })

  it('认得英文欠费说法', () => {
    const messages = [
      'Insufficient credits',
      'You have exceeded your current quota, please check your plan and billing details',
      'Your balance is too low',
      'out of credits',
      'Billing hard limit has been reached',
    ]
    for (const message of messages) {
      expect(classifyAuditFailure(400, '', message), message).toBe('no-balance')
    }
  })

  it('密钥问题不能被误判成没余额——处理方式完全不同', () => {
    expect(classifyAuditFailure(401, '', 'Incorrect API key provided')).toBe('auth')
    expect(classifyAuditFailure(403, 'invalid_api_key', '')).toBe('auth')
    expect(classifyAuditFailure(400, '', '无效的令牌')).toBe('auth')
    expect(classifyAuditFailure(400, '', '令牌验证失败')).toBe('auth')
  })

  it('模型不可用单独一类：密钥和余额都没问题，改模型就行', () => {
    expect(classifyAuditFailure(404, 'model_not_found', '')).toBe('model')
    expect(classifyAuditFailure(400, '', '当前分组下没有可用的渠道')).toBe('model')
    expect(classifyAuditFailure(400, '', 'The model `gpt-image-9` does not exist')).toBe('model')
  })

  it('限流说明密钥有效，不该建议停用', () => {
    expect(classifyAuditFailure(429, '', 'Too many requests')).toBe('rate-limit')
    expect(classifyAuditFailure(400, '', '请求过于频繁，请稍后再试')).toBe('rate-limit')
  })

  it('连不上和一般错误分开：前者是地址/网络问题', () => {
    expect(classifyAuditFailure(0, '', 'connect ETIMEDOUT')).toBe('unreachable')
    expect(classifyAuditFailure(500, '', 'internal server error')).toBe('error')
    expect(classifyAuditFailure(503, '', 'upstream unavailable')).toBe('error')
  })

  it('"限流"字样出现在欠费文案里时仍判没余额——顺序不能反', () => {
    expect(classifyAuditFailure(429, '', '余额不足，触发限流保护')).toBe('no-balance')
  })

  it('空错误信息落到通用错误，不瞎猜', () => {
    expect(classifyAuditFailure(500, '', '')).toBe('error')
  })
})
