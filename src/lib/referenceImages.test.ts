import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canvasToBlob, loadImage } from './canvasImage'
import { assertReferenceFileSize, MAX_REFERENCE_FILE_BYTES, prepareReferenceImages, REFERENCE_IMAGE_TARGET_BYTES } from './referenceImages'

vi.mock('./canvasImage', () => ({ canvasToBlob: vi.fn(), loadImage: vi.fn() }))

const large = `data:image/png;base64,${'A'.repeat(Math.ceil((REFERENCE_IMAGE_TARGET_BYTES + 1) / 3) * 4)}`
const small = 'data:image/png;base64,aGVsbG8='
const drawImage = vi.fn()
let canvas: { width: number; height: number; getContext: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.clearAllMocks()
  canvas = { width: 0, height: 0, getContext: vi.fn(() => ({ drawImage })) }
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })
  vi.mocked(loadImage).mockResolvedValue({ naturalWidth: 4000, naturalHeight: 3000 } as HTMLImageElement)
  vi.mocked(canvasToBlob).mockResolvedValue(new Blob(['compressed'], { type: 'image/png' }))
})

afterEach(() => vi.unstubAllGlobals())

describe('参考图读取与请求副本', () => {
  it('仅超出平台本地读取上限才拒绝，并说明当前大小', () => {
    expect(() => assertReferenceFileSize(MAX_REFERENCE_FILE_BYTES)).not.toThrow()
    expect(() => assertReferenceFileSize(MAX_REFERENCE_FILE_BYTES + 1)).toThrow('50 MB')
    expect(() => assertReferenceFileSize(60 * 1024 * 1024)).toThrow('60.0 MB')
  })

  it('小图、URL 和非目标格式保持原字节，不解码或降质', async () => {
    const sources = [small, 'https://example.com/a.png', large.replace('image/png', 'image/gif')]
    expect(await prepareReferenceImages(sources)).toEqual(sources)
    expect(loadImage).not.toHaveBeenCalled()
  })

  it('有遮罩时整组保持原样，不破坏主图及遮罩的尺寸对应关系', async () => {
    const sources = [large, small]
    expect(await prepareReferenceImages(sources, small)).toBe(sources)
    expect(loadImage).not.toHaveBeenCalled()
  })

  it('大图只生成上传副本，保留原数组、角色顺序与比例', async () => {
    const sources = Object.freeze([large, small])
    const result = await prepareReferenceImages(sources as unknown as string[])
    expect(result[0]).toBe('data:image/png;base64,Y29tcHJlc3NlZA==')
    expect(result[1]).toBe(small)
    expect(sources[0]).toBe(large)
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2560, 1920)
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
  })

  it.each(['png', 'webp'])('带透明可能性的 %s 输出 PNG 而不是 JPEG', async (mime) => {
    await prepareReferenceImages([large.replace('image/png', `image/${mime}`)])
    expect(canvasToBlob).toHaveBeenCalledWith(canvas, 'image/png', 0.9)
  })

  it('JPEG 采用高质量压缩且不会把小尺寸原图放大', async () => {
    vi.mocked(loadImage).mockResolvedValue({ naturalWidth: 1000, naturalHeight: 500 } as HTMLImageElement)
    await prepareReferenceImages([large.replace('image/png', 'image/jpeg')])
    expect(canvasToBlob).toHaveBeenCalledWith(canvas, 'image/jpeg', 0.9)
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1000, 500)
  })

  it('按实际输出字节判断，仍太大时继续等比缩小', async () => {
    vi.mocked(canvasToBlob).mockResolvedValueOnce(new Blob([new Uint8Array(REFERENCE_IMAGE_TARGET_BYTES + 1)]))
    await prepareReferenceImages([large])
    expect(drawImage.mock.calls.map((args) => args.slice(3))).toEqual([[2560, 1920], [2048, 1536]])
  })

  it('无法压缩到目标时有界退出、中文提示且释放 Canvas', async () => {
    vi.mocked(canvasToBlob).mockResolvedValue(new Blob([new Uint8Array(REFERENCE_IMAGE_TARGET_BYTES + 1)]))
    await expect(prepareReferenceImages([large])).rejects.toThrow('自动压缩后仍无法提交')
    expect(canvasToBlob).toHaveBeenCalledTimes(7)
    expect(canvas.width).toBe(0)
  })

  it('浏览器无法绘图时明确提示手动缩小，不能继续发送未优化的大图', async () => {
    canvas.getContext.mockReturnValue(null)
    await expect(prepareReferenceImages([large])).rejects.toThrow('手动缩小')
    expect(canvasToBlob).not.toHaveBeenCalled()
    expect(canvas.width).toBe(0)
  })

  it('损坏大图的解码失败会传播，不返回假压缩成功', async () => {
    vi.mocked(loadImage).mockRejectedValue(new Error('图片加载失败'))
    await expect(prepareReferenceImages([large])).rejects.toThrow('图片加载失败')
    expect(canvasToBlob).not.toHaveBeenCalled()
  })
})
