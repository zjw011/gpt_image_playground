// 管理后台的角色守卫。
// /admin 已并入主前端：同一个登录入口，靠会话里的 role 决定能看到前台还是后台。
// 三层判断：还没拉到 bootstrap → 转圈；拉不到后端 → 说明现状；登录了但不是管理员 → 赶回创作页。
import { useEffect, useState } from 'react'
import { Link, Navigate, Outlet } from 'react-router-dom'
import { getBackendUser, isAdmin, loadBackendBootstrap } from '../../lib/backend'
import { GHOST_BTN } from '../theme'
import { IconShield } from '../icons'

type State = 'loading' | 'ready' | 'no-backend'

export default function AdminGuard() {
  const [state, setState] = useState<State>('loading')

  useEffect(() => {
    let alive = true
    loadBackendBootstrap()
      .then((result) => { if (alive) setState(result ? 'ready' : 'no-backend') })
      .catch(() => { if (alive) setState('no-backend') })
    return () => { alive = false }
  }, [])

  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f6f8fb] text-sm text-[#94a3b8]">
        正在校验管理员身份…
      </div>
    )
  }

  if (state === 'no-backend') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f6f8fb] px-6">
        <div className="w-full max-w-md rounded-2xl border border-[#e6ebf2] bg-white p-7 text-center shadow-sm">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[#eff6ff] text-[#2563eb]">
            <IconShield className="h-6 w-6" />
          </span>
          <h1 className="mt-4 text-lg font-bold text-[#1e293b]">后台需要后端服务</h1>
          <p className="mt-2 text-sm leading-6 text-[#64748b]">
            当前没有连接后端，渠道、用户、积分这些数据没有地方存。先启动后端再进来。
          </p>
          <div className="mt-6 flex justify-center">
            <Link to="/" className={GHOST_BTN}>返回首页</Link>
          </div>
        </div>
      </div>
    )
  }

  // 登录了但不是管理员：后台数据一律不给看，直接送回创作页。
  if (!isAdmin()) {
    const user = getBackendUser()
    return user ? <Navigate to="/studio" replace /> : <Navigate to="/login" replace />
  }

  return <Outlet />
}
