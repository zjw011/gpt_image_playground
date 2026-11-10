import { getActiveApiProfile, getCustomProviderDefinition } from './apiProfiles'
import { callFalAiImageApi } from './falAiImageApi'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import type { CallApiOptions, CallApiResult } from './imageApiShared'
import { prepareReferenceImages } from './referenceImages'
import { inspectNativeGif, normalizeNativeGifParams, supportsNativeGif } from './nativeGif'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './devProxy'

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const profile = getActiveApiProfile(opts.settings)
  const nativeGif = opts.params.output_format === 'gif'
  if (nativeGif) {
    if (!supportsNativeGif(profile)) throw Object.assign(new Error('当前渠道不支持原生 GIF 动图，请选择支持动图的渠道'), { retryable: false })
    if (opts.maskDataUrl) throw Object.assign(new Error('原生 GIF 暂不支持遮罩编辑'), { retryable: false })
    if (opts.inputImageDataUrls.length > 1 || opts.inputImageDataUrls.some((image) => !/^data:image\/(?:png|jpeg|webp);base64,/i.test(image))) {
      throw Object.assign(new Error('原生 GIF 最多支持一张 PNG、JPEG 或 WebP 参考图'), { retryable: false })
    }
    opts = { ...opts, params: normalizeNativeGifParams(opts.params), nativeTransparentBackground: false, onPartialImage: undefined }
  }
  // 原图仍保存在作品里；历史重试、换装双图与 Live 后续帧也统一优化上传副本。
  opts = { ...opts, inputImageDataUrls: await prepareReferenceImages(opts.inputImageDataUrls, opts.maskDataUrl) }
  if (profile.provider === 'fal') return callFalAiImageApi(opts, profile)

  const result = await callOpenAICompatibleImageApi(opts, nativeGif ? { ...profile, codexCli: false, streamImages: false, responseFormatB64Json: false } : profile, getCustomProviderDefinition(opts.settings, profile.provider))
  if (!nativeGif) return result
  const actualParamsList = result.images.map((image, index) => {
    const info = inspectNativeGif(image)
    return { ...result.actualParams, ...result.actualParamsList?.[index], output_format: 'gif' as const, size: `${info.width}x${info.height}`, frame_count: info.frameCount }
  })
  return {
    ...result,
    // 部分兼容服务误标 MIME，只修正前缀，保留原始 GIF 的所有字节。
    images: result.images.map((image) => image.replace(/^data:[^,]*;base64,/i, 'data:image/gif;base64,')),
    actualParams: actualParamsList[0],
    actualParamsList,
  }
}
