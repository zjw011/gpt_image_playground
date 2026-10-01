import { callImageApi } from './api'
import type { CallApiOptions, CallApiResult } from './imageApiShared'

type ImageApiCaller = (options: CallApiOptions) => Promise<CallApiResult>

export interface LiveFrameProgress {
  completed: number
  total: number
  image: string
}

/**
 * Live 渠道普遍只稳定支持单次返回一张图。
 * 每一帧都等待上一帧完成，再把上一帧作为下一次图生图输入，避免并发帧互不认识而产生跳变。
 */
export async function generateLiveFrameSequence(
  options: CallApiOptions,
  frameCount: number,
  onFrame?: (progress: LiveFrameProgress) => void,
  caller: ImageApiCaller = callImageApi,
): Promise<CallApiResult> {
  const total = Math.max(1, Math.min(12, Math.trunc(frameCount)))
  const images: string[] = []
  const actualParamsList: Array<CallApiResult['actualParams']> = []
  const revisedPrompts: Array<string | undefined> = []
  const rawImageUrls: string[] = []
  const failedRequests: NonNullable<CallApiResult['failedRequests']> = []
  let previousInputs = options.inputImageDataUrls
  let actualParams: CallApiResult['actualParams']

  for (let idx = 0; idx < total; idx += 1) {
    try {
      const result = await caller({
        ...options,
        prompt: `${options.prompt}。这是连续序列第 ${idx + 1}/${total} 帧，只在上一帧基础上推进极小一步，保持动作连续、主体稳定，禁止突然跳变。`,
        params: { ...options.params, n: 1 },
        inputImageDataUrls: previousInputs,
        onPartialImage: options.onPartialImage
          ? (partial) => options.onPartialImage?.({ ...partial, requestIndex: idx })
          : undefined,
      })
      const image = result.images[0]
      if (!image) throw new Error('渠道没有返回图片')

      images.push(image)
      actualParams = result.actualParams ?? actualParams
      actualParamsList.push(result.actualParamsList?.[0] ?? result.actualParams)
      revisedPrompts.push(result.revisedPrompts?.[0])
      if (result.rawImageUrls?.[0]) rawImageUrls.push(result.rawImageUrls[0])
      previousInputs = [image]
      onFrame?.({ completed: images.length, total, image })
    } catch (err) {
      if (images.length === 0) throw err
      failedRequests.push({
        requestIndex: idx,
        error: `第 ${idx + 1} 帧生成失败：${err instanceof Error ? err.message : String(err)}`,
      })
      break
    }
  }

  return {
    images,
    actualParams,
    actualParamsList,
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
    ...(failedRequests.length ? { failedRequests } : {}),
  }
}
