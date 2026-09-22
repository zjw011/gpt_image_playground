// 绘想路由表。公开页（首页/登录/注册/价格/帮助）不进 App 引导流程；
// /studio 等应用页由 App 组件统一做 bootstrap（工作区水合 + 登录门禁）。
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom'
import { resolveRouterBasename } from './lib/routerBasename'
import App from './App'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/auth/LoginPage'
import RegisterPage from './pages/auth/RegisterPage'
import ForgotPasswordPage from './pages/auth/ForgotPasswordPage'
import PricingPage from './pages/PricingPage'
import HelpPage from './pages/HelpPage'
import StudioPage from './pages/app/StudioPage'
import ResultPage from './pages/app/ResultPage'
import GalleryPage from './pages/app/GalleryPage'
import MePage from './pages/app/MePage'
import RechargePage from './pages/app/RechargePage'

// vite.config 里 base 是 './'（构建产物要能塞进任意子路径），但 react-router 不接受相对 basename：
// 传 './' 会导致整张路由表一条都匹配不上，表现是整站空白、点任何按钮都"没反应"。
export const ROUTER_BASENAME = resolveRouterBasename(import.meta.env.BASE_URL)

export const routes: RouteObject[] = [
  { path: '/', element: <LandingPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  { path: '/forgot', element: <ForgotPasswordPage /> },
  { path: '/pricing', element: <PricingPage /> },
  { path: '/help', element: <HelpPage /> },
  {
    element: <App />,
    children: [
      { path: '/studio', element: <StudioPage /> },
      { path: '/studio/result', element: <ResultPage /> },
      { path: '/gallery', element: <GalleryPage /> },
      { path: '/me', element: <MePage /> },
      { path: '/recharge', element: <RechargePage /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]

export const router = createBrowserRouter(routes, { basename: ROUTER_BASENAME })
