// 浏览器和中继共用错误语义；只读取响应的诊断字段，不能用提示词或图片 URL 猜审核结果。
function errorText(value, depth = 0) {
  if (depth > 8 || value == null) return ''
  if (typeof value === 'string') {
    const text = value.trim()
    const json = text.replace(/^HTTP\s*\d{3}\s*[:：]\s*/i, '')
    if (/^(?:\{|\[\s*[{"])/.test(json)) {
      // 截断 JSON 里可能混有原提示词，解析失败时不能拿全文推断审核结果。
      try { return errorText(JSON.parse(json), depth + 1) } catch { return '' }
    }
    return text.slice(0, 8192)
  }
  if (value instanceof Error) return [errorText(value.message, depth + 1), errorText(value.cause, depth + 1), errorText(value.code, depth + 1)].filter(Boolean).join('；')
  if (Array.isArray(value)) return value.slice(0, 100).filter((item) => item && typeof item === 'object').map((item) => errorText(item, depth + 1)).filter(Boolean).join('；')
  if (typeof value !== 'object') return ''

  const parts = []
  if (value.type === 'refusal' || (typeof value.refusal === 'string' && value.refusal.trim())) parts.push('content_policy_violation')
  for (const key of ['error', 'errors', 'message', 'msg', 'detail', 'code', 'error_code', 'error_message', 'type', 'status', 'reason', 'finish_reason', 'stop_reason', 'fail_reason', 'refusal', 'block_reason', 'blockReason']) {
    if (key === 'type' && !/error|fail|refus|cancel|block|filter|safety|policy|moderation/i.test(String(value[key] ?? ''))) continue
    if (key === 'status' && !/fail|error|reject|cancel|timeout|blocked/i.test(String(value[key] ?? ''))) continue
    const text = Array.isArray(value[key])
      ? value[key].slice(0, 100).map((item) => errorText(item, depth + 1)).filter(Boolean).join('；')
      : errorText(value[key], depth + 1)
    if (text) parts.push(text)
  }
  for (const key of ['response', 'data', 'output', 'item', 'content', 'incomplete_details', 'prompt_feedback', 'promptFeedback']) {
    if (!value[key] || typeof value[key] !== 'object') continue
    const text = errorText(value[key], depth + 1)
    if (text) parts.push(text)
  }
  return [...new Set(parts)].join('；')
}

export function classifyGenerationError(value) {
  const text = errorText(value)
  if (/\b(?:content[_-](?:policy(?:[_-](?:violation|rejection))?|filter(?:ed)?)|content\s+(?:policy\s+(?:violation|rejection)|filtered)|safety[_ -]*(?:violations?|rejection|reject(?:ed)?|blocked)|moderation[_ -]*(?:blocked|rejected)|responsible[_ -]*ai[_ -]*policy[_ -]*violation)\b/i.test(text)
    || /\b(?:blocked|rejected|flagged|refused)\b[^\n]{0,100}\b(?:safety|moderation|content policy|nsfw)\b/i.test(text)
    || /\b(?:nsfw|sexual|adult|explicit|inappropriate|unsafe)\s+content\b[^\n]{0,60}\b(?:detected|blocked|rejected|not allowed|prohibited)\b/i.test(text)
    || /(?:^|；)(?:nsfw|safety|image_safety|prohibited_content)(?:$|；)/i.test(text)
    || /(?:内容|安全|敏感|违规|色情|成人).{0,16}(?:审核未通过|审核不通过|审核失败|被拒绝|被拦截|不符合.{0,8}(?:政策|策略)|违反.{0,8}(?:政策|策略))|(?:违反|触发|未通过).{0,12}(?:内容政策|内容策略|安全策略|安全政策|内容审核|安全审核)|内容安全审核未通过/i.test(text)) return 'content_policy'
  if (/\b(?:timed?[_ -]*out|timeout|ETIMEDOUT|UND_ERR_(?:HEADERS|BODY|CONNECT)_TIMEOUT)\b|超时/i.test(text)) return 'timeout'
  if (/\b(?:cancelled|canceled|request[_ -]*cancel(?:led|ed)?)\b|(?:请求|任务|生成|上游).{0,12}(?:已取消|被取消)|^已取消$|^请求已停止$/i.test(text)) return 'cancelled'
  return null
}

export function formatGenerationError(value, fallback = '') {
  const text = errorText(value) || fallback || (typeof value === 'string' ? value.slice(0, 8192) : value instanceof Error ? value.message : '')
  const kind = classifyGenerationError(value)
  if (kind === 'content_policy' && !text.startsWith('内容安全审核未通过')) return `内容安全审核未通过：${text}`
  if (kind === 'cancelled' && !text.startsWith('上游生成任务已取消')) return `上游生成任务已取消：${text}`
  return text
}

/** HTTP 200、异步轮询和 SSE 也可能携带失败，必须在提取图片前检查。 */
export function getGenerationResponseError(payload) {
  if (!payload || typeof payload !== 'object') return null
  if (classifyGenerationError(payload)) return formatGenerationError(payload)
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const message = getGenerationResponseError(item)
      if (message) return message
    }
    return null
  }
  if (errorText(payload.error) || errorText(payload.errors) || /^(?:failed|error|rejected)$/i.test(String(payload.status ?? '')) || /(?:^|\.)failed$|^error$/.test(String(payload.type ?? ''))) {
    return formatGenerationError(payload, '上游生成请求失败')
  }
  for (const key of ['response', 'data', 'output', 'item', 'content']) {
    const message = getGenerationResponseError(payload[key])
    if (message) return message
  }
  return null
}
