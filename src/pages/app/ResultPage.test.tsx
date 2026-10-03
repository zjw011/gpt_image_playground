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
  fullSources: {} as Record<string, string>,
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
  useFullImage: (id: string | null) => id ? state.fullSources[id] ?? state.fullSrc : state.fullSrc,
  useThumbnail: (id: string) => state.fullSources[id] ?? null,
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
vi.mock('../../components/LivePhotoPlayer', () => ({ default: ({ frames }: { frames: string[] }) => <div aria-label="AI 连续帧" data-frames={JSON.stringify(frames)} /> }))
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

function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return { id: 'partial-task', prompt: '部分生成的画面', params: DEFAULT_PARAMS, inputImageIds: [], outputImages: ['frame-1'], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1, ...patch }
}

describe('ResultPage', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    state.tasks = []
    state.backend = false
    state.user = null
    state.fullSrc = null
    state.fullSources = {}
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
    vi.useRealTimers()
  })

  it('无图片的失败仍显示错误详情与明确的重新生成入口，不会自动提交', async () => {
    state.tasks = [task({ status: 'error', outputImages: [], error: '生成请求中断' })]
    await act(async () => root.render(<MemoryRouter initialEntries={['/result?task=partial-task']}><ResultPage /><Location /></MemoryRouter>))
    expect(container.textContent).toContain('这次没有生成成功')
    expect(container.querySelector('details')?.textContent).toContain('生成请求中断')
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(submitTask).not.toHaveBeenCalled()
    expect(reuseConfig).not.toHaveBeenCalled()
    const regenerate = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '重新生成')!
    expect(regenerate).toBeTruthy()
    vi.mocked(submitTask).mockResolvedValueOnce(false)
    await act(async () => regenerate.click())
    expect(reuseConfig).toHaveBeenCalledWith(state.tasks[0])
    expect(submitTask).toHaveBeenCalledOnce()
    expect(container.querySelector('output')?.textContent).toBe('/result?task=partial-task')
  })

  it('失败但保存了图片时保留查看、缩略切换和下载，不会冒充全失败或自动发布重试', async () => {
    state.backend = true
    state.user = { id: 'u-1' }
    state.fullSources = { 'frame-1': 'data:image/png;base64,first', 'frame-2': 'data:image/png;base64,second' }
    state.tasks = [task({ status: 'error', outputImages: ['frame-1', 'frame-2'], error: '后续图片未能完成' })]
    await act(async () => root.render(<MemoryRouter><ResultPage /></MemoryRouter>))
    expect(container.querySelector('[role="status"]')?.textContent).toContain('已保留 2')
    const details = container.querySelector('details')!
    expect(details).toBeTruthy()
    expect(details.open).toBe(false)
    expect(details.textContent).toContain('后续图片未能完成')
    expect(container.textContent).not.toContain('这次没有生成成功')
    expect(container.textContent).not.toContain('仍未生成图片')
    expect(container.textContent).not.toContain('本次失败不会扣除积分')
    expect(container.textContent).not.toContain('发布帖子')
    expect(container.querySelector('img[alt="部分生成的画面"]')?.getAttribute('src')).toBe(state.fullSources['frame-1'])
    const thumbs = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter((button) => button.querySelector('img[alt=""]'))
    expect(thumbs).toHaveLength(2)
    await act(async () => thumbs[1].click())
    expect(container.querySelector('img[alt="部分生成的画面"]')?.getAttribute('src')).toBe(state.fullSources['frame-2'])
    const download = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '下载')!
    expect(download.disabled).toBe(false)
    let downloadedSrc = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloadedSrc = this.href })
    await act(async () => download.click())
    expect(downloadedSrc).toBe(state.fullSources['frame-2'])
    expect(submitTask).not.toHaveBeenCalled()
    expect(reuseConfig).not.toHaveBeenCalled()
    expect(state.publishWork).not.toHaveBeenCalled()
  })

  it('失败 Live 只保存一帧时下载静态图片，不展示不可用的实况播放或导出', async () => {
    state.fullSrc = 'data:image/png;base64,single-frame'
    state.tasks = [task({ status: 'error', professionalPreset: 'live-blink', liveFrameCount: 8, error: '第二帧生成失败' })]
    await act(async () => root.render(<MemoryRouter><ResultPage /></MemoryRouter>))
    expect(container.querySelector('[role="status"]')?.textContent).toContain('已保留 1')
    expect(container.querySelector('img[alt="部分生成的画面"]')?.getAttribute('src')).toBe(state.fullSrc)
    expect(container.querySelector('[aria-label="AI 连续帧"]')).toBeNull()
    expect(container.textContent).not.toContain('下载视频')
    const download = Array.from(container.querySelectorAll('button')).find((button) => /^下载(?:图片)?$/.test(button.textContent ?? ''))!
    expect(download).toBeTruthy()
    expect(download.disabled).toBe(false)
    let filename = ''
    let downloadedSrc = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      filename = this.download
      downloadedSrc = this.href
    })
    await act(async () => download.click())
    expect(filename).toMatch(/\.png$/)
    expect(downloadedSrc).toBe(state.fullSrc)
    expect(exportLiveFrames).not.toHaveBeenCalled()
    expect(submitTask).not.toHaveBeenCalled()
    expect(state.publishWork).not.toHaveBeenCalled()
  })

  it('渠道返回相同图片时按输出槽位显示缩略图，不出现重复key错误', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    state.fullSources = { 'frame-1': 'data:image/png;base64,first' }
    state.tasks = [task({ outputImages: ['frame-1', 'frame-1'], params: { ...DEFAULT_PARAMS, n: 2 } })]
    await act(async () => root.render(<MemoryRouter><ResultPage /></MemoryRouter>))
    expect(container.querySelector('[aria-label="查看第 1 张图片"]')).not.toBeNull()
    const second = container.querySelector<HTMLButtonElement>('[aria-label="查看第 2 张图片"]')!
    expect(second).toBeTruthy()
    await act(async () => second.click())
    expect(container.querySelector('img[alt="部分生成的画面"]')?.getAttribute('src')).toBe(state.fullSources['frame-1'])
    expect(errors).not.toHaveBeenCalled()
    expect(state.tasks[0].outputImages).toEqual(['frame-1', 'frame-1'])
    expect(submitTask).not.toHaveBeenCalled()
  })

  it.each(['mp4', 'webm'])('失败 Live 保留多帧时按真实 %s 格式导出，不重新调用 AI', async (extension) => {
    const frames = ['data:image/png;base64,first', 'data:image/png;base64,second']
    state.fullSrc = frames[0]
    state.getImage.mockImplementation(async (id: string) => ({ dataUrl: id === 'frame-1' ? frames[0] : frames[1] }))
    state.tasks = [task({ status: 'error', outputImages: ['frame-1', 'frame-2'], professionalPreset: 'live-blink', liveFrameCount: 8, error: '第三帧生成失败' })]
    await act(async () => root.render(<MemoryRouter><ResultPage /></MemoryRouter>))
    expect(state.getImage).toHaveBeenCalledWith('frame-1')
    expect(state.getImage).toHaveBeenCalledWith('frame-2')
    expect(container.querySelector('[aria-label="AI 连续帧"]')?.getAttribute('data-frames')).toBe(JSON.stringify(frames))
    expect(container.querySelector('[role="status"]')?.textContent).toContain('已保留 2')
    const download = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '下载视频')!
    expect(download).toBeTruthy()
    expect(download.disabled).toBe(false)
    expect(container.textContent).toContain('不是苹果相册中的原生实况照片')
    vi.mocked(exportLiveFrames).mockResolvedValueOnce(new Blob(['video'], { type: `video/${extension}` }))
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:live'), revokeObjectURL: vi.fn() })
    let filename = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filename = this.download })
    vi.useFakeTimers()
    await act(async () => download.click())
    expect(exportLiveFrames).toHaveBeenCalledWith(frames, 280, expect.any(AbortSignal))
    expect(filename.endsWith(`.${extension}`)).toBe(true)
    expect(state.toast).toHaveBeenCalledWith(`${extension.toUpperCase()} 实况视频已导出`, 'success')
    await act(async () => vi.runOnlyPendingTimersAsync())
    expect(submitTask).not.toHaveBeenCalled()
    expect(reuseConfig).not.toHaveBeenCalled()
    expect(state.publishWork).not.toHaveBeenCalled()
  })

  it('已完成但存在部分输出错误时继续保留原部分完成横幅与图片', async () => {
    state.fullSrc = 'data:image/png;base64,retained'
    state.tasks = [task({ status: 'done', outputErrors: [{ requestIndex: 1, error: '另一张图片失败' }] })]
    await act(async () => root.render(<MemoryRouter><ResultPage /></MemoryRouter>))
    expect(container.querySelector('[role="status"]')?.textContent).toContain('部分完成')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('已保留 1')
    expect(container.querySelector('img[alt="部分生成的画面"]')?.getAttribute('src')).toBe(state.fullSrc)
    expect(container.textContent).not.toContain('这次没有生成成功')
    expect(submitTask).not.toHaveBeenCalled()
  })

  it('正常完成的单帧 Live 仍保留原来的禁用 Live 导出行为', async () => {
    state.fullSrc = 'data:image/png;base64,single-done'
    state.tasks = [task({ professionalPreset: 'live-blink', liveFrameCount: 8 })]
    await act(async () => root.render(<MemoryRouter><ResultPage /></MemoryRouter>))
    const download = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '下载视频')!
    expect(download).toBeTruthy()
    expect(download.disabled).toBe(true)
    expect(container.querySelector('[aria-label="AI 连续帧"]')).toBeNull()
    expect(exportLiveFrames).not.toHaveBeenCalled()
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

  it('换装结果返回专用编辑器，不用创作台旧蒙版直接重新收费生成', async () => {
    state.fullSrc = 'data:image/png;base64,preview'
    state.tasks = [{ id: 'try-on-task', prompt: '街边穿搭', params: DEFAULT_PARAMS, inputImageIds: ['person', 'product'], outputImages: ['out'], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1, professionalPreset: 'try-on', tryOn: { mode: 'wear', category: 'clothing', scene: 'street', pose: 'natural' } }]
    await act(async () => root.render(<MemoryRouter initialEntries={['/result?task=try-on-task']}><ResultPage /><Location /></MemoryRouter>))
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/tools?tool=try-on')
    await act(async () => Array.from(container.querySelectorAll('button')).find((el) => el.textContent === '编辑换装')?.click())
    expect(container.querySelector('output')?.textContent).toBe('/tools?tool=try-on&task=try-on-task')
    expect(reuseConfig).not.toHaveBeenCalled()
    expect(submitTask).not.toHaveBeenCalled()
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
    await act(async () => Array.from(container.querySelectorAll('button')).find((el) => el.textContent === '下载视频')?.click())
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
