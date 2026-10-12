// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ImagePasteButton from './ImagePasteButton'

const state = vi.hoisted(() => ({ read: vi.fn(), toast: vi.fn() }))
vi.mock('../lib/imagePaste', () => ({ readClipboardImages: state.read }))
vi.mock('../store', () => ({ useStore: (selector: (s: { showToast: typeof state.toast }) => unknown) => selector({ showToast: state.toast }) }))
let el: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  state.read.mockReset()
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

it('读取并上传图片，连续点击仅读取一次', async () => {
  const file = new File(['image'], 'image.png', { type: 'image/png' })
  const upload = vi.fn().mockResolvedValue(undefined)
  state.read.mockResolvedValue([file])
  await act(async () => root.render(<ImagePasteButton upload={upload} />))
  await act(async () => { el.querySelector('button')!.click(); el.querySelector('button')!.click() })
  expect(state.read).toHaveBeenCalledOnce()
  expect(upload).toHaveBeenCalledWith([file])
  expect(el.querySelector('button')!.disabled).toBe(false)
})

it('权限拒绝显示键盘回退，不上传空图片', async () => {
  const upload = vi.fn()
  state.read.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
  await act(async () => root.render(<ImagePasteButton upload={upload} />))
  await act(async () => el.querySelector('button')!.click())
  expect(upload).not.toHaveBeenCalled()
  expect(state.toast).toHaveBeenCalledWith(expect.stringContaining('Ctrl+V'), 'error')
})

it('禁用时不主动读取剪贴板', async () => {
  await act(async () => root.render(<ImagePasteButton disabled upload={vi.fn()} />))
  await act(async () => el.querySelector('button')!.click())
  expect(state.read).not.toHaveBeenCalled()
})

it('离开页面后的迟到剪贴板读取不再覆盖其他页面图片', async () => {
  let resolve: (files: File[]) => void = () => {}
  state.read.mockReturnValue(new Promise<File[]>((done) => { resolve = done }))
  const upload = vi.fn()
  await act(async () => root.render(<ImagePasteButton upload={upload} />))
  await act(async () => el.querySelector('button')!.click())
  await act(async () => root.render(<div />))
  await act(async () => resolve([new File(['image'], 'image.png', { type: 'image/png' })]))
  expect(upload).not.toHaveBeenCalled()
})
