// 登录页。对应设计稿 3：账号密码登录 + 记住我 + 忘记密码 + 第三方登录入口。
// 微信登录尚未对接（公众号/小程序都还没有），所以这里只保留入口并标注「开发中」。
import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { submitFrontLogin } from '../../lib/backend'
import { syncWorkspaceId } from '../../lib/workspace'
import AuthLayout from './AuthLayout'
import NoAccountSystemNotice, { WechatLoginUnavailable } from './NoAccountSystemNotice'
import { useAuthBootstrap } from './useAuthBootstrap'
import { TEXT_INPUT, PRIMARY_BTN, PageLoading } from '../theme'
import { IconEye, IconLock, IconUser, IconWechat } from '../icons'

const REMEMBER_KEY = 'huixiang.rememberedName'

export default function LoginPage() {
  const backend = useAuthBootstrap()
  const [username, setUsername] = useState(() => localStorage.getItem(REMEMBER_KEY) ?? '')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(() => Boolean(localStorage.getItem(REMEMBER_KEY)))
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [wechatTip, setWechatTip] = useState(false)

  if (backend === undefined) return <PageLoading />
  // 没连后端：说清楚为什么没有登录，而不是把用户静默弹走
  if (!backend) return <NoAccountSystemNotice page="login" />
  // 已经登录（bootstrap 里带着用户）：登录页没有意义，按角色送回该去的地方。
  // 注意判的是"有没有用户"，不是 authenticated——开放模式下 authenticated 恒为 true，
  // 拿它当条件会让站长在这一页永远看不到登录表单，也就永远进不去后台。
  if (backend.user) {
    return <Navigate to={backend.user.role === 'admin' ? '/admin' : '/studio'} replace />
  }

  const openMode = backend.accessMode === 'open'
  // 账号登录在任何访问方式下都成立：访问方式决定"要不要身份"，不决定"能不能登录"。
  // 开放模式下这一页就是站长登录入口（普通用户直接去创作，不需要账号）。
  const accounts = backend.accessMode === 'accounts' || openMode

  // 站点被配成「微信扫码」但微信登录还没上线：别给一个永远扫不开的二维码。
  if (backend.accessMode === 'wechat') return <WechatLoginUnavailable />

  const canSubmit = Boolean(password.trim()) && (!accounts || Boolean(username.trim())) && !submitting

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await submitFrontLogin(accounts ? { username: username.trim(), password } : { password })
      if (accounts) {
        if (remember) localStorage.setItem(REMEMBER_KEY, username.trim())
        else localStorage.removeItem(REMEMBER_KEY)
      }
      syncWorkspaceId(typeof result.workspaceId === 'string' ? result.workspaceId : null)
      // 管理员账号登录后直接进管理后台，普通用户进创作页。
      const isAdminUser = result.user && result.user.role === 'admin'
      window.location.assign(`${import.meta.env.BASE_URL}${isAdminUser ? 'admin' : 'studio'}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout
      image="/art/auth-login.jpg"
      quote="灵感，从这里开始"
      quoteSub="Every idea starts here."
      title={openMode ? '站长登录' : '欢迎回来'}
      subtitle={openMode ? '站点当前开放访问，用账号登录可进入管理后台' : '继续使用 AI 创造美好'}
    >
      <form onSubmit={submit}>
        {accounts && (
          <label className="block">
            <span className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-[#5b5680]">
              <IconUser className="h-4 w-4 text-[#a5a1c4]" />
              用户名
            </span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoFocus
              placeholder="请输入用户名"
              className={TEXT_INPUT}
            />
          </label>
        )}

        <label className={`block ${accounts ? 'mt-5' : ''}`}>
          <span className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-[#5b5680]">
            <IconLock className="h-4 w-4 text-[#a5a1c4]" />
            密码
          </span>
          <div className="relative">
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              autoFocus={!accounts}
              placeholder={accounts ? '请输入密码' : '请输入访问口令'}
              className={`${TEXT_INPUT} pr-11`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className={`absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 transition ${showPassword ? 'text-[#7c6cf6]' : 'text-[#a5a1c4] hover:text-[#6f6a94]'}`}
              title={showPassword ? '隐藏密码' : '显示密码'}
            >
              <IconEye className="h-[18px] w-[18px]" />
            </button>
          </div>
        </label>

        {accounts && (
          <div className="mt-4 flex items-center justify-between text-[13px]">
            <label className="flex cursor-pointer items-center gap-2 text-[#6f6a94]">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                className="h-4 w-4 rounded border-[#dcd8f0] accent-[#7c6cf6]"
              />
              记住我
            </label>
            <Link to="/forgot" className="font-medium text-[#6b5ce7] transition hover:text-[#5a4cd6]">
              忘记密码？
            </Link>
          </div>
        )}

        {notice && <p className="mt-5 rounded-xl bg-emerald-50 px-4 py-3 text-[12.5px] leading-5 text-emerald-700">{notice}</p>}
        {error && <p className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-[12.5px] leading-5 text-red-600">{error}</p>}

        {openMode && (
          <p className="mt-5 rounded-xl bg-[#f4f2fe] px-4 py-3 text-[12.5px] leading-5 text-[#5b5680]">
            本站当前开放访问，任何人都可以直接创作，不需要账号。
            <Link to="/studio" className="ml-1 font-semibold text-[#6b5ce7] transition hover:text-[#5a4cd6]">
              直接开始创作 →
            </Link>
          </p>
        )}

        <button type="submit" disabled={!canSubmit} className={`${PRIMARY_BTN} mt-7 w-full !py-3.5`}>
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>

      {/* 第三方登录：微信还没对接，保留入口并标注「开发中」，点击给出说明而不是静默无反应 */}
      <div className="mt-8">
        <div className="flex items-center gap-3 text-xs text-[#b3aed0]">
          <span className="h-px flex-1 bg-[#e4e1f2]" />
          或使用以下方式登录
          <span className="h-px flex-1 bg-[#e4e1f2]" />
        </div>
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => setWechatTip((value) => !value)}
            title="微信登录（开发中）"
            className="relative flex h-11 w-11 items-center justify-center rounded-full border border-[#e4e1f2] bg-white text-[#22c55e]/60 shadow-sm transition hover:border-[#22c55e]/40 hover:text-[#22c55e]"
          >
            <IconWechat className="h-5 w-5" />
            <span className="absolute -right-1.5 -top-1.5 rounded-full bg-[#fff7ed] px-1.5 py-0.5 text-[10px] font-medium leading-none text-[#ea580c] ring-2 ring-white">
              开发中
            </span>
          </button>
        </div>
        {wechatTip && (
          <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-center text-[12.5px] leading-5 text-amber-700">
            微信登录还在开发中，暂时用不了。当前请用用户名 + 密码登录，没有账号的话先去注册。
          </p>
        )}
      </div>

      {backend.registrationOpen ? (
        <p className="mt-8 text-center text-[13px] text-[#8a86ac]">
          还没有账号？
          <Link to="/register" className="ml-1 font-semibold text-[#6b5ce7] transition hover:text-[#5a4cd6]">
            立即注册
          </Link>
        </p>
      ) : accounts ? (
        // 注册开关没开时不显示链接，但也不能什么都不说——否则看起来像"功能丢了"。
        <p className="mt-8 text-center text-[13px] text-[#8a86ac]">
          本站暂未开放自助注册，如需账号请联系站长开通。
        </p>
      ) : null}
    </AuthLayout>
  )
}
