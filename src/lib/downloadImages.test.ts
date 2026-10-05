// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadImageEntriesAsZip, downloadImageIds } from './downloadImages'
import { cleanVisibleWatermark } from './imageCleanup'
vi.mock('./imageCache', () => ({ ensureImageCached: vi.fn().mockResolvedValue('data:image/png;base64,image') }))
vi.mock('./imageCleanup', () => ({ cleanVisibleWatermark: vi.fn() }))

describe('下载与 ZIP 水印选项', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.mocked(cleanVisibleWatermark).mockReset() })
  function prepare() {
    const original = new Blob(['original'], { type: 'image/png' })
    const createObjectURL = vi.fn().mockReturnValue('blob:download')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => original }))
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    return { original, createObjectURL }
  }
  it('默认不调用处理接口，静态模式原下载不变', async () => {
    const { original, createObjectURL } = prepare()
    expect(await downloadImageIds(['image-1'])).toEqual({ successCount: 1, failCount: 0 })
    expect(cleanVisibleWatermark).not.toHaveBeenCalled()
    expect(createObjectURL).toHaveBeenCalledWith(original)
  })
  it('勾选后下载副本，处理失败下载原图并报告，不隐藏失败', async () => {
    const { original, createObjectURL } = prepare()
    vi.mocked(cleanVisibleWatermark).mockRejectedValueOnce(new Error('offline'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onCleanup = vi.fn()
    expect(await downloadImageIds(['image-1'], 'file', { removeWatermark: true, onCleanup })).toEqual({ successCount: 1, failCount: 0 })
    expect(createObjectURL).toHaveBeenCalledWith(original)
    expect(onCleanup).toHaveBeenCalledWith('failed')
  })
  it('批量 ZIP 按顺序处理每张图并保持结果格式扩展名', async () => {
    const { original, createObjectURL } = prepare()
    // jsdom Blob 没有 arrayBuffer，使用可读取的下载副本模拟 HTTP 响应。
    const cleaned = { type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Blob
    vi.mocked(cleanVisibleWatermark).mockResolvedValue({ blob: cleaned, status: 'cleaned' })
    const onCleanup = vi.fn()
    expect(await downloadImageEntriesAsZip([{ imageId: '1' }, { imageId: '2' }], 'zip', { removeWatermark: true, onCleanup })).toEqual({ successCount: 2, failCount: 0 })
    expect(cleanVisibleWatermark).toHaveBeenCalledTimes(2)
    expect(cleanVisibleWatermark).toHaveBeenCalledWith(original)
    expect(onCleanup).toHaveBeenCalledTimes(2)
    expect(createObjectURL.mock.calls[0][0].type).toBe('application/zip')
  })
})
