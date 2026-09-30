import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createComment,
  initGalleryComments,
  listComments,
  listCommentsForAdmin,
  removeComment,
  reportComment,
  setCommentHidden,
} from './galleryComments.mjs'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gip-comments-'))
  initGalleryComments(dir)
})

describe('作品评论', () => {
  it('按最新顺序列出并在重启后保留', () => {
    createComment({ workId: 'w-1', userId: 'u-1', userName: '甲', text: '第一条', now: 20_000 })
    createComment({ workId: 'w-1', userId: 'u-2', userName: '乙', text: '第二条', now: 30_000 })
    expect(listComments('w-1').comments.map((item) => item.text)).toEqual(['第二条', '第一条'])

    initGalleryComments(dir)

    expect(listComments('w-1').total).toBe(2)
  })

  it('拒绝空内容、超长内容、链接和 HTML', () => {
    expect(createComment({ workId: 'w-1', userId: 'u-1', text: ' ' }).status).toBe(400)
    expect(createComment({ workId: 'w-1', userId: 'u-1', text: '甲'.repeat(201) }).status).toBe(400)
    expect(createComment({ workId: 'w-1', userId: 'u-1', text: '看 https://example.com' }).status).toBe(400)
    expect(createComment({ workId: 'w-1', userId: 'u-1', text: '<b>广告</b>' }).status).toBe(400)
  })

  it('限制连续发布但不影响其他用户', () => {
    expect(createComment({ workId: 'w-1', userId: 'u-1', text: '一', now: 20_000 }).ok).toBe(true)
    expect(createComment({ workId: 'w-1', userId: 'u-1', text: '二', now: 25_000 }).status).toBe(429)
    expect(createComment({ workId: 'w-1', userId: 'u-2', text: '二', now: 25_000 }).ok).toBe(true)
  })

  it('只允许作者删除，管理员可以强制删除', () => {
    const made = createComment({ workId: 'w-1', userId: 'u-1', text: '内容', now: 20_000 })
    expect(removeComment(made.comment.id, { userId: 'u-2' }).status).toBe(403)
    expect(removeComment(made.comment.id, { isAdmin: true }).ok).toBe(true)
  })

  it('举报去重且不允许举报自己', () => {
    const made = createComment({ workId: 'w-1', userId: 'u-1', text: '内容', now: 20_000 })
    expect(reportComment(made.comment.id, { userId: 'u-1' }).status).toBe(400)
    expect(reportComment(made.comment.id, { userId: 'u-2', now: 30_000 }).duplicated).toBe(false)
    expect(reportComment(made.comment.id, { userId: 'u-2', now: 40_000 }).duplicated).toBe(true)
    expect(listCommentsForAdmin({ status: 'reported' }).comments[0].reports).toBe(1)
  })

  it('隐藏的评论不再出现在公开列表', () => {
    const made = createComment({ workId: 'w-1', userId: 'u-1', text: '内容', now: 20_000 })
    setCommentHidden(made.comment.id, true)
    expect(listComments('w-1').total).toBe(0)
    expect(listCommentsForAdmin({ status: 'hidden' }).comments).toHaveLength(1)
  })
})
