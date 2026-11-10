import { classifyGenerationError } from './generationError.mjs'

export const IMAGE_SIZE_ERROR_MESSAGE = '参考图片过大，超出了当前绘图服务的大小限制。请缩小或压缩图片，也可减少参考图数量后重试。'

/** 只识别明确的文件或请求大小限制，不能把输出尺寸参数错误当作上传体积错误。 */
export function isImageSizeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*[:=]?\s*413|(?:status|statusCode)["']?\s*[:=]\s*["']?413)\b|^\s*413\b/i.test(message)
    || /\b(?:file|image|payload|request(?:\s+(?:body|entity))?|entity|content)[ _-]*(?:size[ _-]*)?(?:is[ _-]*)?too[ _-]*(?:large|big)\b/i.test(message)
    || /\b(?:file|image|payload|request(?:\s+body)?|content)[ _-]+size\b[^\n]{0,60}\b(?:exceed(?:s|ed)?|larger than|greater than|must be (?:less|smaller) than)\b/i.test(message)
    || /(?:参考图片|参考图(?!片)|上传图片|图片文件|文件|图片|请求体|请求内容|请求数据|请求负载)(?!的?(?:尺寸|宽度|高度|像素))[^\n：:。]{0,24}(?:过大|太大|超过.{0,12}(?:大小|限制|上限)|大小.{0,12}(?:超出|超过))/i.test(message)
}

export function isImageDownloadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /图片(?:结果|链接|\s*URL\s*)?下载失败|图片链接未返回有效图片|图片链接返回的不是图片|图片已生成，但因服务商未允许跨域/i.test(message)
}

export function getTaskFailureHint(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/图片已生成，但保存到浏览器失败/.test(message)) return '图片已生成，但未能保存到当前浏览器。请检查设备剩余空间和浏览器存储权限；系统已停止自动重试，避免重复生图。'
  const kind = classifyGenerationError(error)
  if (kind === 'content_policy') return '本次内容未通过绘图服务的安全审核，可能涉及成人、裸露或其他受限内容。请修改描述或更换参考图后再试。'
  if (/原生 GIF 结果无效/.test(message)) return '绘图服务未返回有效的多帧 GIF，系统已停止自动重试，避免重复生成。请联系管理员检查动图渠道。'
  if (isImageSizeError(error)) return IMAGE_SIZE_ERROR_MESSAGE
  if (kind === 'cancelled') return '上游已取消本次生成，但未提供明确原因。请稍后重试；仅凭取消状态无法判断是否涉及内容限制。'
  if (isImageDownloadError(error)) return '未能取回有效图片，暂时无法确认生成结果。可能是图片链接失效、访问限制或网络异常，请稍后重试或联系管理员。'
  if (kind === 'timeout') return '等待生成结果超时，暂时无法确认上游是否仍在处理。请稍后查看结果，避免连续重复提交。'
  if (/insufficient[_\s-]*(account[_\s-]*)?balance|余额不足|欠费/i.test(message)) {
    return '绘图服务暂时不可用，请稍后重试或联系管理员。'
  }
  if (/尺寸|\bsize\b|宽.?高|width.?height/i.test(message)) {
    return '绘图服务不接受当前尺寸参数。请返回创作页选择标准 1:1 尺寸后再试。'
  }
  return '暂时未能完成生成，请稍后重试；如果多次失败，请联系管理员。'
}
