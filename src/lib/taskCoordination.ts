import type { TaskRecord } from '../types'
import { scopeStorageName } from './workspace'
import { markInterruptedOpenAIRunningTasks } from './taskState'

const owner = Math.random().toString(36).slice(2)
const active = new Map<string, () => void>()
let channel: BroadcastChannel | undefined
let onChange: (() => void) | undefined

function leaseKey(id: string) {
  return scopeStorageName(`gip-task-owner-${id}`)
}

export function ownsTask(id: string) {
  return active.has(id)
}

export async function claimTask(id: string): Promise<boolean> {
  if (active.has(id)) return true
  if (typeof window === 'undefined') {
    active.set(id, () => {})
    return true
  }
  const key = leaseKey(id)
  let releaseLock: (() => void) | undefined
  if (navigator.locks) {
    const acquired = await new Promise<boolean>((resolve, reject) => {
      void navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(false)
          return
        }
        await new Promise<void>((release) => {
          releaseLock = release
          resolve(true)
        })
      }).catch(reject)
    })
    if (!acquired) return false
  } else if (await isTaskOwned(id)) return false
  const heartbeat = () => {
    try { localStorage.setItem(key, JSON.stringify({ owner, expires: Date.now() + 120_000 })) } catch { /* 无本地存储时仍保留 Web Lock。 */ }
  }
  heartbeat()
  const timer = window.setInterval(heartbeat, 30_000)
  active.set(id, () => {
    window.clearInterval(timer)
    try {
      if (JSON.parse(localStorage.getItem(key) || 'null')?.owner === owner) localStorage.removeItem(key)
    } catch { /* 损坏的租约不会删除其他标签页的数据。 */ }
    releaseLock?.()
  })
  return true
}

export function releaseTask(id: string) {
  active.get(id)?.()
  active.delete(id)
  notifyTaskChanges()
}

export async function isTaskOwned(id: string): Promise<boolean> {
  if (active.has(id)) return true
  if (typeof window === 'undefined') return false
  if (navigator.locks) {
    const state = await navigator.locks.query()
    return Boolean(state.held?.some((lock) => lock.name === leaseKey(id)))
  }
  try {
    const lease = JSON.parse(localStorage.getItem(leaseKey(id)) || 'null')
    return Boolean(lease && typeof lease.expires === 'number' && lease.expires > Date.now())
  } catch { return true }
}

export async function getOwnedTaskIds(tasks: TaskRecord[]) {
  const ids = await Promise.all(tasks.filter((task) => task.status === 'running' || task.falRecoverable || task.customRecoverable).map(async (task) => await isTaskOwned(task.id) ? task.id : null))
  return new Set(ids.filter((id): id is string => id !== null))
}

/** 获得独占锁后重新读取，避免旧的 running 快照覆盖刚完成的结果。 */
export async function reconcileTaskSnapshot(tasks: TaskRecord[], read: () => Promise<TaskRecord[]>, write: (task: TaskRecord) => Promise<unknown>) {
  const protectedIds = await getOwnedTaskIds(tasks)
  const claimed: string[] = []
  try {
    for (const task of tasks) {
      if (task.status !== 'running' || task.apiProvider === 'fal' || task.customTaskId || protectedIds.has(task.id)) continue
      if (await claimTask(task.id)) claimed.push(task.id)
      else protectedIds.add(task.id)
    }
    if (!claimed.length) return tasks
    const current = await read()
    const claimedIds = new Set(claimed)
    // 只处理本轮拿到锁的任务，新出现的任务属于其他执行者。
    const keep = new Set(current.filter((task) => !claimedIds.has(task.id)).map((task) => task.id))
    const result = markInterruptedOpenAIRunningTasks(current, Date.now(), keep)
    await Promise.all(result.interruptedTasks.map((task) => write(task)))
    return result.tasks
  } finally {
    for (const id of claimed) releaseTask(id)
  }
}

export function observeTaskChanges(listener: () => void) {
  onChange = listener
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined' || channel) return
  channel = new BroadcastChannel(scopeStorageName('gip-task-changes'))
  channel.onmessage = () => onChange?.()
  window.addEventListener('pagehide', () => { for (const id of active.keys()) releaseTask(id) })
  window.addEventListener('focus', () => onChange?.())
}

export function notifyTaskChanges() {
  channel?.postMessage('changed')
}
