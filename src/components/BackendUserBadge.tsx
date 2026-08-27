import { useState } from 'react'
import { getBackendUser, submitFrontLogout } from '../lib/backend'
import { syncWorkspaceId } from '../lib/workspace'
import { LogoutIcon } from './icons'

/** 多用户模式下显示当前账号与退出入口；其他模式下不渲染。 */
export default function BackendUserBadge() {
  const user = getBackendUser()
  const [loggingOut, setLoggingOut] = useState(false)
  if (!user) return null

  const label = user.displayName || user.username

  return (
    <button
      onClick={async () => {
        if (loggingOut) return
        setLoggingOut(true)
        await submitFrontLogout()
        // 退回共享工作区，下一个登录的人不会读到这个账号的持久化状态。
        syncWorkspaceId(null)
        window.location.reload()
      }}
      title={`${label}（点击退出登录）`}
      className="group flex max-w-[9rem] shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-900 dark:hover:text-gray-200"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-[10px] font-semibold uppercase text-blue-600 dark:bg-blue-400/15 dark:text-blue-300">
        {label.slice(0, 1)}
      </span>
      <span className="hidden truncate sm:inline">{label}</span>
      <LogoutIcon className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  )
}
