import { describe, expect, it } from 'vitest'
import { getTaskFailureHint, IMAGE_SIZE_ERROR_MESSAGE, isImageSizeError } from './taskFailure'

describe('isImageSizeError', () => {
  it.each([
    'HTTP 400: {"error":{"message":"invalid request: file too large","type":"invalid_request_error"}}',
    'image is too large',
    'payload_too_large',
    'Request Entity Too Large',
    'request body too large',
    'file size exceeds the maximum allowed limit',
    'image size must be less than 4 MB',
    'HTTP 413',
    'HTTP/1.1 413 Request Entity Too Large',
    '{"statusCode":413,"message":"upstream rejected request"}',
    '输入图片 1 过大：最多 50MB',
    '参考图片大小超过服务限制',
    '请求体超过大小限制',
    '已尝试 2 个渠道，全部失败：\n1. 私有渠道A：file too large\n2. 私有渠道B：file too large',
  ])('识别明确的大小限制：%s', (message) => {
    expect(isImageSizeError(message)).toBe(true)
    expect(isImageSizeError(new Error(message))).toBe(true)
    expect(getTaskFailureHint(message)).toBe(IMAGE_SIZE_ERROR_MESSAGE)
  })

  it.each([
    'HTTP 400: size must be 1024x1024',
    'image dimensions too large: width must be less than 4096',
    '图片尺寸过大',
    '参考图片的尺寸过大',
    'invalid output size',
    '任务 4130 网络错误',
    'file not found',
    'maximum context length exceeded',
    'insufficient account balance',
    '',
    null,
  ])('不把其他失败归为参考图过大：%s', (message) => {
    expect(isImageSizeError(message)).toBe(false)
  })

  it('尺寸错误仍提示输出比例，不泄漏渠道诊断信息', () => {
    expect(getTaskFailureHint('渠道机密ABC：invalid output size')).toContain('标准 1:1 尺寸')
    expect(getTaskFailureHint('渠道机密ABC：insufficient account balance')).toBe('绘图服务暂时不可用，请稍后重试或联系管理员。')
    expect(getTaskFailureHint('渠道机密ABC：internal error')).not.toContain('渠道机密ABC')
  })
})
