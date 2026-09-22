// 判断访问者现在是不是「已经进入应用」的状态。
// 口径与 App 组件的门禁保持一致：没有后端（纯前端模式）、开放模式、已登录，都算已进入；
// 这样帮助中心／价格页在应用里点开就是应用外壳，在外面点开就是公开页外壳，不会互相踢。
import { useAuthBootstrap } from './auth/useAuthBootstrap'

export function useInApp() {
  const backend = useAuthBootstrap()
  if (backend === undefined) return undefined
  return backend === null || backend.accessMode === 'open' || backend.authenticated
}
