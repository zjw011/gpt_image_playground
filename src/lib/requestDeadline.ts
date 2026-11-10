// 小型站内 JSON 接口需要覆盖正文读取的期限，避免响应头到了但页面永远转圈。
// 生图和下载继续使用各自的长任务超时，不经过这里。
export async function fetchWithDeadline(input: RequestInfo | URL, options: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('请求超时，请稍后重试')), timeoutMs)
  try {
    const response = await fetch(input, { ...options, signal: controller.signal })
    const body = await response.arrayBuffer()
    return new Response(response.status === 204 || response.status === 205 || response.status === 304 ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason ?? error
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
