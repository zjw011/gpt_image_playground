export const IMAGE_SIZE_ERROR_MESSAGE = '参考图片过大，超出了当前绘图服务的大小限制。请缩小或压缩图片，也可减少参考图数量后重试。'

/** 只识别明确的文件或请求大小限制，不能把输出尺寸参数错误当作上传体积错误。 */
export function isImageSizeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*[:=]?\s*413|(?:status|statusCode)["']?\s*[:=]\s*["']?413)\b|^\s*413\b/i.test(message)
    || /\b(?:file|image|payload|request(?:\s+(?:body|entity))?|entity|content)[ _-]*(?:size[ _-]*)?(?:is[ _-]*)?too[ _-]*(?:large|big)\b/i.test(message)
    || /\b(?:file|image|payload|request(?:\s+body)?|content)[ _-]+size\b[^\n]{0,60}\b(?:exceed(?:s|ed)?|larger than|greater than|must be (?:less|smaller) than)\b/i.test(message)
    || /(?:参考图片|参考图(?!片)|上传图片|图片文件|文件|图片|请求体|请求内容|请求数据|请求负载)(?!的?(?:尺寸|宽度|高度|像素))[^\n：:。]{0,24}(?:过大|太大|超过.{0,12}(?:大小|限制|上限)|大小.{0,12}(?:超出|超过))/i.test(message)
}

export function getTaskFailureHint(error: unknown): string {
  if (isImageSizeError(error)) return IMAGE_SIZE_ERROR_MESSAGE
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/insufficient[_\s-]*(account[_\s-]*)?balance|余额不足|欠费/i.test(message)) {
    return '绘图服务暂时不可用，请稍后重试或联系管理员。'
  }
  if (/尺寸|\bsize\b|宽.?高|width.?height/i.test(message)) {
    return '绘图服务不接受当前尺寸参数。请返回创作页选择标准 1:1 尺寸后再试。'
  }
  return '暂时未能完成生成，请稍后重试；如果多次失败，请联系管理员。'
}
