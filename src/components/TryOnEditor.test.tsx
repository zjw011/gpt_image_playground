// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type InputImage, type TaskRecord } from '../types'
import TryOnEditor from './TryOnEditor'

const state = vi.hoisted(() => ({ tasks: [] as TaskRecord[], upload: vi.fn(), submit: vi.fn(), getImage: vi.fn(), toast: vi.fn(), decode: vi.fn() }))
vi.mock('../store', () => ({
  useStore: (selector: (value: unknown) => unknown) => selector({ tasks: state.tasks, showToast: state.toast }),
  createInputImageFromFile: state.upload,
  submitTryOnTask: state.submit,
}))
vi.mock('../lib/backend', () => ({ getCreditsConfig: () => null }))
vi.mock('../lib/creditsStore', () => ({ useCreditsStore: () => null }))
vi.mock('../lib/db', () => ({ getImage: state.getImage }))
vi.mock('../lib/tryOn', async (importOriginal) => ({ ...await importOriginal<typeof import('../lib/tryOn')>(), validateTryOnImageData: state.decode }))

function Location() {
  const location = useLocation()
  return <output>{location.pathname + location.search}</output>
}

function SwitchTask() {
  const navigate = useNavigate()
  return <button onClick={() => navigate('/tools?tool=try-on&task=missing')}>切换不存在的记录</button>
}

describe('人物换装编辑器', () => {
  let el: HTMLDivElement
  let root: Root
  const person: InputImage = { id: 'person', dataUrl: 'data:image/png;base64,person' }
  const product: InputImage = { id: 'product', dataUrl: 'data:image/png;base64,product' }
  const render = async (path = '/tools?tool=try-on') => act(async () => root.render(<MemoryRouter initialEntries={[path]}><TryOnEditor /><Location /></MemoryRouter>))
  const click = async (text: string) => act(async () => Array.from(el.querySelectorAll('button')).find((button) => button.textContent?.includes(text))?.click())
  const upload = async (role: string, image: InputImage) => {
    state.upload.mockResolvedValueOnce(image)
    const input = el.querySelector<HTMLInputElement>(`#try-on-${role}`)!
    Object.defineProperty(input, 'files', { value: [new File(['image'], `${role}.png`, { type: 'image/png' })], configurable: true })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    state.tasks = []
    state.upload.mockReset()
    state.submit.mockReset()
    state.getImage.mockReset()
    state.toast.mockReset()
    state.decode.mockReset().mockResolvedValue(undefined)
    el = document.createElement('div')
    document.body.append(el)
    root = createRoot(el)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    el.remove()
    vi.unstubAllGlobals()
  })

  it('必须上传两种参考图，不会把其他创作台的图片默认为人物或商品', async () => {
    await render()
    expect(el.querySelector<HTMLButtonElement>('[aria-label="生成种草图"]')?.disabled).toBe(true)
    expect(el.querySelector('textarea')?.hasAttribute('maxlength')).toBe(false)
    await upload('person', person)
    expect(el.querySelector('[alt="人物参考图"]')?.getAttribute('src')).toBe(person.dataUrl)
    expect(el.querySelector<HTMLButtonElement>('[aria-label="生成种草图"]')?.disabled).toBe(true)
    await upload('product', product)
    expect(el.querySelector<HTMLButtonElement>('[aria-label="生成种草图"]')?.disabled).toBe(false)
    state.submit.mockResolvedValue(true)
    await click('生成种草图')
    expect(state.submit).toHaveBeenCalledWith({ person, product, prompt: '', options: { mode: 'wear', category: 'clothing', scene: 'street', pose: 'natural' }, size: '768x1024', count: 1 })
    expect(el.querySelector('output')?.textContent).toBe('/result')
  })

  it('用户只填写自己的文案，方案参数单独提交，数量限制为1至4张', async () => {
    await render()
    await upload('person', person)
    await upload('product', product)
    await click('手持商品')
    await click('其他商品')
    await click('咖啡小店')
    await click('商品展示')
    await click('1:1')
    const text = '窗边拿着香水' + '，保留商品颜色'.repeat(500)
    const input = el.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input.value).toBe(text)
    for (let i = 0; i < 5; i++) await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="增加生成数量"]')?.click())
    expect(el.querySelector('[aria-label="生成数量"]')?.textContent).toBe('4')
    expect(el.querySelector<HTMLButtonElement>('[aria-label="增加生成数量"]')?.disabled).toBe(true)
    state.submit.mockResolvedValue(false)
    await click('生成种草图')
    expect(state.submit).toHaveBeenCalledWith({ person, product, prompt: text, options: { mode: 'hold', category: 'other', scene: 'cafe', pose: 'showcase' }, size: '1024x1024', count: 4 })
    expect(el.querySelector('output')?.textContent).toBe('/tools?tool=try-on')
    expect(input.value).toBe(text)
  })

  it('上传无效文件或读取失败保留之前的参考图', async () => {
    await render()
    await upload('person', person)
    state.upload.mockRejectedValueOnce(new Error('无法读取图片'))
    const input = el.querySelector<HTMLInputElement>('#try-on-person')!
    Object.defineProperty(input, 'files', { value: [new File(['bad'], 'bad.png', { type: 'image/png' })], configurable: true })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(state.toast).toHaveBeenCalledWith('无法读取图片', 'error')
    expect(el.querySelector('[alt="人物参考图"]')?.getAttribute('src')).toBe(person.dataUrl)
    await upload('product', product)
    expect(el.querySelector<HTMLButtonElement>('[aria-label="生成种草图"]')?.disabled).toBe(false)
  })

  it('MIME正确但图片内容损坏时保留原参考图，不能启用缺图提交', async () => {
    await render()
    await upload('person', person)
    state.decode.mockRejectedValueOnce(new Error('图片损坏，无法读取'))
    await upload('person', { id: 'bad', dataUrl: 'data:image/png;base64,bad' })
    expect(state.toast).toHaveBeenCalledWith('图片损坏，无法读取', 'error')
    expect(el.querySelector('[alt="人物参考图"]')?.getAttribute('src')).toBe(person.dataUrl)
    expect(el.querySelector<HTMLButtonElement>('[aria-label="生成种草图"]')?.disabled).toBe(true)
    expect(state.submit).not.toHaveBeenCalled()
  })

  it('编辑历史记录按角色恢复图片与场景姿势', async () => {
    state.tasks = [{ id: 'saved', prompt: '拿着商品', params: { ...DEFAULT_PARAMS, size: '1024x1024', n: 2 }, inputImageIds: ['person', 'product'], outputImages: [], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1, tryOn: { mode: 'hold', category: 'bag', scene: 'studio', pose: 'sitting' } }]
    state.getImage.mockImplementation((id: string) => Promise.resolve(id === 'person' ? person : product))
    await render('/tools?tool=try-on&task=saved')
    expect(el.querySelector('[alt="人物参考图"]')?.getAttribute('src')).toBe(person.dataUrl)
    expect(el.querySelector('[alt="商品参考图"]')?.getAttribute('src')).toBe(product.dataUrl)
    expect(el.querySelector('textarea')?.value).toBe('拿着商品')
    expect(el.querySelector('[aria-label="生成数量"]')?.textContent).toBe('2')
    expect(Array.from(el.querySelectorAll('button[aria-pressed=true]')).map((button) => button.textContent)).toEqual(expect.arrayContaining(['手持商品自然拿着 · 清楚展示', '包袋', '简洁棚拍干净背景 · 突出商品', '轻松坐姿', '1:1']))
  })

  it('恢复记录的任一原图丢失都要求重新上传，不使用错位参考图', async () => {
    state.tasks = [{ id: 'saved', prompt: '穿搭', params: DEFAULT_PARAMS, inputImageIds: ['person', 'missing'], outputImages: [], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1, tryOn: { mode: 'wear', category: 'clothing', scene: 'street', pose: 'natural' } }]
    state.getImage.mockImplementation((id: string) => Promise.resolve(id === 'person' ? person : null))
    await render('/tools?tool=try-on&task=saved')
    expect(state.toast).toHaveBeenCalledWith('人物或商品原图已丢失，请重新上传', 'error')
    expect(el.querySelector('[alt="人物参考图"]')).toBeNull()
    expect(el.querySelector<HTMLButtonElement>('[aria-label="生成种草图"]')?.disabled).toBe(true)
  })

  it('在同一编辑器切换到无效任务时清除旧人物与商品，不误用上一份记录', async () => {
    state.tasks = [{ id: 'saved', prompt: '拿着商品', params: DEFAULT_PARAMS, inputImageIds: ['person', 'product'], outputImages: [], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1, tryOn: { mode: 'hold', category: 'other', scene: 'cafe', pose: 'showcase' } }]
    state.getImage.mockImplementation((id: string) => Promise.resolve(id === 'person' ? person : product))
    await act(async () => root.render(<MemoryRouter initialEntries={['/tools?tool=try-on&task=saved']}><TryOnEditor /><SwitchTask /><Location /></MemoryRouter>))
    expect(el.querySelector('[alt="人物参考图"]')).not.toBeNull()
    await click('切换不存在的记录')
    expect(el.querySelector('[alt="人物参考图"]')).toBeNull()
    expect(el.querySelector('[alt="商品参考图"]')).toBeNull()
    expect(el.querySelector('textarea')?.value).toBe('')
    expect(el.querySelector<HTMLButtonElement>('[aria-label="生成种草图"]')?.disabled).toBe(true)
    expect(el.textContent).toContain('未找到可编辑的换装记录')
  })

  it('快速重复提交只保存一次，离开页面后不自动跳走', async () => {
    await render()
    await upload('person', person)
    await upload('product', product)
    let resolve: (value: boolean) => void = () => {}
    state.submit.mockReturnValue(new Promise<boolean>((done) => { resolve = done }))
    await act(async () => {
      const button = el.querySelector<HTMLButtonElement>('[aria-label="生成种草图"]')!
      button.click()
      button.click()
    })
    expect(state.submit).toHaveBeenCalledTimes(1)
    await act(async () => root.render(<p>已离开</p>))
    await act(async () => resolve(true))
    expect(el.textContent).toBe('已离开')
  })

  it('爆款参考默认全面参考与跟随姿势，第二张图片用途明确且不改写用户描述', async () => {
    await render()
    await click('爆款参考')
    expect(el.querySelector('[aria-label="选择爆款参考图"]')).not.toBeNull()
    expect(el.querySelector('[aria-label="上传爆款参考图片"]')).not.toBeNull()
    expect(el.textContent).toContain('不会借用对方的脸')
    expect(el.textContent).not.toContain('商品类型')
    expect(el.textContent).not.toContain('场景氛围')
    expect(el.querySelector('textarea')?.value).toBe('')
    expect(el.querySelector('textarea')?.hasAttribute('maxlength')).toBe(false)
    expect(Array.from(el.querySelectorAll('button[aria-pressed=true]')).map((button) => button.textContent)).toEqual(expect.arrayContaining(['跟随参考姿势', '整套穿搭衣服、鞋包与可见配饰', '场景背景环境、地点与空间氛围', '拍摄风格光线、色调与镜头构图']))
    await upload('person', person)
    await upload('product', product)
    state.submit.mockResolvedValue(false)
    await click('生成种草图')
    expect(state.submit).toHaveBeenCalledWith({ person, product, prompt: '', options: { mode: 'reference', category: 'clothing', scene: 'street', pose: 'reference', referenceElements: ['outfit', 'scene', 'style'] }, size: '768x1024', count: 1 })
  })

  it('参考元素可独立关闭，只参考穿搭时保留最后一项，切换姿势不恢复被关闭的元素', async () => {
    await render()
    await click('爆款参考')
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="参考场景背景"]')?.click())
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="参考拍摄风格"]')?.click())
    expect(el.querySelector<HTMLButtonElement>('[aria-label="参考整套穿搭"]')?.disabled).toBe(true)
    await click('行走抓拍')
    await upload('person', person)
    await upload('product', product)
    state.submit.mockResolvedValue(false)
    await click('生成种草图')
    expect(state.submit.mock.calls[0][0].options).toEqual({ mode: 'reference', category: 'clothing', scene: 'street', pose: 'walking', referenceElements: ['outfit'] })
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="参考拍摄风格"]')?.click())
    expect(el.querySelector<HTMLButtonElement>('[aria-label="参考整套穿搭"]')?.disabled).toBe(false)
  })

  it('切回商品模式保留图片并移除参考角色参数，跟随姿势回到自然站姿', async () => {
    await render()
    await upload('person', person)
    await upload('product', product)
    await click('爆款参考')
    expect(el.querySelector('[alt="爆款参考图"]')?.getAttribute('src')).toBe(product.dataUrl)
    await click('上身穿搭')
    expect(el.querySelector('[alt="商品参考图"]')?.getAttribute('src')).toBe(product.dataUrl)
    expect(el.querySelector('[alt="人物参考图"]')?.getAttribute('src')).toBe(person.dataUrl)
    expect(el.textContent).toContain('商品类型')
    expect(el.textContent).not.toContain('想参考哪些元素')
    state.submit.mockResolvedValue(false)
    await click('生成种草图')
    expect(state.submit.mock.calls[0][0].options).toEqual({ mode: 'wear', category: 'clothing', scene: 'street', pose: 'natural' })
  })

  it('移除参考图只清空该角色，补齐前禁用生成，重新上传后恢复可提交', async () => {
    await render()
    await click('爆款参考')
    await upload('person', person)
    await upload('product', product)
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="移除爆款参考图"]')?.click())
    expect(el.querySelector('[alt="爆款参考图"]')).toBeNull()
    expect(el.querySelector('[alt="人物参考图"]')?.getAttribute('src')).toBe(person.dataUrl)
    expect(el.querySelector<HTMLButtonElement>('[aria-label="生成种草图"]')?.disabled).toBe(true)
    await upload('product', product)
    expect(el.querySelector<HTMLButtonElement>('[aria-label="生成种草图"]')?.disabled).toBe(false)
  })

  it('同一张图片不能作为两个角色，会提示并禁用提交', async () => {
    await render()
    await upload('person', person)
    await upload('product', person)
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('两张参考图不能使用同一张图片')
    expect(el.querySelector<HTMLButtonElement>('[aria-label="生成种草图"]')?.disabled).toBe(true)
    await upload('product', product)
    expect(el.querySelector('[role="alert"]')).toBeNull()
    expect(el.querySelector<HTMLButtonElement>('[aria-label="生成种草图"]')?.disabled).toBe(false)
  })

  it('历史参考模式恢复角色与选择，但用户新生成随机姿势不传旧种子', async () => {
    state.tasks = [{ id: 'saved', prompt: '只参考衣服和拍摄质感', params: DEFAULT_PARAMS, inputImageIds: ['person', 'product'], outputImages: [], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1, tryOn: { mode: 'reference', category: 'clothing', scene: 'street', pose: 'random', poseVariant: 3, referenceElements: ['outfit', 'style'] } }]
    state.getImage.mockImplementation((id: string) => Promise.resolve(id === 'person' ? person : product))
    await render('/tools?tool=try-on&task=saved')
    expect(el.querySelector('[alt="爆款参考图"]')?.getAttribute('src')).toBe(product.dataUrl)
    expect(el.querySelector('[aria-label="参考场景背景"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(el.querySelector('textarea')?.value).toBe('只参考衣服和拍摄质感')
    expect(Array.from(el.querySelectorAll('button[aria-pressed=true]')).map((button) => button.textContent)).toContain('随机自然姿势')
    state.submit.mockResolvedValue(false)
    await click('生成种草图')
    expect(state.submit.mock.calls[0][0].options).toEqual({ mode: 'reference', category: 'clothing', scene: 'street', pose: 'random', referenceElements: ['outfit', 'style'] })
    expect(state.submit.mock.calls[0][0].options).not.toHaveProperty('poseVariant')
  })

  it('旧商品模式也可选择随机姿势，不带爆款参考参数', async () => {
    await render()
    await upload('person', person)
    await upload('product', product)
    await click('手持商品')
    await click('随机自然姿势')
    state.submit.mockResolvedValue(false)
    await click('生成种草图')
    expect(state.submit.mock.calls[0][0].options).toEqual({ mode: 'hold', category: 'clothing', scene: 'street', pose: 'random' })
  })
})
