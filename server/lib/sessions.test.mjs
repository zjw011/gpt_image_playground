import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createSession, destroySessionsByUser, getSession, initSessions } from './sessions.mjs'

describe('登录会话持久化', () => {
  it('服务重启后用户会话仍然有效', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gip-sessions-'))
    initSessions(dir)
    const session = createSession('guest', 'u-1')

    initSessions(dir)
    expect(getSession(session.token)).toMatchObject({ role: 'guest', userId: 'u-1' })
  })

  it('用户密码变化后销毁的会话不会在重启后复活', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gip-sessions-'))
    initSessions(dir)
    const session = createSession('guest', 'u-1')
    destroySessionsByUser('u-1')

    initSessions(dir)
    expect(getSession(session.token)).toBeNull()
  })

  it('管理员修改自己密码时保留操作者会话，其他设备失效且不影响别人', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gip-sessions-'))
    initSessions(dir)
    const current = createSession('guest', 'admin')
    const otherDevice = createSession('guest', 'admin')
    const otherUser = createSession('guest', 'u-1')
    destroySessionsByUser('admin', current.token)
    initSessions(dir)
    expect(getSession(current.token)?.userId).toBe('admin')
    expect(getSession(otherDevice.token)).toBeNull()
    expect(getSession(otherUser.token)?.userId).toBe('u-1')
  })
})
