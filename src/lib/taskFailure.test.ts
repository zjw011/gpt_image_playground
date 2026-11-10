import { describe, expect, it } from 'vitest'
import { getTaskFailureHint, IMAGE_SIZE_ERROR_MESSAGE, isImageDownloadError, isImageSizeError } from './taskFailure'

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

describe('生成失败处理建议', () => {
  it.each([
    'HTTP 403: {"error":{"code":"content_policy_violation","message":"Request rejected"}}',
    '已尝试 2 个渠道，全部失败：私有渠道A：safety rejected',
    '内容安全审核未通过：请求已取消',
  ])('审核拒绝优先提示修改内容，不把错误归给渠道：%s', (message) => {
    const hint = getTaskFailureHint(message)
    expect(hint).toContain('未通过绘图服务的安全审核')
    expect(hint).toContain('请修改描述或更换参考图')
    expect(hint).not.toContain('私有渠道')
    expect(hint).not.toContain('请稍后重试')
  })

  it('仅取消状态不推断为成人内容或审核拦截', () => {
    const hint = getTaskFailureHint('upstream request cancelled')
    expect(hint).toContain('未提供明确原因')
    expect(hint).not.toContain('成人')
    expect(hint).not.toContain('未通过')
  })

  it('超时提示避免重复提交，不断言上游已经失败', () => {
    expect(getTaskFailureHint('上游请求超时')).toContain('无法确认上游是否仍在处理')
    expect(getTaskFailureHint('ETIMEDOUT')).toContain('避免连续重复提交')
  })

  it.each([
    '图片结果下载失败：HTTP 403',
    '图片 URL 下载失败：HTTP 404',
    '图片链接下载失败（可能因跨域限制、链接过期或网络异常）',
    '图片已生成，但因服务商未允许跨域，图片链接下载失败。',
  ])('新旧取图错误都不冒称生成成功或确定跨域原因：%s', (message) => {
    expect(isImageDownloadError(message)).toBe(true)
    expect(getTaskFailureHint(message)).toContain('暂时无法确认生成结果')
    expect(getTaskFailureHint(message)).not.toContain('图片已生成')
    expect(getTaskFailureHint(message)).not.toContain('Base64')
  })
})
