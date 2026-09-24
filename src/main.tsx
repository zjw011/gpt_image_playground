import 'core-js/actual/array/at'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { router } from './router'
import 'streamdown/styles.css'
import 'katex/dist/katex.min.css'
import './index.css'
import { installMobileViewportGuards } from './lib/viewport'
import { installCreditsSync } from './lib/creditsSync'
import { captureInviteRef } from './lib/backend'
import ErrorBoundary from './components/ErrorBoundary'

installMobileViewportGuards()
// 进站先抓一次邀请链接里的 ref：注册页、登录页都不在 App 组件分支下，
// 放 App 里会漏掉这些入口，而它们恰恰是被邀请人最可能落地的页面。
captureInviteRef()
// 进站先抓一次邀请链接里的 ref：注册页、登录页都不在 App 组件分支下，
// 放 App 里会漏掉这些入口，而它们恰恰是被邀请人最可能落地的页面。
captureInviteRef()
// 必须在任何出图请求之前装好：它靠响应头里的余额回执来实时刷新顶栏数字。
// 纯静态部署下这段代码也在包里，但没有中继请求，自然什么都不做。
installCreditsSync()

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error) => {
        console.error('Service worker registration failed:', error)
      })
    })
  } else {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister())
    })
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  </StrictMode>,
)
