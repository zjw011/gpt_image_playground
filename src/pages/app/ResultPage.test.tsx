// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type TaskRecord } from '../../types'
import { reuseConfig, submitTask } from '../../store'
import { exportQuickMotion } from '../../lib/quickMotion'
import { exportLiveFrames } from '../../lib/livePhoto'
import ResultPage from './ResultPage'

const state = vi.hoisted(() => ({
  tasks: [] as TaskRecord[],
  backend: false,
  user: null as { id: string } | null,
  fullSrc: null as string | null,
  getImage: vi.fn(),
  publishWork: vi.fn(),
  toast: vi.fn(),
}))
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../store', () => ({
  useStore: (selector: (value: unknown) => unknown) => selector({
    tasks: state.tasks,
    showToast: state.toast,
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
vi.mock('../../components/QuickMotionPlayer', () => ({
  default: () => <div aria-label="快速运镜预览" />,
}))
vi.mock('../../components/LivePhotoPlayer', () => ({ default: () => <div aria-label="AI 连续帧" /> }))
vi.mock('../../lib/livePhoto', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/livePhoto')>(),
  exportLiveFrames: vi.fn(),
}))
vi.mock('../../lib/quickMotion', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/quickMotion')>(),
  exportQuickMotion: vi.fn(),
}))

function Location() {
  const location = useLocation()
  return <output>{location.pathname + location.search}</output>
}

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
    state.toast.mockReset()
    vi.mocked(exportQuickMotion).mockReset()
    vi.mocked(exportLiveFrames).mockReset()
    vi.mocked(reuseConfig).mockClear()
    vi.mocked(submitTask).mockClear()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
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

  it('本地运镜显示视频操作与真实格式说明，编辑不会提交收费任务', async () => {
    state.backend = true
    state.user = { id: 'u-1' }
    state.fullSrc = 'data:image/png;base64,preview'
    state.tasks = [{ id: 'quick-task', prompt: '快速运镜', params: DEFAULT_PARAMS, inputImageIds: ['img-1'], outputImages: ['img-1'], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1, professionalPreset: 'live-quick', quickMotion: { effect: 'pan-left', duration: 1, strength: 2 } }]
    await act(async () => root.render(<MemoryRouter initialEntries={['/result?task=quick-task']}><ResultPage /><Location /></MemoryRouter>))
    expect(container.querySelector('[aria-label="快速运镜预览"]')).toBeTruthy()
    expect(container.textContent).toContain('1 秒 · 2% 幅度 · 0 积分')
    expect(container.textContent).toContain('不是苹果相册中的原生实况照片')
    expect(container.textContent).not.toContain('发布帖子')
    expect(container.textContent).not.toContain('复制提示词')
    await act(async () => Array.from(container.querySelectorAll('button')).find((el) => el.textContent === '编辑运镜')?.click())
    expect(reuseConfig).not.toHaveBeenCalled()
    expect(submitTask).not.toHaveBeenCalled()
    expect(container.querySelector('output')?.textContent).toBe('/tools?tool=live&task=quick-task')
  })

  it('下载视频使用实际编码的扩展名，并防止重复导出', async () => {
    state.fullSrc = 'data:image/png;base64,preview'
    state.tasks = [{ id: 'quick-task', prompt: '快速运镜', params: DEFAULT_PARAMS, inputImageIds: ['img-1'], outputImages: ['img-1'], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1, quickMotion: { effect: 'zoom', duration: 2, strength: 3 } }]
    let finish!: (value: { blob: Blob; extension: 'mp4' | 'webm' }) => void
    vi.mocked(exportQuickMotion).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:quick'), revokeObjectURL: vi.fn() })
    let filename = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filename = this.download })
    await act(async () => root.render(<MemoryRouter><ResultPage /></MemoryRouter>))
    const download = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === '下载视频')!
    await act(async () => download.click())
    const exporting = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === '导出中')!
    expect(exporting.disabled).toBe(true)
    await act(async () => exporting.click())
    expect(exportQuickMotion).toHaveBeenCalledTimes(1)
    await act(async () => finish({ blob: new Blob(['encoded'], { type: 'video/webm' }), extension: 'webm' }))
    expect(filename).toBe('绘想-运镜-quick-task.webm')
    expect(state.toast).toHaveBeenCalledWith('WEBM 运镜视频已导出', 'success')
  })

  it('切换任务后旧 AI 导出不下载，也不解锁新快速视频的导出按钮', async () => {
    state.fullSrc = 'data:image/png;base64,preview'
    state.getImage.mockResolvedValue({ dataUrl: state.fullSrc })
    state.tasks = [{ id: 'ai-live', prompt: 'AI 实况', params: DEFAULT_PARAMS, inputImageIds: [], outputImages: ['frame-1', 'frame-2'], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1, professionalPreset: 'live-blink' }]
    let finishAi!: (blob: Blob) => void
    let finishQuick!: (value: { blob: Blob; extension: 'mp4' | 'webm' }) => void
    vi.mocked(exportLiveFrames).mockReturnValue(new Promise((resolve) => { finishAi = resolve }))
    vi.mocked(exportQuickMotion).mockReturnValue(new Promise((resolve) => { finishQuick = resolve }))
    const renderPage = () => <MemoryRouter><ResultPage /></MemoryRouter>
    await act(async () => root.render(renderPage()))
    await act(async () => Array.from(container.querySelectorAll('button')).find((el) => el.textContent === '下载 Live')?.click())
    expect(exportLiveFrames).toHaveBeenCalledOnce()
    state.tasks = [{ ...state.tasks[0], id: 'quick-task', professionalPreset: 'live-quick', outputImages: ['frame-1'], quickMotion: { effect: 'zoom', duration: 2, strength: 3 } }]
    await act(async () => root.render(renderPage()))
    await act(async () => Array.from(container.querySelectorAll('button')).find((el) => el.textContent === '下载视频')?.click())
    const signal = vi.mocked(exportQuickMotion).mock.calls[0][2]!
    await act(async () => finishAi(new Blob(['ai-video'])))
    expect(state.toast).not.toHaveBeenCalled()
    expect(Array.from(container.querySelectorAll('button')).find((el) => el.textContent === '导出中')?.disabled).toBe(true)
    // 离开结果页取消本次导出，迟到的结果也不会再下载。
    await act(async () => root.render(<div />))
    expect(signal.aborted).toBe(true)
    await act(async () => finishQuick({ blob: new Blob(['quick-video']), extension: 'mp4' }))
    expect(state.toast).not.toHaveBeenCalled()
  })
})
