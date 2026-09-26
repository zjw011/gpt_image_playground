// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '../../types'
import ResultPage from './ResultPage'

const state = vi.hoisted(() => ({ tasks: [] as TaskRecord[] }))
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
  useFullImage: () => null,
  useThumbnail: () => null,
}))

vi.mock('../../lib/creditsStore', () => ({
  useCreditsStore: () => null,
}))

vi.mock('../../lib/backend', () => ({
  isBackendMode: () => false,
  getBackendUser: () => null,
}))

vi.mock('../../lib/db', () => ({ getImage: vi.fn() }))
vi.mock('../../lib/galleryApi', () => ({ publishWork: vi.fn() }))

describe('ResultPage', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    state.tasks = []
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
})
