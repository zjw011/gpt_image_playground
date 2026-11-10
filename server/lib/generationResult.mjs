import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { getGenerationResponseError } from '../../src/lib/generationError.mjs'

export function valuesAtPath(value, path) {
  let values = [value]
  for (const key of String(path || '').split('.').filter(Boolean)) {
    values = values.flatMap((item) => key === '*' ? Array.isArray(item) ? item : item && typeof item === 'object' ? Object.values(item) : [] : item?.[key] === undefined ? [] : [item[key]])
  }
  return values
}

/** 只统计完整图片，预览帧、任务 ID、工具调用文本均不算成品。 */
export function readGenerationResult(payload, contract = {}, provider = 'openai') {
  const result = { images: [], imageIds: [], taskId: '', error: getGenerationResponseError(payload), terminal: false }
  if (!payload || typeof payload !== 'object') return result
  const body = payload.response && typeof payload.response === 'object' ? payload.response : payload
  const mapping = contract.result || contract.mapping?.result
  if (mapping) {
    const seen = new Set()
    for (const path of [...(mapping.imageUrlPaths || []), ...(mapping.b64JsonPaths || [])]) {
      let entries = [{ value: body, path: [] }]
      for (const key of path.split('.')) {
        entries = entries.flatMap((entry) => {
          if (!entry.value || typeof entry.value !== 'object') return []
          const keys = key === '*' ? Object.keys(entry.value) : [key]
          return keys.filter((name) => Object.hasOwn(entry.value, name)).map((name) => ({ value: entry.value[name], path: [...entry.path, name] }))
        })
      }
      for (const entry of entries) {
        if (typeof entry.value !== 'string' || !entry.value.trim()) continue
        const representation = entry.path.findIndex((key) => ['url', 'b64_json', 'base64', 'image_url'].includes(key))
        const source = representation < 0 ? entry.path : entry.path.slice(0, representation)
        const key = source.join('.')
        const owner = source.length ? valuesAtPath(body, key)[0] : body
        if (seen.has(key) || source.length && owner && typeof owner === 'object' && getGenerationResponseError(owner)) continue
        seen.add(key)
        result.images.push(entry.value)
        result.imageIds.push(typeof owner?.id === 'string' ? owner.id : '')
      }
    }
  } else {
    const entries = provider === 'fal'
      ? Array.isArray(body.images) ? body.images : body.image ? [body.image] : [body]
      : Array.isArray(body.data) ? body.data : Array.isArray(body.output) ? body.output : body.item ? [body.item] : [body]
    for (const entry of entries) {
      if (provider === 'fal' && typeof entry === 'string' && /^(?:https?:|data:image\/)/.test(entry)) { result.images.push(entry); result.imageIds.push(''); continue }
      if (!entry || typeof entry !== 'object' || getGenerationResponseError(entry) || /partial_image/.test(String(body.type || ''))) continue
      let value = entry.b64_json || entry.url
      if (entry.type === 'image_generation_call') {
        const output = entry.result
        value = typeof output === 'string' ? output : output?.b64_json || output?.base64 || output?.image || output?.data
      }
      if (typeof value === 'string' && value.trim()) {
        result.images.push(value)
        result.imageIds.push(typeof entry.id === 'string' ? entry.id : '')
      }
    }
  }
  const taskId = contract.mapping?.taskIdPath ? valuesAtPath(body, contract.mapping.taskIdPath)[0] : body.task_id || body.data?.task_id || (provider === 'fal' ? body.request_id : '')
  if (typeof taskId === 'string' && taskId.trim()) result.taskId = taskId.trim()
  if (typeof taskId === 'number' && Number.isFinite(taskId)) result.taskId = String(taskId)
  const poll = contract.poll || contract.definition?.poll
  const status = poll ? valuesAtPath(body, poll.statusPath)[0] : body.status
  const successes = poll?.successValues || ['completed', 'COMPLETED', 'succeeded', 'SUCCESS']
  const failures = poll?.failureValues || ['failed', 'FAILED', 'cancelled', 'canceled', 'CANCELLED']
  if (poll?.errorPath && !result.error) {
    const error = valuesAtPath(body, poll.errorPath)[0]
    if (typeof error === 'string' && error.trim()) result.error = error
  }
  result.terminal = successes.includes(status) || failures.includes(status) || !poll && result.images.length > 0 || Boolean(result.error)
  if (poll && !successes.includes(status)) { result.images = []; result.imageIds = [] }
  return result
}

/** SSE 按完整事件归档并去重，已结束图片之后再出现错误仍保留实际成品。 */
export function createResultObserver(contract, provider, streaming) {
  let pending = ''
  let bytes = 0
  let taskId = ''
  let lastPayload = null
  let largestBatch = 0
  const images = new Map()
  const decoder = new StringDecoder('utf8')
  const consume = (text) => {
    if (!text || text === '[DONE]') return
    let payload
    try { payload = JSON.parse(text) } catch { return }
    lastPayload = payload
    const result = readGenerationResult(payload, contract, provider)
    largestBatch = Math.max(largestBatch, result.images.length)
    for (const [idx, image] of result.images.entries()) {
      const hash = createHash('sha256').update(image).digest('hex')
      const ids = images.get(hash) || new Set()
      const id = result.imageIds[idx]
      if (id) { ids.delete(''); ids.add(id) }
      else if (!ids.size) ids.add('')
      images.set(hash, ids)
    }
    if (result.taskId) taskId = result.taskId
  }
  return {
    write(chunk) {
      bytes += chunk.length
      if (bytes > 128 * 1024 * 1024) throw new Error('上游响应超过 128MB 限制')
      pending += decoder.write(chunk)
      if (!streaming) return
      const frames = pending.split(/\r?\n\r?\n/)
      pending = frames.pop() || ''
      for (const frame of frames) consume(frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n'))
    },
    finish() {
      pending += decoder.end()
      if (!streaming) consume(pending)
      else if (pending.trim()) consume(pending.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n'))
      return { count: Math.max(largestBatch, [...images.values()].reduce((sum, ids) => sum + ids.size, 0)), taskId, payload: lastPayload }
    },
  }
}
