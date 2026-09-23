// 作品广场 API。浏览公开；发布/点赞/删除需要登录账号。

export interface GalleryItem {
  id: string
  prompt: string
  model: string
  ownerName: string
  ownerId: string
  likes: number
  likedByMe: boolean
  createdAt: number
  imageUrl: string
}

export function listGalleryWorks() {
  return request<{ items: GalleryItem[] }>('/api/gallery')
}

/** image 传 dataURL（前端从 IndexedDB 读原图得到）。 */
export function publishWork(body: { image: string, prompt: string, model: string }) {
  return request<{ ok: true, item: GalleryItem, duplicated: boolean }>('/api/gallery', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function toggleWorkLike(id: string) {
  return request<{ ok: true, liked: boolean, likes: number }>(`/api/gallery/${encodeURIComponent(id)}/like`, { method: 'POST' })
}

export function deleteWork(id: string) {
  return request<{ ok: true }>(`/api/gallery/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((payload as { error?: string }).error || `HTTP ${response.status}`)
  return payload as T
}
