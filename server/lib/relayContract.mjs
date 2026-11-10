import { HttpError } from './http.mjs'

export const MAX_IMAGES_PER_REQUEST = 16

/** 完整解析字段；图片文件不转成字符串，提示词内部的 n/model 也不算顶层字段。 */
export function parseRelayFields(body, contentType = '') {
  if (!body.length) return { fields: {}, json: null }
  if (!String(contentType).toLowerCase().includes('multipart/form-data')) {
    let json
    try { json = JSON.parse(body.toString('utf-8')) } catch { throw new HttpError(400, '生成请求 JSON 不完整或格式无效') }
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new HttpError(400, '生成请求必须是 JSON 对象')
    return { fields: json, json }
  }
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  const value = boundary?.[1] || boundary?.[2]
  if (!value || value.length > 200) throw new HttpError(400, '表单 boundary 无效')
  const marker = Buffer.from(`--${value}`)
  const fields = {}
  let start = body.indexOf(marker)
  while (start >= 0) {
    start += marker.length
    if (body.subarray(start, start + 2).toString() === '--') return { fields, json: null }
    if (body.subarray(start, start + 2).toString() !== '\r\n') throw new HttpError(400, '表单分隔符无效')
    const headerEnd = body.indexOf('\r\n\r\n', start)
    if (headerEnd < 0 || headerEnd - start > 8192) throw new HttpError(400, '表单字段头无效')
    const end = body.indexOf(Buffer.from(`\r\n--${value}`), headerEnd + 4)
    if (end < 0) throw new HttpError(400, '表单上传不完整')
    const header = body.subarray(start, headerEnd).toString('utf-8')
    const name = /(?:^|;)\s*name="([^"]+)"/i.exec(header)?.[1]
    if (['model', 'n', 'num_images', 'batch_size'].includes(name) && /;\s*filename(?:\*)?=/i.test(header)) throw new HttpError(400, '模型和张数必须是普通表单字段')
    if (name && !/;\s*filename(?:\*)?=/i.test(header)) {
      if (['__proto__', 'prototype', 'constructor'].includes(name) || Object.hasOwn(fields, name)) throw new HttpError(400, '表单包含重复或无效字段')
      if (end - headerEnd > 1024 * 1024) throw new HttpError(413, '表单文本字段过大')
      fields[name] = body.subarray(headerEnd + 4, end).toString('utf-8')
    }
    start = end + 2
  }
  throw new HttpError(400, '表单上传不完整')
}

export function imageCountFromFields(fields) {
  const values = ['n', 'num_images', 'batch_size'].filter((key) => fields[key] != null).map((key) => Number(fields[key]))
  if (values.some((value) => !Number.isInteger(value) || value < 1 || value > MAX_IMAGES_PER_REQUEST)) throw new HttpError(400, '单次生成张数必须是 1–16 的整数')
  if (new Set(values).size > 1) throw new HttpError(400, '生成张数字段互相冲突')
  return values[0] ?? 1
}

export const SUB2API_DEFINITION = {
  submit: { path: 'images/generations/async', method: 'POST', taskIdPath: 'task_id' },
  editSubmit: { path: 'images/edits/async', method: 'POST', taskIdPath: 'task_id' },
  poll: { path: 'images/tasks/{task_id}', method: 'GET', statusPath: 'status', successValues: ['completed'], failureValues: ['failed', 'cancelled'], result: { imageUrlPaths: ['result.data.*.url'], b64JsonPaths: ['result.data.*.b64_json'] } },
}

function matchPath(template, path) {
  const pattern = String(template || '').replace(/^\/+/, '').replace(/^v1\//, '').split(/\{task_id\}|\{taskId\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([^/]+)')
  return new RegExp(`^${pattern}$`).exec(path)
}

export function resolveRelayContract(req, channel, endpointPath, config) {
  const path = endpointPath.replace(/\/+$/, '')
  if (/[\\?#]|%2e|%2f|%5c|(?:^|\/)\.{1,2}(?:\/|$)/i.test(path)) throw new HttpError(400, '上游接口路径无效')
  if (channel.provider === 'fal') {
    let target
    try { target = new URL(String(req.headers['x-fal-target-url'] || '')) } catch { throw new HttpError(400, 'fal 目标地址无效') }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new HttpError(400, 'fal 目标地址无效')
    const targetPath = target.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
    const model = channel.model.replace(/^\/+|\/+$/g, '')
    const match = new RegExp(`^${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/edit)?/requests/([^/]+)(?:/(status|cancel))?$`).exec(targetPath)
    if (match && (req.method === 'GET' && match[2] !== 'cancel' || ['PUT', 'POST'].includes(req.method) && match[2] === 'cancel')) return { submit: false, taskId: decodeURIComponent(match[1]), fal: true }
    // fal 的队列查询通常省略模型子路径，仅保留命名空间和模型名。
    const shortModel = model.split('/').slice(0, 2).join('/')
    const shortMatch = new RegExp(`^${shortModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/requests/([^/]+)(?:/(status|cancel))?$`).exec(targetPath)
    if (shortMatch && (req.method === 'GET' && shortMatch[2] !== 'cancel' || ['PUT', 'POST'].includes(req.method) && shortMatch[2] === 'cancel')) return { submit: false, taskId: decodeURIComponent(shortMatch[1]), fal: true }
    if (req.method === 'POST' && [model, `${model}/edit`].includes(targetPath)) return { submit: true, fal: true }
    throw new HttpError(403, '此渠道仅允许调用已配置的 fal 图片模型')
  }
  if (channel.provider === 'openai') {
    if (req.method === 'POST' && ['images/generations', 'images/edits', 'responses'].includes(path)) return { submit: true, responses: path === 'responses' }
    throw new HttpError(403, '此渠道仅允许调用图片生成或 Responses 接口')
  }
  const configured = channel.provider === 'sb2api-async' ? SUB2API_DEFINITION : config.customProviders.find((item) => item.id === channel.provider)
  if (!configured) throw new HttpError(400, '自定义服务商配置不存在')
  const definition = { ...configured, ...(configured.poll ? { poll: {
    ...configured.poll,
    method: configured.poll.method || 'GET',
    statusPath: configured.poll.statusPath || 'status',
    successValues: configured.poll.successValues || ['SUCCESS', 'succeeded', 'completed', 'COMPLETED'],
    failureValues: configured.poll.failureValues || ['FAILURE', 'failed', 'cancelled', 'canceled'],
    result: configured.poll.result || { imageUrlPaths: ['data.*.url'], b64JsonPaths: ['data.*.b64_json'] },
  } } : {}) }
  for (const mapping of [definition.submit, definition.editSubmit]) {
    if (mapping && req.method === (mapping.method || 'POST') && matchPath(mapping.path, path)) {
      if (mapping.taskIdPath && !definition.poll) throw new HttpError(400, '异步服务商尚未配置查询接口')
      return { submit: true, mapping, definition }
    }
  }
  const poll = definition.poll
  const match = poll && matchPath(poll.path, path)
  if (match && req.method === (poll.method || 'GET')) return { submit: false, taskId: match[1] ? decodeURIComponent(match[1]) : '', definition }
  throw new HttpError(403, '接口或请求方法不在管理员配置范围内')
}

export function validateRelayModel(fields, channel, mapping) {
  if (fields.model != null && fields.model !== channel.model) throw new HttpError(403, '请求模型与当前渠道配置不一致')
  let count = imageCountFromFields(fields)
  const visit = (template, actual) => {
    for (const [key, value] of Object.entries(template || {})) {
      if (value === '$profile.model' && actual?.[key] !== channel.model) throw new HttpError(403, '请求模型与当前渠道配置不一致')
      if (value === '$params.n') count = Math.max(count, imageCountFromFields({ n: actual?.[key] }))
      if (value && typeof value === 'object' && !Array.isArray(value)) visit(value, actual?.[key])
      if ((typeof value !== 'string' || !value.startsWith('$')) && (value == null || typeof value !== 'object') && String(actual?.[key]) !== String(value)) throw new HttpError(403, '请求参数与管理员配置不一致')
    }
  }
  if (mapping?.body) visit(mapping.body, fields)
  return count
}
