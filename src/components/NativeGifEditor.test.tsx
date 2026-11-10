// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type ApiProfile, type TaskRecord } from '../types'
import NativeGifEditor from './NativeGifEditor'

const state = vi.hoisted(() => ({ profiles: [] as ApiProfile[], submit: vi.fn(), upload: vi.fn(), getImage: vi.fn(), toast: vi.fn() }))
vi.mock('../store', () => ({
  useStore: (selector: (value: unknown) => unknown) => selector({ settings: { profiles: state.profiles, activeProfileId: 'static' }, showToast: state.toast }),
  submitTask: state.submit,
  createInputImageFromFile: state.upload,
}))
vi.mock('../lib/db', () => ({ getImage: state.getImage }))

function Location() {
  const location = useLocation()
  return <output>{location.pathname + location.search}</output>
}

const profile: ApiProfile = { id: 'gif', name: '动图服务', provider: 'openai', apiMode: 'images', model: 'gpt-image-2.6-sunburst', baseUrl: 'https://example.test', apiKey: '', timeout: 600, codexCli: false, apiProxy: false, transparentBackgroundMethod: 'api' }
const saved: TaskRecord = { id: 'gif-task', prompt: '蝴蝶扇动翅膀', professionalPreset: 'live-gif', apiProfileId: 'gif', params: { ...DEFAULT_PARAMS, output_format: 'gif', frame_count: 12, frame_duration_ms: 150 }, inputImageIds: [], outputImages: [], status: 'error', error: 'timeout', createdAt: 1, finishedAt: 2, elapsed: 1 }

describe('原生 GIF 编辑器', () => {
  let el: HTMLDivElement
  let root: Root
  const render = async (task?: TaskRecord) => act(async () => root.render(<MemoryRouter initialEntries={['/tools?tool=live&liveMode=gif']}><NativeGifEditor key={task?.id ?? 'new'} saved={task} /><Location /></MemoryRouter>))
  const click = async (text: string) => act(async () => Array.from(el.querySelectorAll('button')).find((button) => button.textContent?.includes(text))?.click())

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    state.profiles = [{ ...profile, id: 'static', name: '静态生图', model: 'gpt-image-2' }, profile, { ...profile, id: 'gif-other', name: '另一动图服务' }]
    state.submit.mockReset().mockResolvedValue(true)
    state.upload.mockReset()
    state.getImage.mockReset()
    state.toast.mockReset()
    el = document.createElement('div')
    document.body.append(el)
    root = createRoot(el)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    el.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('只列出支持动图的渠道，文字创作按所选渠道提交一份 GIF 而非连续帧任务', async () => {
    await render()
    const channel = el.querySelector<HTMLSelectElement>('[aria-label="GIF 生成渠道"]')!
    expect(Array.from(channel.options).map((option) => option.value)).toEqual(['gif', 'gif-other'])
    const prompt = el.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, '  小猫眨眼，动作循环  ')
      prompt.dispatchEvent(new Event('input', { bubbles: true }))
      channel.value = 'gif-other'
      channel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click('生成 GIF 动图')
    expect(state.submit).toHaveBeenCalledWith({ apiProfileId: 'gif-other', professionalPreset: 'live-gif', inputSnapshot: { prompt: '小猫眨眼，动作循环', inputImages: [], params: { ...DEFAULT_PARAMS, output_format: 'gif', frame_count: 9, frame_duration_ms: 200 } } })
    expect(el.querySelector('output')?.textContent).toBe('/result')
  })

  it('没有可用渠道时明确说明，保持生成按钮不可用且不暴露密钥配置', async () => {
    state.profiles = [state.profiles[0]]
    await render(saved)
    expect(el.textContent).toContain('请管理员在渠道管理中添加支持 GIF 的模型')
    expect(Array.from(el.querySelectorAll('button')).find((button) => button.textContent?.includes('生成 GIF 动图'))?.disabled).toBe(true)
    expect(el.querySelector('input[type="password"]')).toBeNull()
    expect(state.submit).not.toHaveBeenCalled()
  })

  it('恢复参考图与动图参数后提交，连点只创建一个任务', async () => {
    const image = { id: 'reference', dataUrl: 'data:image/png;base64,reference' }
    state.getImage.mockResolvedValue(image)
    let finish!: (value: boolean) => void
    state.submit.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await render({ ...saved, inputImageIds: ['reference'] })
    expect(el.querySelector('[alt="GIF 参考图"]')?.getAttribute('src')).toBe(image.dataUrl)
    expect(el.querySelector<HTMLSelectElement>('[aria-label="GIF 动画帧数"]')?.value).toBe('12')
    expect(el.querySelector<HTMLSelectElement>('[aria-label="GIF 每帧时长"]')?.value).toBe('150')
    const button = Array.from(el.querySelectorAll('button')).find((item) => item.textContent?.includes('生成 GIF 动图'))!
    await act(async () => { button.click(); button.click() })
    expect(state.submit).toHaveBeenCalledTimes(1)
    expect(state.submit.mock.calls[0][0].inputSnapshot).toEqual({ prompt: saved.prompt, inputImages: [image], params: saved.params })
    await act(async () => finish(true))
    expect(el.querySelector('output')?.textContent).toBe('/result')
  })

  it('参考图丢失时阻止静默改成纯文字生成，移除后才能继续', async () => {
    state.getImage.mockResolvedValue(null)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await render({ ...saved, inputImageIds: ['missing'] })
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('原参考图未能恢复')
    await click('生成 GIF 动图')
    expect(state.submit).not.toHaveBeenCalled()
    await click('移除参考图')
    await click('生成 GIF 动图')
    expect(state.submit.mock.calls[0][0].inputSnapshot.inputImages).toEqual([])
  })

  it('上传失败保留原草稿，提交失败也不会离开编辑器', async () => {
    state.upload.mockRejectedValue(new Error('图片读取失败'))
    state.submit.mockResolvedValue(false)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await render(saved)
    const input = el.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File(['image'], 'photo.png', { type: 'image/png' })] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(state.toast).toHaveBeenCalledWith('图片读取失败', 'error')
    await click('生成 GIF 动图')
    expect(el.querySelector('output')?.textContent).toBe('/tools?tool=live&liveMode=gif')
    expect(el.querySelector('textarea')?.value).toBe(saved.prompt)
  })

  it('拒绝 GIF 作为参考图，避免隐式截取首帧或提交不受支持的动图输入', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await render(saved)
    const input = el.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File(['GIF89a'], 'motion.gif', { type: 'image/gif' })] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(state.upload).not.toHaveBeenCalled()
    expect(state.toast).toHaveBeenCalledWith('请使用 PNG、JPG 或 WebP 静态参考图', 'error')
  })
})
