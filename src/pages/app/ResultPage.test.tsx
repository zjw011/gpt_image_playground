// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '../../types'
import ResultPage from './ResultPage'

const state = vi.hoisted(() => ({
  tasks: [] as TaskRecord[],
  backend: false,
  user: null as { id: string } | null,
  fullSrc: null as string | null,
  getImage: vi.fn(),
  publishWork: vi.fn(),
}))
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../store', () => ({
  useStore: (selector: (value: unknown) => unknown) => selector({
    tasks: state.tasks,
    showToast: vi.fn(),
    setConfirmDialog: vi.fn(),
    openFavoritePicker: vi.fn(),
  }),
  submitTask: vi.fn(),
  reuseConfig: vi.fn(),
  removeTask: vi.fn(),
}))

vi.mock('./AppShell', () => ({
  default: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}))

vi.mock('./useTaskImage', () => ({
  useFullImage: () => state.fullSrc,
  useThumbnail: () => null,
}))

vi.mock('../../lib/creditsStore', () => ({
  useCreditsStore: () => null,
}))

vi.mock('../../lib/backend', () => ({
  isBackendMode: () => state.backend,
  getBackendUser: () => state.user,
}))

vi.mock('../../lib/db', () => ({ getImage: state.getImage }))
vi.mock('../../lib/galleryApi', () => ({ publishWork: state.publishWork }))

describe('ResultPage', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    state.tasks = []
    state.backend = false
    state.user = null
    state.fullSrc = null
    state.getImage.mockReset()
    state.publishWork.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('刷新后任务从持久化存储恢复时保持 Hook 调用顺序稳定', async () => {
    const renderPage = () => (
      <MemoryRouter initialEntries={['/result']}>
        <ResultPage />
      </MemoryRouter>
    )

    await act(async () => root.render(renderPage()))
    expect(container.textContent).toContain('还没有作品')

    state.tasks = [{
      id: 'restored-task',
      prompt: '恢复中的作品',
      params: {
        size: '1024x1024',
        quality: 'auto',
        output_format: 'png',
        output_compression: null,
        moderation: 'auto',
        n: 1,
        transparent_output: false,
      },
      inputImageIds: [],
      outputImages: [],
      status: 'running',
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      elapsed: null,
    }]

    await act(async () => root.render(renderPage()))
    expect(container.textContent).toContain('正在绘制你的想象')
  })

  it('发布广场前先编辑帖子标题和正文', async () => {
    state.backend = true
    state.user = { id: 'u-1' }
    state.fullSrc = 'data:image/png;base64,preview'
    state.tasks = [{
      id: 'done-task',
      prompt: '月光下的雪山',
      params: {
        size: '1024x1024',
        quality: 'auto',
        output_format: 'png',
        output_compression: null,
        moderation: 'auto',
        n: 1,
        transparent_output: false,
      },
      inputImageIds: [],
      outputImages: ['img-1'],
      status: 'done',
      error: null,
      createdAt: Date.now(),
      finishedAt: Date.now(),
      elapsed: 1,
      apiModel: 'image-2',
    }]

    await act(async () => root.render(
      <MemoryRouter initialEntries={['/result']}>
        <ResultPage />
      </MemoryRouter>,
    ))
    const publishButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('发布帖子'))
    expect(publishButton).toBeTruthy()

    await act(async () => publishButton?.click())

    expect(container.textContent).toContain('帖子标题')
    expect(container.textContent).toContain('提示词会收进帖子的「查看提示词」中')
    expect(container.querySelector('#gallery-post-title')).toBeTruthy()
    expect(container.querySelector('#gallery-post-caption')).toBeTruthy()
    expect(document.body.style.overflow).toBe('hidden')
    expect(container.querySelector('[role="dialog"]')?.className).toContain('overflow-y-auto')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(container.querySelector('#gallery-post-title')).toBeNull()
    expect(document.body.style.overflow).not.toBe('hidden')
  })
})
