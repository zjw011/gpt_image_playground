// 顶层错误边界。
//
// 一个组件渲染时抛异常，React 会把整棵树卸载——用户看到的是纯白页面，
// 连"发生了什么"都没有。生产站点必须有兜底：把异常拦在这一层，
// 给一张能看懂的卡片 + 两个出口（刷新 / 回首页），并把错误打到控制台备查。
import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { useRouteError } from 'react-router-dom'

interface Props { children: ReactNode }
interface State { error: Error | null }

function ErrorFallback({ error }: { error: Error }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f5f4fb] p-6">
      <div className="w-full max-w-md rounded-3xl border border-[#eceaf6] bg-white p-8 text-center shadow-sm">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#efedfd] text-2xl">😵</span>
        <h1 className="mt-5 text-lg font-bold text-[#37335c]">页面出了点问题</h1>
        <p className="mt-2 text-[13px] leading-6 text-[#8a86ac]">
          抱歉，这个页面没能正常显示。你的作品数据都还在，刷新一下通常就好了。
        </p>
        {import.meta.env.DEV && (
          <pre className="mt-4 max-h-24 overflow-auto rounded-xl bg-[#faf9fe] px-3 py-2 text-left text-[11px] leading-5 text-[#a5a1c4]">
            {error.message}
          </pre>
        )}
        <div className="mt-6 flex justify-center gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-full bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-[#7c6cf6]/25 transition hover:from-[#6b5ce7] hover:to-[#9678f5]"
          >
            刷新页面
          </button>
          <button
            type="button"
            onClick={() => { window.location.assign(import.meta.env.BASE_URL) }}
            className="rounded-full border border-[#dcd8f0] px-6 py-2.5 text-sm font-medium text-[#6f6a94] transition hover:border-[#7c6cf6] hover:text-[#7c6cf6]"
          >
            回到首页
          </button>
        </div>
      </div>
    </div>
  )
}

export function RouteErrorBoundary() {
  const caught = useRouteError()
  const error = caught instanceof Error ? caught : new Error('页面加载失败，请刷新后重试')

  useEffect(() => {
    console.error('[绘想] 路由渲染出错：', caught)
  }, [caught])

  return <ErrorFallback error={error} />
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 保留 componentStack：线上排查时它比一行 message 有用得多
    console.error('[绘想] 界面渲染出错：', error, info.componentStack)
  }

  render() {
    const error = this.state.error
    if (!error) return this.props.children
    return <ErrorFallback error={error} />
  }
}
