// 绘想路由表。公开页（首页/登录/注册/价格/帮助）不进 App 引导流程；
// /studio 等应用页由 App 组件统一做 bootstrap（工作区水合 + 登录门禁）。
import type { ComponentType } from 'react'
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom'
import { RouteErrorBoundary } from './components/ErrorBoundary'
import { resolveRouterBasename } from './lib/routerBasename'

const lazyPage = (load: () => Promise<{ default: ComponentType }>) => async () => ({ Component: (await load()).default })

// vite.config 里 base 是 './'（构建产物要能塞进任意子路径），但 react-router 不接受相对 basename：
// 传 './' 会导致整张路由表一条都匹配不上，表现是整站空白、点任何按钮都"没反应"。
export const ROUTER_BASENAME = resolveRouterBasename(import.meta.env.BASE_URL)

export const routes: RouteObject[] = [
  {
    errorElement: <RouteErrorBoundary />,
    children: [
      { path: '/', lazy: lazyPage(() => import('./pages/LandingPage')) },
      { path: '/login', lazy: lazyPage(() => import('./pages/auth/LoginPage')) },
      { path: '/register', lazy: lazyPage(() => import('./pages/auth/RegisterPage')) },
      { path: '/forgot', lazy: lazyPage(() => import('./pages/auth/ForgotPasswordPage')) },
      { path: '/pricing', lazy: lazyPage(() => import('./pages/PricingPage')) },
      { path: '/help', lazy: lazyPage(() => import('./pages/HelpPage')) },
      {
        lazy: lazyPage(() => import('./App')),
        children: [
          { path: '/studio', lazy: lazyPage(() => import('./pages/app/StudioPage')) },
          // 注意：结果页必须是单层路径。多层路径（/studio/result）在当前 base:'./' 的
          // 产物下会把 ./assets/xxx.js 解析到 /studio/assets/xxx.js，刷新即白屏。
          { path: '/result', lazy: lazyPage(() => import('./pages/app/ResultPage')) },
          { path: '/gallery', lazy: lazyPage(() => import('./pages/app/GalleryPage')) },
          { path: '/me', lazy: lazyPage(() => import('./pages/app/MePage')) },
          { path: '/recharge', lazy: lazyPage(() => import('./pages/app/RechargePage')) },
        ],
      },
      // 管理后台：跟前台共用同一次登录，AdminGuard 按会话里的 role 放行。
      // 不做成 App 的子路由——后台没有前台那套登录门禁，它有自己的守卫。
      // 分区走 ?tab=（见 AdminApp 顶部的说明：子路径会在刷新时白屏）。
      {
        path: '/admin',
        lazy: lazyPage(() => import('./pages/admin/AdminGuard')),
        children: [{ index: true, lazy: lazyPage(() => import('./pages/admin/AdminApp')) }],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]

export const router = createBrowserRouter(routes, { basename: ROUTER_BASENAME })
