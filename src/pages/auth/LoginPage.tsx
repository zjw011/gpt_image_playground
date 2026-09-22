// 登录页。对应设计稿 3：账号密码登录 + 记住我 + 忘记密码 + 第三方登录入口。
import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { submitFrontLogin, getWechatConfig } from '../../lib/backend'
import { syncWorkspaceId } from '../../lib/workspace'
import AuthLayout from './AuthLayout'
import NoAccountSystemNotice from './NoAccountSystemNotice'
import { useAuthBootstrap, enterStudio } from './useAuthBootstrap'
import { TEXT_INPUT, PRIMARY_BTN, PageLoading } from '../theme'
import { IconEye, IconLock, IconUser, IconWechat } from '../icons'
import WechatGate from '../../components/WechatGate'

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
  const [wechatOpen, setWechatOpen] = useState(false)

  if (backend === undefined) return <PageLoading />
  // 没连后端：说清楚为什么没有登录，而不是把用户静默弹走
  if (!backend) return <NoAccountSystemNotice page="login" />
  // 开放模式 / 已登录：登录页没有意义，直接去创作页
  if (backend.accessMode === 'open' || backend.authenticated) {
    return <Navigate to="/studio" replace />
  }

  const accounts = backend.accessMode === 'accounts'
  const wechat = getWechatConfig()

  // 站点只开了微信扫码登录：整页就是二维码门禁
  if (backend.accessMode === 'wechat' && !wechatOpen) {
    return (
      <WechatGate
        title={backend.site.title}
        hasQrcodeImage={backend.wechat.hasQrcodeImage}
        onUnlocked={enterStudio}
      />
    )
  }

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
      enterStudio()
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
      title="欢迎回来"
      subtitle="继续使用 AI 创造美好"
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

        <button type="submit" disabled={!canSubmit} className={`${PRIMARY_BTN} mt-7 w-full !py-3.5`}>
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>

      {/* 第三方登录：微信没配置就整块不渲染，免得留一条空分隔线 */}
      {wechat?.enabled && (
        <div className="mt-8">
          <div className="flex items-center gap-3 text-xs text-[#b3aed0]">
            <span className="h-px flex-1 bg-[#e4e1f2]" />
            或使用以下方式登录
            <span className="h-px flex-1 bg-[#e4e1f2]" />
          </div>
          <div className="mt-4 flex justify-center gap-4">
            <button
              type="button"
              onClick={() => setWechatOpen(true)}
              title="微信登录"
              className="flex h-11 w-11 items-center justify-center rounded-full border border-[#e4e1f2] bg-white text-[#22c55e] shadow-sm transition hover:border-[#22c55e]/40 hover:shadow"
            >
              <IconWechat className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}

      {backend.registrationOpen && (
        <p className="mt-8 text-center text-[13px] text-[#8a86ac]">
          还没有账号？
          <Link to="/register" className="ml-1 font-semibold text-[#6b5ce7] transition hover:text-[#5a4cd6]">
            立即注册
          </Link>
        </p>
      )}

      {/* 微信扫码弹层（账号模式下作为第三方登录方式） */}
      {wechatOpen && (
        <div className="fixed inset-0 z-50 bg-[#3b2f6b]/40 backdrop-blur-sm" onClick={() => setWechatOpen(false)}>
          <div className="h-full" onClick={(event) => event.stopPropagation()}>
            <WechatGate
              title={backend.site.title}
              hasQrcodeImage={Boolean(wechat?.hasQrcodeImage)}
              onUnlocked={enterStudio}
            />
          </div>
        </div>
      )}
    </AuthLayout>
  )
}
