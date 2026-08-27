// 工作区隔离：多用户模式下每个账号一份独立的本地仓库（localStorage + IndexedDB）。
//
// persist 中间件在 store.ts 导入时就同步读取 localStorage，所以工作区必须在那之前确定。
// 办法是把它缓存在一个固定的 localStorage 键里：页面一加载就能同步读到，
// 拿到 /api/bootstrap 的结果后若发现身份变了，再刷新页面重新走一遍。

const WORKSPACE_CACHE_KEY = 'gpt-image-playground-workspace'
const SHARED_WORKSPACE_ID = 'shared'

/** 共享工作区沿用原来的无后缀命名，保证老用户升级后数据不丢。 */
function readCachedWorkspaceId() {
  try {
    const raw = localStorage.getItem(WORKSPACE_CACHE_KEY)
    return raw && /^[a-zA-Z0-9_.-]{1,64}$/.test(raw) ? raw : SHARED_WORKSPACE_ID
  } catch {
    return SHARED_WORKSPACE_ID
  }
}

let workspaceId = typeof localStorage === 'undefined' ? SHARED_WORKSPACE_ID : readCachedWorkspaceId()

export function getWorkspaceId() {
  return workspaceId
}

export function isSharedWorkspace() {
  return workspaceId === SHARED_WORKSPACE_ID
}

/** 给存储名加上工作区后缀。共享工作区返回原名，避免迁移。 */
export function scopeStorageName(base: string) {
  return workspaceId === SHARED_WORKSPACE_ID ? base : `${base}--${workspaceId}`
}

/**
 * 对齐服务端下发的工作区。
 * 返回 true 表示身份变了、调用方应当刷新页面——因为 store 已经用旧工作区的数据水合过了。
 */
export function syncWorkspaceId(nextId: string | null | undefined) {
  const next = nextId && /^[a-zA-Z0-9_.-]{1,64}$/.test(nextId) ? nextId : SHARED_WORKSPACE_ID
  if (next === workspaceId) return false

  workspaceId = next
  try {
    if (next === SHARED_WORKSPACE_ID) localStorage.removeItem(WORKSPACE_CACHE_KEY)
    else localStorage.setItem(WORKSPACE_CACHE_KEY, next)
  } catch {
    // 写不进去就绝对不能刷新：刷新后读回的还是旧值，会陷入刷新死循环。
    // 这种环境（隐私模式）下 localStorage 本来就不可用，本次会话内 IndexedDB 仍按新工作区隔离。
    return false
  }
  return true
}
