// 作品广场 API。浏览公开；发布/点赞/删除需要登录账号。

export interface GalleryItem {
  id: string
  title: string
  caption: string
  prompt: string
  model: string
  ownerName: string
  ownerId: string
  likes: number
  comments: number
  likedByMe: boolean
  createdAt: number
  imageUrl: string
}

export interface GalleryComment {
  id: string
  workId: string
  userName: string
  text: string
  createdAt: number
  canDelete: boolean
  reportedByMe: boolean
}

export function listGalleryWorks() {
  return request<{ items: GalleryItem[] }>('/api/gallery')
}

/** image 传 dataURL（前端从 IndexedDB 读原图得到）。 */
export function publishWork(body: { image: string, title: string, caption: string, prompt: string, model: string }) {
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

export function listWorkComments(id: string, offset = 0, limit = 20) {
  return request<{ total: number, offset: number, limit: number, comments: GalleryComment[] }>(
    `/api/gallery/${encodeURIComponent(id)}/comments?offset=${offset}&limit=${limit}`,
  )
}

export function createWorkComment(id: string, text: string) {
  return request<{ ok: true, comment: GalleryComment, total: number }>(`/api/gallery/${encodeURIComponent(id)}/comments`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

export function deleteWorkComment(workId: string, commentId: string) {
  return request<{ ok: true, total: number }>(`/api/gallery/${encodeURIComponent(workId)}/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' })
}

export function reportWorkComment(workId: string, commentId: string) {
  return request<{ ok: true, duplicated: boolean }>(`/api/gallery/${encodeURIComponent(workId)}/comments/${encodeURIComponent(commentId)}/report`, { method: 'POST' })
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
