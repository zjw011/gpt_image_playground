// 引导失败页：站点在更新（容器重建）或服务器暂时不可达时显示。
//
// 为什么不能像以前那样"静默退回纯前端模式"：
// 那会让用户看到一个没有渠道、还多出「设置」入口的空壳，
// 以为自己的数据全丢了。宁可明确告诉他"正在更新/连不上，稍后重试"。
import { useEffect, useState } from 'react'

export default function BootstrapError({ message }: { message: string }) {
  const [countdown, setCountdown] = useState(8)

  // 自动重试一次：部署窗口通常只有几秒，用户什么都不用做就能恢复
  useEffect(() => {
    if (countdown <= 0) return
    const timer = setTimeout(() => setCountdown((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [countdown])

  useEffect(() => {
    if (countdown === 0) window.location.reload()
  }, [countdown])

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f5f4fb] p-6">
      <div className="w-full max-w-md rounded-3xl border border-[#eceaf6] bg-white p-8 text-center shadow-sm">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#efedfd] text-2xl">🛠️</span>
        <h1 className="mt-5 text-lg font-bold text-[#37335c]">站点正在更新，请稍候</h1>
        <p className="mt-2 text-[13px] leading-6 text-[#8a86ac]">
          服务器暂时没能响应（{message}）。这通常是我们在发布新版本，几秒后就会恢复。
        </p>
        <p className="mt-1 text-[13px] text-[#a5a1c4]">
          {countdown > 0 ? `${countdown} 秒后自动重试…` : '正在重试…'}
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-full bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-[#7c6cf6]/25 transition hover:from-[#6b5ce7] hover:to-[#9678f5]"
          >
            立即重试
          </button>
        </div>
        <p className="mt-5 text-[12px] text-[#b3aed0]">你上传和生成的作品都保存在本机浏览器里，不会因为这次更新丢失。</p>
      </div>
    </div>
  )
}
