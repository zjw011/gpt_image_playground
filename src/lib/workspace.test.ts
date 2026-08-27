// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { getWorkspaceId, isSharedWorkspace, scopeStorageName, syncWorkspaceId } from './workspace'

beforeEach(() => {
  localStorage.clear()
  syncWorkspaceId('shared')
})

describe('scopeStorageName', () => {
  it('共享工作区沿用原名，保证老用户升级后数据不丢', () => {
    expect(isSharedWorkspace()).toBe(true)
    expect(scopeStorageName('gpt-image-playground')).toBe('gpt-image-playground')
  })

  it('多用户模式下按工作区加后缀', () => {
    syncWorkspaceId('u-abc123')
    expect(scopeStorageName('gpt-image-playground')).toBe('gpt-image-playground--u-abc123')
    expect(getWorkspaceId()).toBe('u-abc123')
  })
})

describe('syncWorkspaceId', () => {
  it('身份变化时返回 true，让调用方刷新页面重新水合', () => {
    expect(syncWorkspaceId('u-abc123')).toBe(true)
    expect(syncWorkspaceId('u-abc123')).toBe(false)
    expect(syncWorkspaceId('shared')).toBe(true)
  })

  it('切换后写入缓存键，下次加载能同步读到', () => {
    syncWorkspaceId('u-abc123')
    expect(localStorage.getItem('gpt-image-playground-workspace')).toBe('u-abc123')
    syncWorkspaceId('shared')
    expect(localStorage.getItem('gpt-image-playground-workspace')).toBe(null)
  })

  it('非法或缺失的工作区回落到共享区', () => {
    syncWorkspaceId('u-abc123')
    expect(syncWorkspaceId('../../etc')).toBe(true)
    expect(getWorkspaceId()).toBe('shared')
    syncWorkspaceId('u-abc123')
    expect(syncWorkspaceId(null)).toBe(true)
    expect(getWorkspaceId()).toBe('shared')
  })
})
