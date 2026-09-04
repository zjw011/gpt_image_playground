// 渠道自检：真发一次最小出图请求，回答"这条渠道现在到底能不能用"。
// 只出判定，不动配置——要不要停用由管理员在后台点。
//
// 为什么必须真出图：/models 能列模型只说明密钥格式对、网关活着，
// 欠费的账号照样能列模型。余额不足只在真正扣费的那一刻才报出来。

import { buildUpstreamUrl } from './upstream.mjs'

// 自检最长等这么久。真出图比 /models 慢得多，但也不能让后台一直转。
const AUDIT_TIMEOUT_MS = 120_000
// 用英文短提示，避免被上游的中文内容审核挡下来误判成"渠道有问题"。
const AUDIT_PROMPT = 'a plain light gray circle on a white background'

// 明确的错误码优先于文案匹配：OpenAI 的欠费和限流都是 429，只有 code 能区分。
const ERROR_CODES = {
  'no-balance': new Set([
    'insufficient_quota',
    'insufficient_user_quota',
    'insufficient_balance',
    'quota_exceeded',
    'billing_not_active',
    'billing_hard_limit_reached',
    'credit_exhausted',
    'account_deactivated',
  ]),
  'rate-limit': new Set(['rate_limit_exceeded', 'requests_rate_limit', 'tokens_exceeded_rate_limit', 'too_many_requests']),
  auth: new Set([
    'invalid_api_key',
    'invalid_authentication',
    'authentication_error',
    'invalid_request_error_authentication',
    'token_not_found',
    'invalid_token',
    'unauthorized',
  ]),
  model: new Set(['model_not_found', 'model_not_available', 'unsupported_model']),
}

// 没余额。中文网关（one-api / new-api 系）和 OpenAI 官方的说法都收在这里。
const NO_BALANCE_PATTERNS = [
  /余额不足/,
  /余额已(用完|不足|耗尽)/,
  /(额度|配额)不足/,
  /(额度|配额)已(用尽|耗尽|用完)/,
  /令牌额度/,
  /欠费/,
  /请先?充值/,
  /充值后(再|重试)/,
  /预扣费失败/,
  /insufficient[\s_-]*(quota|balance|credit|credits|funds)/i,
  /exceeded your current quota/i,
  /quota (has been )?exceeded/i,
  /out of credits?/i,
  /no credits? (left|remaining|available)/i,
  /balance is (too low|insufficient|zero|negative)/i,
  /billing (hard )?limit/i,
  /payment required/i,
  /in arrears/i,
]

const AUTH_PATTERNS = [
  /(密钥|令牌|token).{0,6}(无效|错误|不正确|不存在|已过期|被禁用|已禁用|已封禁)/i,
  /无效的?(密钥|令牌|token|api\s*key)/i,
  /(令牌|密钥|鉴权|认证).{0,4}(验证)?失败/,
  /未提供(密钥|令牌|api\s*key)/i,
  /invalid.{0,12}(api[\s_-]*key|token|authentication|credential)/i,
  /incorrect api key/i,
  /authentication (failed|error)/i,
  /unauthorized/i,
  /permission denied/i,
]

const MODEL_PATTERNS = [
  /模型.{0,8}(不存在|不可用|未找到|不支持|无权|没有权限)/,
  /无可用渠道/,
  /没有可用的?(渠道|分组)/,
  // 中间常夹着反引号包起来的模型名，留够宽度：The model `gpt-image-9` does not exist。
  /model.{0,32}(not found|not exist|does not exist|not available|not supported|unavailable)/i,
  /does not have access to (the )?model/i,
  /no such model/i,
  /unsupported model/i,
]

const RATE_LIMIT_PATTERNS = [
  /(请求|访问).{0,4}(过于频繁|太频繁)/,
  /(限流|频率限制|速率限制)/,
  /上游负载已饱和/,
  /rate limit/i,
  /too many requests/i,
  /overloaded/i,
]

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从返回体里挖出错误码与错误文案。各家网关嵌套层数不一，挖不到就退回原始文本。 */
function readUpstreamError(bodyText) {
  let parsed
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return { code: '', message: bodyText.trim().slice(0, 300) }
  }

  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : isRecord(parsed) ? parsed : {}
  const code = String(error.code ?? error.type ?? '').trim().toLowerCase()
  const message = [error.message, error.detail, error.msg, isRecord(parsed) ? parsed.message : '']
    .map((item) => (typeof item === 'string' ? item : ''))
    .find((item) => item.trim())
  return { code, message: (message ?? bodyText).trim().slice(0, 300) }
}

/**
 * 把一次失败的出图请求归类。
 *
 * 顺序有讲究：先认错误码，再认"没余额"的文案，最后才落到限流和通用错误。
 * 反过来会把 OpenAI 的 429 insufficient_quota 误判成限流，管理员就永远查不出是欠费。
 */
export function classifyAuditFailure(status, code, message) {
  const text = `${code} ${message}`

  for (const [verdict, codes] of Object.entries(ERROR_CODES)) {
    if (code && codes.has(code)) return verdict
  }

  // 402 就是为"该付钱了"设计的状态码，不用再看文案。
  if (status === 402) return 'no-balance'
  if (NO_BALANCE_PATTERNS.some((pattern) => pattern.test(text))) return 'no-balance'
  if (status === 401 || AUTH_PATTERNS.some((pattern) => pattern.test(text))) return 'auth'
  if (MODEL_PATTERNS.some((pattern) => pattern.test(text))) return 'model'
  if (status === 429 || RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text))) return 'rate-limit'
  if (status === 0) return 'unreachable'
  return 'error'
}

/** 自检用的最小出图请求体。quality=low 是为了省钱，跑一遍几十条渠道不至于烧掉太多额度。 */
function auditBody(channel) {
  const body = { model: channel.model, prompt: AUDIT_PROMPT, n: 1 }
  // dall-e 系列的 quality 取值和 gpt-image 完全不同，索性不带。
  if (channel.model.startsWith('dall-e')) return body
  return { ...body, size: '1024x1024', quality: 'low' }
}

/** Responses 渠道的最小出图请求。Codex CLI 兼容模式不认 size/quality。 */
function auditResponsesBody(channel) {
  const tool = { type: 'image_generation' }
  if (!channel.codexCli) {
    tool.size = '1024x1024'
    tool.quality = 'low'
  }
  return {
    model: channel.model,
    input: AUDIT_PROMPT,
    tools: [tool],
    tool_choice: { type: 'image_generation' },
    stream: false,
  }
}

/** 返回体里到底有没有图。2xx 但没图也是管理员要知道的一种坏法。 */
function hasImagePayload(bodyText) {
  return /"b64_json"\s*:\s*"[^"]/.test(bodyText)
    || /"url"\s*:\s*"https?:/.test(bodyText)
    || /"result"\s*:\s*"[A-Za-z0-9+/]{64}/.test(bodyText)
    || /"task_id"\s*:\s*"[^"]/.test(bodyText)
    || /"data"\s*:\s*\[\s*\{/.test(bodyText)
}

async function postJson(url, apiKey, body, signal) {
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    return { status: response.status, bodyText: (await response.text()).slice(0, 4000), latencyMs: Date.now() - started }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      status: 0,
      bodyText: aborted ? `自检超时（${Math.round(AUDIT_TIMEOUT_MS / 1000)} 秒没出图）` : err instanceof Error ? err.message : '请求失败',
      latencyMs: Date.now() - started,
    }
  }
}

/** 自检要打的端点与请求体。异步渠道只能确认"提交被受理"，扣费可能发生在出图完成时。 */
function auditTarget(channel, customProviders) {
  if (channel.provider === 'openai' && channel.apiMode === 'responses') {
    return { path: 'responses', body: auditResponsesBody(channel), async: false }
  }
  if (channel.provider === 'openai') {
    return { path: 'images/generations', body: auditBody(channel), async: false }
  }
  if (channel.provider === 'sb2api-async') {
    return { path: 'images/generations/async', body: auditBody(channel), async: true }
  }

  const manifest = customProviders.find((item) => item.id === channel.provider)
  const path = manifest?.submit?.path ?? manifest?.generate?.path
  if (!path) return null
  return { path: String(path), body: auditBody(channel), async: Boolean(manifest?.poll) }
}

/**
 * 自检一条渠道。真出一张最小尺寸的图，因此会消耗一点额度——这是能区分
 * "没余额"和"密钥错"的唯一办法，调用方必须先跟管理员讲清楚。
 */
export async function auditChannel(channel, customProviders = []) {
  if (!channel.apiKey) return { verdict: 'skipped', status: 0, latencyMs: 0, message: '没配 API Key，无从判断' }
  if (channel.provider === 'fal') {
    return { verdict: 'skipped', status: 0, latencyMs: 0, message: 'fal 没有统一的出图/余额探测端点，请到 fal.ai 控制台看余额' }
  }

  const target = auditTarget(channel, customProviders)
  if (!target) return { verdict: 'skipped', status: 0, latencyMs: 0, message: `自定义服务商「${channel.provider}」没有可识别的提交端点` }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS)
  try {
    const url = buildUpstreamUrl(channel.baseUrl, target.path, '')
    let result = await postJson(url, channel.apiKey, target.body, controller.signal)

    // size / quality 是省钱用的，网关不认就去掉重来一次，别让参数问题冒充成渠道故障。
    if (result.status === 400 && /size|quality|不支持的?参数|unknown (parameter|field)/i.test(result.bodyText)) {
      result = await postJson(url, channel.apiKey, { model: channel.model, prompt: AUDIT_PROMPT, n: 1 }, controller.signal)
    }

    if (result.status >= 200 && result.status < 300) {
      if (!hasImagePayload(result.bodyText)) {
        return { ...result, verdict: 'error', message: '接口返回成功但没给出图片数据，前端会报"接口未返回图片"' }
      }
      return {
        ...result,
        verdict: 'ok',
        message: target.async ? '提交被受理（异步渠道，扣费可能发生在出图完成时）' : '出图成功，余额和密钥都正常',
      }
    }

    const error = readUpstreamError(result.bodyText)
    return {
      ...result,
      verdict: classifyAuditFailure(result.status, error.code, error.message),
      message: `HTTP ${result.status}：${error.message || '无响应内容'}`,
    }
  } catch (err) {
    return {
      verdict: 'error',
      status: 0,
      latencyMs: 0,
      message: err instanceof Error ? err.message : '自检失败',
    }
  } finally {
    clearTimeout(timer)
  }
}
