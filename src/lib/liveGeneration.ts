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
  const anchorInputs = [...(options.inputImageDataUrls ?? [])]
  let previousInputs = anchorInputs
  let actualParams: CallApiResult['actualParams']

  for (let idx = 0; idx < total; idx += 1) {
    try {
      const result = await caller({
        ...options,
        prompt: `${options.prompt}。这是连续序列第 ${idx + 1}/${total} 帧。第一张参考图是全程固定的主体、构图与曝光锚点，最后一张参考图是上一帧；只允许在上一帧基础上推进极小一步。逐帧锁定曝光、白平衡、色温、亮度、对比度、饱和度、景深、噪点与清晰度，禁止忽明忽暗、闪烁、突然跳变和整体重绘。`,
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
      previousInputs = anchorInputs.length ? [...anchorInputs, image] : [image]
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
