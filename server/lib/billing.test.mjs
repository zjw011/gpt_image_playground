// 计费解析回归测试。
//
// 这块逻辑的价值全在"能不能从原始请求体里把张数读对"——读错一次就是多扣或少扣用户的钱。
// 所以各种请求体形态都要覆盖：OpenAI 兼容的 JSON 与 multipart、fal 的 num_images、
// 以及最坑的一种：请求体被首块截断，JSON.parse 直接失败。

import { describe, expect, it } from 'vitest'

import {
  actualCost,
  estimateCost,
  isAgentEndpoint,
  isBillableRequest,
  isLowBalance,
  parseImageCount,
  unitCost,
} from './billing.mjs'

/** 按前端真实的构造顺序拼一段 multipart，张数字段在前。 */
function multipart(fields, boundary = '----WebKitFormBoundaryTest123') {
  const parts = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="${name}"\r\n`,
      '\r\n',
      `${value}\r\n`,
    )
  }
  parts.push(`--${boundary}--\r\n`)
  return Buffer.from(parts.join(''), 'utf-8')
}

function site(overrides = {}) {
  return {
    credits: {
      enabled: true,
      costPerImage: 1,
      signupBonus: 0,
      purchaseUrl: '',
      packs: [],
      channelRates: {},
      ...overrides,
    },
  }
}

describe('parseImageCount', () => {
  it('JSON 请求体里没有 n 就是 1 张——前端只在 n>1 时才带上这个字段', () => {
    const body = JSON.stringify({ model: 'gpt-image-2', prompt: '一只猫', size: '1024x1024' })
    expect(parseImageCount(Buffer.from(body), 'application/json')).toBe(1)
  })

  it('JSON 请求体里读得出 n', () => {
    const body = JSON.stringify({ model: 'gpt-image-2', prompt: '猫', n: 4 })
    expect(parseImageCount(Buffer.from(body), 'application/json')).toBe(4)
  })

  it('fal 用的是 num_images', () => {
    const body = JSON.stringify({ prompt: '猫', num_images: 3 })
    expect(parseImageCount(Buffer.from(body), 'application/json')).toBe(3)
  })

  it('请求体被首块截断（JSON 不完整）时退回正则，仍能读对', () => {
    // 真实场景：后面还跟着几 MB 的图片数据，首块只切到中途。
    const head = Buffer.from('{"model":"gpt-image-2","n":4,"image":["data:image/png;base64,iVBORw0KGgoAAAANSU', 'utf-8')
    expect(parseImageCount(head, 'application/json')).toBe(4)
  })

  it('multipart 里读得出 n', () => {
    const body = multipart({ model: 'gpt-image-2', prompt: '改成蓝色', n: 2 })
    expect(parseImageCount(body, 'multipart/form-data; boundary=----WebKitFormBoundaryTest123')).toBe(2)
  })

  it('multipart 里没有 n 就是 1 张', () => {
    const body = multipart({ model: 'gpt-image-2', prompt: '改成蓝色', size: '1024x1024' })
    expect(parseImageCount(body, 'multipart/form-data; boundary=x')).toBe(1)
  })

  it('multipart 里 n 出现在后面的字段也读得到——不能依赖字段顺序', () => {
    const body = multipart({ model: 'gpt-image-2', prompt: '猫', size: '1024x1024', n: 4 })
    expect(parseImageCount(body, 'multipart/form-data; boundary=x')).toBe(4)
  })

  it('同一请求体里出现两个 n 时取最大值，避免用小值蒙混', () => {
    const body = Buffer.from(
      '--B\r\nContent-Disposition: form-data; name="n"\r\n\r\n1\r\n'
      + '--B\r\nContent-Disposition: form-data; name="n"\r\n\r\n4\r\n--B--\r\n',
      'utf-8',
    )
    expect(parseImageCount(body, 'multipart/form-data')).toBe(4)
  })

  it('Content-Type 缺失或不规范时两条路都试', () => {
    expect(parseImageCount(Buffer.from('{"n":3}'), '')).toBe(3)
    expect(parseImageCount(multipart({ n: 2 }), 'text/plain')).toBe(2)
  })

  it('畸形或超大张数被夹到安全范围，不会把余额直接扣穿', () => {
    expect(parseImageCount(Buffer.from('{"n":999999}'), 'application/json')).toBe(16)
    expect(parseImageCount(Buffer.from('{"n":0}'), 'application/json')).toBe(1)
    expect(parseImageCount(Buffer.from('{"n":-5}'), 'application/json')).toBe(1)
    expect(parseImageCount(Buffer.from('{"n":"abc"}'), 'application/json')).toBe(1)
  })

  it('空请求体返回 1 张而不是报错', () => {
    expect(parseImageCount(Buffer.alloc(0), 'application/json')).toBe(1)
    expect(parseImageCount(null, '')).toBe(1)
  })
})

describe('isBillableRequest', () => {
  const openai = { provider: 'openai' }
  const fal = { provider: 'fal' }

  it('只认出图提交这一种请求', () => {
    expect(isBillableRequest('POST', openai, 'images/generations')).toBe(true)
    expect(isBillableRequest('POST', openai, 'images/edits')).toBe(true)
    expect(isBillableRequest('POST', openai, 'responses')).toBe(true)
  })

  it('轮询与查询一律不计费——异步渠道一次出图能轮几十次', () => {
    expect(isBillableRequest('GET', openai, 'images/generations')).toBe(false)
    expect(isBillableRequest('GET', openai, 'tasks/abc')).toBe(false)
    expect(isBillableRequest('POST', openai, 'models')).toBe(false)
    expect(isBillableRequest('POST', openai, 'files')).toBe(false)
  })

  it('带查询串或多余斜杠的路径也能认出来', () => {
    expect(isBillableRequest('POST', openai, 'images/generations?foo=1')).toBe(true)
    expect(isBillableRequest('POST', openai, 'images/edits/')).toBe(true)
  })

  it('fal 没有固定路径约定，POST 就算一次出图', () => {
    expect(isBillableRequest('POST', fal, 'fal-ai/flux/dev')).toBe(true)
    expect(isBillableRequest('GET', fal, 'fal-ai/flux/dev')).toBe(false)
  })

  it('isAgentEndpoint 认出 Agent 走的 Responses 端点', () => {
    expect(isAgentEndpoint('responses')).toBe(true)
    expect(isAgentEndpoint('v1/responses')).toBe(true)
    expect(isAgentEndpoint('images/generations')).toBe(false)
  })
})

describe('定价', () => {
  it('基础单价直接生效', () => {
    expect(unitCost(site({ costPerImage: 5 }), 'ch-1')).toBe(5)
  })

  it('渠道倍率按百分比算，向上取整且至少 1 分', () => {
    const config = site({ costPerImage: 3, channelRates: { 'ch-cheap': 50, 'ch-expensive': 150 } })
    expect(unitCost(config, 'ch-cheap')).toBe(2)
    expect(unitCost(config, 'ch-expensive')).toBe(5)
    expect(unitCost(config, 'unknown-channel')).toBe(3)
  })

  it('单价 0 或积分未启用时全都不计费——相当于回到免费模式', () => {
    expect(unitCost(site({ costPerImage: 0 }), 'ch-1')).toBe(0)
    expect(unitCost(site({ enabled: false, costPerImage: 5 }), 'ch-1')).toBe(0)
    expect(actualCost(site({ costPerImage: 0 }), 'ch-1', 4)).toBe(0)
  })

  it('实际费用按落地渠道的价格算', () => {
    const config = site({ costPerImage: 2, channelRates: { 'ch-a': 100, 'ch-b': 300 } })
    expect(actualCost(config, 'ch-a', 3)).toBe(6)
    expect(actualCost(config, 'ch-b', 3)).toBe(18)
  })

  it('预扣按候选里最贵的算——故障转移是后台自动做的，不能让用户余额在半路不够', () => {
    const config = site({ costPerImage: 2, channelRates: { 'ch-a': 100, 'ch-b': 500 } })
    expect(estimateCost(config, ['ch-a', 'ch-b'], 2)).toBe(20)
    expect(estimateCost(config, ['ch-b', 'ch-a'], 2)).toBe(20)
    expect(estimateCost(config, ['ch-a'], 2)).toBe(4)
  })

  it('余额低于最低单价时前台可以提前提示', () => {
    expect(isLowBalance(site({ costPerImage: 4 }), 3)).toBe(true)
    expect(isLowBalance(site({ costPerImage: 4 }), 4)).toBe(false)
    expect(isLowBalance(site({ enabled: false, costPerImage: 4 }), 0)).toBe(false)
  })
})
