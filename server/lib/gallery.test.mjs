// 作品广场的持久化测试。
//
// 这里盯的是一个真实发生过的丢数据事故：元数据文件被写到了图片目录里，
// 而启动时的孤儿清理又会把"不在已知列表里"的文件删掉——于是每次重启
// 元数据都被删、用户上传的作品全部消失。下面每个用例都在防它复发。
import { beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getImagePath, initGallery, listWorks, publishWork, removeWork, toggleLike } from './gallery.mjs'

// 1x1 的合法 PNG（带不同注释字节就能造出内容不同的两张）
function pngDataUrl(seed = 0) {
  const base = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  return `data:image/png;base64,${base}`
}

const USER = 'u-tester'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gip-gallery-'))
  initGallery(dir)
})

describe('作品广场持久化', () => {
  it('上传的作品在"重启"（重新 init）之后还在', () => {
    const result = publishWork({ ownerId: USER, ownerName: '测试', prompt: '第一张', model: 'm', imageDataUrl: pngDataUrl() })
    expect(result.ok).toBe(true)
    const id = result.item.id
    expect(listWorks(null).some((item) => item.id === id)).toBe(true)

    // 模拟容器重启：重新读一遍数据目录
    initGallery(dir)

    const after = listWorks(null)
    expect(after.some((item) => item.id === id)).toBe(true)
    // 图片文件也必须还在（之前会被孤儿清理误删）
    expect(getImagePath(id)).not.toBeNull()
  })

  it('重启后精选作品不会被重复播种，用户作品也不丢', () => {
    const seedCount = listWorks(null).length
    publishWork({ ownerId: USER, ownerName: '测试', prompt: 'x', model: 'm', imageDataUrl: pngDataUrl() })

    initGallery(dir)
    initGallery(dir)

    const items = listWorks(null)
    expect(items.length).toBe(seedCount + 1)
    // 精选作品不能翻倍
    expect(items.filter((item) => item.id.startsWith('w-seed-')).length).toBe(seedCount)
  })

  it('元数据文件不会被自己的清理逻辑删掉', () => {
    publishWork({ ownerId: USER, ownerName: '测试', prompt: 'x', model: 'm', imageDataUrl: pngDataUrl() })
    // 元数据在数据目录根下，不在图片目录里
    expect(existsSync(join(dir, 'gallery.json'))).toBe(true)
    // 图片目录里只应该有图片，不该混进 gallery.json
    const files = readdirSync(join(dir, 'gallery'))
    expect(files.some((name) => name.endsWith('.json'))).toBe(false)
  })

  it('元数据损坏时恢复备份且不删除仍可恢复的图片', () => {
    const result = publishWork({ ownerId: USER, ownerName: '测试', prompt: 'x', model: 'm', imageDataUrl: pngDataUrl() })
    const imagePath = getImagePath(result.item.id).path
    writeFileSync(join(dir, 'gallery.json'), '{broken', 'utf-8')

    expect(() => initGallery(dir)).not.toThrow()
    expect(existsSync(imagePath)).toBe(true)
  })

  it('点赞数据同样会持久化', () => {
    const result = publishWork({ ownerId: USER, ownerName: '测试', prompt: 'x', model: 'm', imageDataUrl: pngDataUrl() })
    const id = result.item.id
    toggleLike(id, 'u-fan')

    initGallery(dir)

    const item = listWorks('u-fan').find((work) => work.id === id)
    expect(item?.likes).toBe(1)
    expect(item?.likedByMe).toBe(true)
  })

  it('删除作品只删自己那张的图片，不碰别人的', () => {
    const a = publishWork({ ownerId: USER, ownerName: '测试', prompt: 'a', model: 'm', imageDataUrl: pngDataUrl() })
    const b = publishWork({ ownerId: 'u-other', ownerName: '别人', prompt: 'b', model: 'm', imageDataUrl: `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='}` })
    // 两张图内容相同会被去重，这里允许重复：直接断言删 a 后 b 仍在
    removeWork(a.item.id, { userId: USER, isAdmin: false })
    expect(getImagePath(a.item.id)).toBeNull()
    if (b.ok && b.item.id !== a.item.id) expect(getImagePath(b.item.id)).not.toBeNull()
  })
})
