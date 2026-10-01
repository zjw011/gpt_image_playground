// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GalleryComment } from '../../lib/galleryApi'
import GalleryPage from './GalleryPage'

const state = vi.hoisted(() => ({
  showToast: vi.fn(),
  listWorkComments: vi.fn(),
}))
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../store', () => ({
  useStore: (selector: (value: unknown) => unknown) => selector({ showToast: state.showToast, setPrompt: vi.fn(), setConfirmDialog: vi.fn() }),
}))
vi.mock('./AppShell', () => ({ default: ({ children }: { children: ReactNode }) => <main>{children}</main> }))
vi.mock('../../lib/backend', () => ({ isBackendMode: () => true, getBackendUser: () => null }))
vi.mock('../../lib/galleryApi', () => ({
  listGalleryWorks: async () => ({ items: ['a', 'b'].map((id, idx) => ({ id, title: `作品 ${id}`, caption: '', prompt: id, model: '', ownerName: '作者', ownerAvatar: '', ownerId: 'owner', likes: 0, comments: 2, likedByMe: false, createdAt: 2 - idx, imageUrl: `/${id}.png` })) }),
  listWorkComments: state.listWorkComments,
  createWorkComment: vi.fn(),
  deleteWorkComment: vi.fn(),
  deleteWork: vi.fn(),
  reportWorkComment: vi.fn(),
  toggleWorkLike: vi.fn(),
}))

describe('GalleryPage 帖子切换', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    state.listWorkComments.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('旧帖子分页响应不能混入新帖子，关闭后恢复滚动', async () => {
    let resolveMore!: (value: { comments: GalleryComment[], total: number }) => void
    const more = new Promise<{ comments: GalleryComment[], total: number }>((resolve) => { resolveMore = resolve })
    const comment = (workId: string, text: string): GalleryComment => ({ id: text, workId, text, userName: '评论者', userAvatar: '', createdAt: 1, canDelete: false, reportedByMe: false })
    state.listWorkComments.mockImplementation((id: string, offset = 0) => offset > 0 ? more : Promise.resolve({ total: 2, comments: [comment(id, `${id} 首条评论`)] }))
    await act(async () => root.render(<MemoryRouter><GalleryPage /></MemoryRouter>))
    const cards = container.querySelectorAll('main article')
    await act(async () => (cards[0].querySelector('button') as HTMLButtonElement).click())
    expect(document.body.style.overflow).toBe('hidden')
    const loadMore = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === '加载更多')
    await act(async () => loadMore?.click())
    await act(async () => (container.querySelector('[aria-label="关闭帖子"]') as HTMLButtonElement).click())
    await act(async () => (cards[1].querySelector('button') as HTMLButtonElement).click())
    expect(container.textContent).toContain('b 首条评论')
    await act(async () => resolveMore({ total: 2, comments: [comment('a', 'a 延迟返回的评论')] }))
    expect(container.textContent).not.toContain('a 延迟返回的评论')
    expect(container.textContent).toContain('b 首条评论')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(container.querySelector('[aria-label="作品帖子"]')).toBeNull()
    expect(document.body.style.overflow).not.toBe('hidden')
  })
})
