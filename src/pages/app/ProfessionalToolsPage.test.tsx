// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type InputImage, type TaskRecord } from '../../types'
import ProfessionalToolsPage from './ProfessionalToolsPage'

const state = vi.hoisted(() => ({
  inputImages: [] as InputImage[],
  tasks: [] as TaskRecord[],
  upload: vi.fn(),
  save: vi.fn(),
  getImage: vi.fn(),
  toast: vi.fn(),
}))
vi.mock('../../store', () => ({
  useStore: (selector: (value: unknown) => unknown) => selector({
    inputImages: state.inputImages,
    tasks: state.tasks,
    params: DEFAULT_PARAMS,
    setInputImages: (images: InputImage[]) => { state.inputImages = images },
    showToast: state.toast,
    clearInputImages: vi.fn(),
    setParams: vi.fn(),
    setPrompt: vi.fn(),
  }),
  createInputImageFromFile: state.upload,
  submitQuickMotionTask: state.save,
  submitTask: vi.fn(),
  addImageFromFile: vi.fn(),
}))
vi.mock('../../lib/backend', () => ({ getCreditsConfig: () => null }))
vi.mock('../../lib/creditsStore', () => ({ useCreditsStore: () => null }))
vi.mock('../../lib/db', () => ({ getImage: state.getImage }))
vi.mock('../../components/QuickMotionPlayer', () => ({
  default: ({ src }: { src: string }) => <div aria-label="快速运镜预览" data-src={src} />,
}))
vi.mock('./AppShell', () => ({ default: ({ children }: { children: ReactNode }) => <main>{children}</main> }))

function Location() {
  const location = useLocation()
  return <output>{location.pathname + location.search}</output>
}

describe('专业工具快速运镜', () => {
  let el: HTMLDivElement
  let root: Root
  const render = async (path = '/tools?tool=live') => act(async () => root.render(<MemoryRouter initialEntries={[path]}><ProfessionalToolsPage /><Location /></MemoryRouter>))
  const click = async (text: string) => act(async () => Array.from(el.querySelectorAll('button')).find((button) => button.textContent?.includes(text))?.click())

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    state.inputImages = []
    state.tasks = []
    state.upload.mockReset()
    state.save.mockReset()
    state.getImage.mockReset()
    state.toast.mockReset()
    el = document.createElement('div')
    document.body.append(el)
    root = createRoot(el)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    el.remove()
    vi.unstubAllGlobals()
  })

  it('默认快速运镜无图不能保存，保留可切换的 AI 模式', async () => {
    await render()
    expect(el.querySelector('#live-tab-quick')?.getAttribute('aria-selected')).toBe('true')
    expect(el.textContent).toContain('本地制作 · 0 积分')
    expect(Array.from(el.querySelectorAll('button')).find((button) => button.textContent?.includes('保存作品与预览'))?.disabled).toBe(true)
    await click('AI 微动作')
    expect(el.querySelector('output')?.textContent).toBe('/tools?tool=live&liveMode=ai')
    expect(el.textContent).toContain('AI 关键帧')
    expect(el.textContent).toContain('自然眨眼')
    expect(el.textContent).not.toContain('保存作品与预览')
    expect(state.save).not.toHaveBeenCalled()
  })

  it('选择效果、时长和幅度后保存本地作品并打开结果', async () => {
    state.inputImages = [{ id: 'source', dataUrl: 'data:image/png;base64,image' }]
    state.save.mockResolvedValue('quick-task')
    await render()
    await click('向右轻移')
    await click('1 秒')
    await click('轻柔 · 2%')
    await click('保存作品与预览')
    expect(state.save).toHaveBeenCalledWith({ effect: 'pan-right', duration: 1, strength: 2 })
    expect(el.querySelector('output')?.textContent).toBe('/result?task=quick-task')
  })

  it('重复上传已经存在的图片仍切换为选中的原图', async () => {
    const image = { id: 'second', dataUrl: 'data:image/png;base64,second' }
    state.inputImages = [{ id: 'first', dataUrl: 'data:image/png;base64,first' }, image]
    state.upload.mockResolvedValue(image)
    await render()
    const input = el.querySelector<HTMLInputElement>('#quick-motion-upload')!
    Object.defineProperty(input, 'files', { value: [new File(['image'], 'same.png', { type: 'image/png' })] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(state.inputImages).toEqual([image])
    expect(el.querySelector('[aria-label="快速运镜预览"]')?.getAttribute('data-src')).toBe(image.dataUrl)
  })

  it('直接打开已保存的编辑地址恢复对应原图和参数', async () => {
    state.tasks = [{ id: 'quick-task', prompt: '运镜', params: DEFAULT_PARAMS, inputImageIds: ['original'], outputImages: ['original'], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1, quickMotion: { effect: 'pan-left', duration: 3, strength: 5 } }]
    state.getImage.mockResolvedValue({ id: 'original', dataUrl: 'data:image/png;base64,original' })
    await render('/tools?tool=live&task=quick-task')
    // 持久化读取后让选择器重新取到原图，与真实 Zustand 订阅一致。
    await render('/tools?tool=live&task=quick-task')
    expect(state.getImage).toHaveBeenCalledWith('original')
    expect(state.inputImages[0]?.id).toBe('original')
    expect(el.querySelector('[aria-label="快速运镜预览"]')?.getAttribute('data-src')).toContain('original')
    expect(Array.from(el.querySelectorAll('button[aria-pressed="true"]')).map((button) => button.textContent).join(' ')).toContain('3 秒')
    expect(Array.from(el.querySelectorAll('button[aria-pressed="true"]')).map((button) => button.textContent).join(' ')).toContain('明显 · 5%')
  })

  it('上传尚未完成时切换 AI 模式，迟到上传不覆盖新页面原图', async () => {
    let finish!: (image: InputImage) => void
    state.upload.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await render()
    const input = el.querySelector<HTMLInputElement>('#quick-motion-upload')!
    Object.defineProperty(input, 'files', { value: [new File(['image'], 'photo.png', { type: 'image/png' })] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await click('AI 微动作')
    const current = { id: 'ai-source', dataUrl: 'data:image/png;base64,ai' }
    state.inputImages = [current]
    await act(async () => finish({ id: 'late', dataUrl: 'data:image/png;base64,late' }))
    expect(state.inputImages).toEqual([current])
    expect(el.querySelector('output')?.textContent).toBe('/tools?tool=live&liveMode=ai')
  })

  it('保存后离开快速模式，迟到保存不强制跳走', async () => {
    let finish!: (id: string) => void
    state.inputImages = [{ id: 'source', dataUrl: 'data:image/png;base64,image' }]
    state.save.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await render()
    await click('保存作品与预览')
    await click('AI 微动作')
    await act(async () => finish('late-task'))
    expect(el.querySelector('output')?.textContent).toBe('/tools?tool=live&liveMode=ai')
  })
})
