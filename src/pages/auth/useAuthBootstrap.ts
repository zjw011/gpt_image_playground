// 认证页共用的 bootstrap：拉取站点访问模式 / 注册开关 / 积分配置。
// 返回 undefined = 加载中；null = 纯前端模式（无后端，直接去创作页）。
import { useEffect, useState } from 'react'
import { loadBackendBootstrap, type BackendBootstrap } from '../../lib/backend'

export function useAuthBootstrap() {
  const [data, setData] = useState<BackendBootstrap | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    loadBackendBootstrap()
      .then((result) => { if (alive) setData(result) })
      .catch(() => { if (alive) setData(null) })
    return () => { alive = false }
  }, [])
  return data
}

/** 登录成功后整页跳转创作页：工作区水合必须重来一次，沿用旧门禁的 reload 语义。 */
export function enterStudio() {
  window.location.assign(`${import.meta.env.BASE_URL}studio`)
}
