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
})
