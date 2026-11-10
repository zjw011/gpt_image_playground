import { createFalClient } from '@fal-ai/client'
import type { ApiProfile, FalApiResponse, TaskParams } from '../types'
import { DEFAULT_FAL_BASE_URL } from './apiProfiles'
import { classifyGenerationError, getGenerationResponseError } from './generationError.mjs'
import {
  assertImageInputPayloadSize,
  assertMaskEditFileSize,
  type CallApiOptions,
  type CallApiResult,
  fetchImageUrlAsDataUrl,
  getApiResponseError,
  getDataUrlDecodedByteSize,
  getDataUrlEncodedByteSize,
  isDataUrl,
  isHttpUrl,
  mergeActualParams,
  MIME_MAP,
  normalizeBase64Image,
} from './imageApiShared'

const DEFAULT_FAL_IMAGE_SIZE = { width: 1360, height: 1024 }

function mapFalEndpoint(model: string, isEdit: boolean): string {
  const normalized = model.trim().replace(/^\/+/, '').replace(/\/+$/, '') || 'openai/gpt-image-2'
  return isEdit && !normalized.endsWith('/edit') ? `${normalized}/edit` : normalized
}

async function mapFalImageSize(size: string): Promise<{ width: number; height: number }> {
  const match = size.match(/^(\d+)x(\d+)$/)
  if (match) {
    return { width: Number(match[1]), height: Number(match[2]) }
  }

  return DEFAULT_FAL_IMAGE_SIZE
}

function mapFalQuality(quality: TaskParams['quality']): 'low' | 'medium' | 'high' {
  return quality === 'auto' ? 'high' : quality
}

function createProfileFalClient(profile: ApiProfile, clientFailover = false, onEnqueue?: (requestId: string) => void) {
  const baseUrl = profile.baseUrl.trim().replace(/\/+$/, '') || DEFAULT_FAL_BASE_URL
  const config: NonNullable<Parameters<typeof createFalClient>[0]> = {
    credentials: profile.apiKey,
    suppressLocalCredentialsWarning: true,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers)
      if (clientFailover && baseUrl.includes('/api/relay/')) headers.set('X-GIP-Failover', 'client')
      const response = await fetch(input, { ...init, headers })
      const method = (init?.method ?? 'GET').toUpperCase()
      if (!response.ok) {
        const error = await getApiResponseError(response.clone())
        // SDK 的 queue.submit 会覆盖 retry 配置；普通 Error 阻止内部重复创建收费任务。
        if (method !== 'GET' || ('retryable' in error && error.retryable === false) || classifyGenerationError(error)) throw error
      } else if (method !== 'GET' || /\/status(?:\?|$)/.test(headers.get('x-fal-target-url') ?? String(input))) {
        // 提交/状态接口的 HTTP 200 也可能是错误，不能带着空 ID 无限查询。
        if (response.headers.get('content-type')?.includes('application/json')) {
          const payload = await response.clone().json()
          const failure = getGenerationResponseError(payload)
          if (failure) {
            const requestId = method !== 'GET' && typeof payload?.request_id === 'string' ? payload.request_id.trim() : ''
            // 已受理的任务即使同时带错也要先保存 ID，不能把它当作提交失败再次收费生图。
            if (requestId) onEnqueue?.(requestId)
            throw Object.assign(new Error(failure), requestId ? { retryable: false } : {})
          }
        }
      }
      return response
    },
  }
  if (baseUrl !== DEFAULT_FAL_BASE_URL) config.proxyUrl = baseUrl
  return createFalClient(config)
}

async function createFalRequestInput(opts: CallApiOptions): Promise<Record<string, unknown>> {
  const isEdit = opts.inputImageDataUrls.length > 0
  const input: Record<string, unknown> = {
    prompt: opts.prompt,
    image_size: isEdit && opts.params.size === 'auto' ? 'auto' : await mapFalImageSize(opts.params.size),
    quality: mapFalQuality(opts.params.quality),
    num_images: Math.min(4, Math.max(1, opts.params.n || 1)),
    output_format: opts.params.output_format,
  }

  if (isEdit) {
    input.image_urls = opts.inputImageDataUrls
  }

  if (opts.maskDataUrl) {
    input.mask_url = opts.maskDataUrl
  }

  return input
}

function readFalImageValue(value: unknown, fallbackMime: string): string | null {
  if (typeof value === 'string') {
    if (isHttpUrl(value) || isDataUrl(value)) return value
    return normalizeBase64Image(value, fallbackMime)
  }
  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  if (isHttpUrl(record.url) || isDataUrl(record.url)) return record.url
  if (typeof record.b64_json === 'string') return normalizeBase64Image(record.b64_json, fallbackMime)
  if (typeof record.base64 === 'string') return normalizeBase64Image(record.base64, fallbackMime)
  if (typeof record.data === 'string') return normalizeBase64Image(record.data, fallbackMime)
  return null
}

function readFalImageSize(value: unknown): Partial<TaskParams> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const width = typeof record.width === 'number' ? record.width : null
  const height = typeof record.height === 'number' ? record.height : null
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) return undefined
  return { size: `${Math.round(width)}x${Math.round(height)}` }
}

async function parseFalImageResults(payload: FalApiResponse, fallbackMime: string, customBaseUrlLabel: string | null, signal?: AbortSignal) {
  const payloadError = getGenerationResponseError(payload)
  const candidates: unknown[] = []
  if (Array.isArray(payload.images)) candidates.push(...payload.images)
  if (payload.image) candidates.push(payload.image)
  if (payload.url) candidates.push(payload.url)

  const results: Array<{ image: string; actualParams?: Partial<TaskParams>; rawImageUrl?: string }> = []
  const rawImageUrls: string[] = []
  const errors: Error[] = []
  const failedRequests: NonNullable<CallApiResult['failedRequests']> = []
  for (const [requestIndex, candidate] of candidates.entries()) {
    try {
      const failure = getGenerationResponseError(candidate)
      if (failure) throw new Error(failure)
      const value = readFalImageValue(candidate, fallbackMime)
      if (!value) throw new Error('fal.ai 未返回可识别的图片数据')
      if (isHttpUrl(value)) rawImageUrls.push(value)
      results.push({
        image: isHttpUrl(value) ? await fetchImageUrlAsDataUrl(value, fallbackMime, signal) : value,
        actualParams: readFalImageSize(candidate),
        rawImageUrl: isHttpUrl(value) ? value : undefined,
      })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      errors.push(error)
      failedRequests.push({ requestIndex, error: error.message })
    }
  }
  if (payloadError && !failedRequests.some((item) => item.error === payloadError)) {
    errors.push(new Error(payloadError))
    failedRequests.push({ requestIndex: candidates.length, error: payloadError })
  }

  if (!results.length) {
    const err = errors.find((error) => classifyGenerationError(error) === 'content_policy')
      ?? errors.find((error) => classifyGenerationError(error) === 'cancelled')
      ?? errors[0] ?? new Error(
      customBaseUrlLabel
        ? `${customBaseUrlLabel} 没有返回可识别的图片数据，请查看原始响应内容确认实际返回的数据结构。如果当前接口与 fal.ai 格式不兼容，建议创建并使用「自定义服务商」配置。`
        : 'fal.ai 未返回可用图片数据',
    )
    if (rawImageUrls.length) (err as Error & { rawImageUrls?: string[] }).rawImageUrls = rawImageUrls
    ;(err as Error & { rawResponsePayload?: string }).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }
  return { results, rawImageUrls, failedRequests }
}

async function parseFalResult(payload: FalApiResponse, params: TaskParams, customBaseUrlLabel: string | null, signal?: AbortSignal): Promise<CallApiResult> {
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const parsed = await parseFalImageResults(payload, mime, customBaseUrlLabel, signal)
  const imageResults = parsed.results
  const actualParams = mergeActualParams(imageResults[0]?.actualParams)
  return {
    images: imageResults.map((result) => result.image),
    actualParams,
    actualParamsList: imageResults.map((result) => result.actualParams),
    revisedPrompts: imageResults.map(() => undefined),
    ...(parsed.rawImageUrls.length ? { rawImageUrls: parsed.rawImageUrls } : {}),
    ...(parsed.failedRequests.length ? { failedRequests: parsed.failedRequests } : {}),
  }
}

export function getFalErrorMessage(err: unknown): string | null {
  const body = err && typeof err === 'object' && 'body' in err ? (err as { body?: unknown }).body : null
  if (!body || typeof body !== 'object') return null
  const payloadError = getGenerationResponseError(body)
  if (payloadError) return payloadError

  const detail = (body as Record<string, unknown>).detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>
          if (typeof record.msg === 'string' && record.msg.trim()) return record.msg
          if (typeof record.message === 'string' && record.message.trim()) return record.message
        }
        return null
      })
      .filter((message): message is string => Boolean(message))
    if (messages.length) return messages.join('\n')
  }

  const message = (body as Record<string, unknown>).message
  return typeof message === 'string' && message.trim() ? message : null
}

function getFalCustomBaseUrlLabel(profile: ApiProfile): string | null {
  const base = profile.baseUrl.trim().replace(/\/+$/, '')
  if (!base || base === DEFAULT_FAL_BASE_URL) return null
  return base.replace(/^https?:\/\//, '')
}

export async function getFalQueuedImageResult(
  profile: ApiProfile,
  endpoint: string,
  requestId: string,
  params: TaskParams,
): Promise<CallApiResult> {
  const fal = createProfileFalClient(profile)
  try {
    await fal.queue.subscribeToStatus(endpoint, { requestId, logs: true })
    const result = await fal.queue.result(endpoint, { requestId })
    return parseFalResult(result.data as FalApiResponse, params, getFalCustomBaseUrlLabel(profile))
  } catch (err) {
    const falMessage = getFalErrorMessage(err)
    if (falMessage) throw new Error(falMessage)
    throw err
  }
}

export async function callFalAiImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  try {
    if (opts.maskDataUrl) {
      assertMaskEditFileSize('遮罩主图文件', getDataUrlDecodedByteSize(opts.inputImageDataUrls[0] ?? ''))
      assertMaskEditFileSize('遮罩文件', getDataUrlDecodedByteSize(opts.maskDataUrl))
    }
    assertImageInputPayloadSize(
      opts.inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0) +
        (opts.maskDataUrl ? getDataUrlEncodedByteSize(opts.maskDataUrl) : 0),
    )

    const isEdit = opts.inputImageDataUrls.length > 0
    const endpoint = mapFalEndpoint(profile.model, isEdit)
    const input = await createFalRequestInput(opts)
    const onEnqueue = (requestId: string) => {
      if (typeof requestId !== 'string' || !requestId.trim()) {
        throw Object.assign(new Error('fal.ai 未返回有效任务 ID，暂时无法确认是否已受理，请稍后核查结果，避免重复提交。'), { retryable: false })
      }
      opts.onFalRequestEnqueued?.({ requestId, endpoint })
    }
    // 每次调用独立配置，避免并发任务或恢复查询切换了另一个任务的渠道。
    const fal = createProfileFalClient(profile, opts.clientFailover, onEnqueue)
    const result = await fal.subscribe(endpoint, {
      input,
      logs: true,
      onEnqueue,
    })
    const payload = result.data as FalApiResponse
    if (result.requestId) opts.onFalRequestEnqueued?.({ requestId: result.requestId, endpoint })
    return parseFalResult(payload, opts.params, getFalCustomBaseUrlLabel(profile))
  } catch (err) {
    const falMessage = getFalErrorMessage(err)
    if (falMessage) throw new Error(falMessage)
    throw err
  }
}
