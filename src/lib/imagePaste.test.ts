// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClipboardEvent } from 'react'
import { getPastedImages, pasteImages, readClipboardImages } from './imagePaste'

afterEach(() => vi.unstubAllGlobals())

const image = new File(['image'], 'shot.png', { type: 'image/png' })
const text = new File(['text'], 'note.txt', { type: 'text/plain' })
const data = (files: File[], items: unknown[] = []) => ({ files, items }) as unknown as DataTransfer

describe('剪贴板图片导入', () => {
  it('仅提取图片文件，不重复读取相同 items', () => {
    expect(getPastedImages(data([image, text], [{ kind: 'file', type: 'image/png', getAsFile: () => image }]))).toEqual([image])
  })
  it('兼容只在 items 中提供图片的浏览器，忽略空文件和文字', () => {
    expect(getPastedImages(data([], [
      { kind: 'file', type: 'image/png', getAsFile: () => image },
      { kind: 'file', type: 'image/png', getAsFile: () => null },
      { kind: 'string', type: 'text/html' },
    ]))).toEqual([image])
    expect(getPastedImages(null)).toEqual([])
  })
  it('普通文字、HTML 和图片网址粘贴不被拦截', () => {
    const event = { clipboardData: data([]), preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as ClipboardEvent
    const upload = vi.fn().mockResolvedValue(undefined)
    pasteImages(event, upload)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })
  it('图片粘贴只交给当前区域，已处理事件不会再次上传', () => {
    const event = { clipboardData: data([image]), preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as ClipboardEvent
    const upload = vi.fn().mockResolvedValue(undefined)
    pasteImages(event, upload)
    expect(upload).toHaveBeenCalledWith([image])
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    pasteImages({ ...event, defaultPrevented: true } as ClipboardEvent, upload)
    expect(upload).toHaveBeenCalledOnce()
  })
  it('不支持读取的浏览器提示键盘粘贴回退', async () => {
    vi.stubGlobal('isSecureContext', false)
    await expect(readClipboardImages()).rejects.toThrow('Ctrl+V')
  })
  it('按钮读取每个剪贴板项目的一种图片，保留实际格式', async () => {
    vi.stubGlobal('isSecureContext', true)
    const getType = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read: vi.fn().mockResolvedValue([
      { types: ['text/html', 'image/png', 'image/jpeg'], getType },
      { types: ['text/plain'] },
    ]) } })
    const files = await readClipboardImages()
    expect(files).toHaveLength(1)
    expect(files[0].type).toBe('image/png')
    expect(getType).toHaveBeenCalledOnce()
  })
  it('空剪贴板和权限拒绝不能冒充粘贴成功', async () => {
    vi.stubGlobal('isSecureContext', true)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read: vi.fn().mockResolvedValue([]) } })
    await expect(readClipboardImages()).rejects.toThrow('没有图片')
    navigator.clipboard.read = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    await expect(readClipboardImages()).rejects.toMatchObject({ name: 'NotAllowedError' })
  })
})
