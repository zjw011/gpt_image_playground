// 注册页。对应设计稿 2：邮箱验证码 + 用户名 + 密码 + 协议勾选，可选邀请码。
import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { requestEmailCode, submitRegister, readInviteFromUrl } from '../../lib/backend'
import { syncWorkspaceId } from '../../lib/workspace'
import AuthLayout from './AuthLayout'
import NoAccountSystemNotice from './NoAccountSystemNotice'
import { useAuthBootstrap, enterStudio } from './useAuthBootstrap'
import { TEXT_INPUT, PRIMARY_BTN, PageLoading } from '../theme'
import { IconMail, IconLock, IconUser, IconEye } from '../icons'

/** 邮箱格式粗筛，真正的校验在服务端 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD_LENGTH = 6

export default function RegisterPage() {
  const backend = useAuthBootstrap()
  const invite = readInviteFromUrl()

  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [inviteCode, setInviteCode] = useState(invite)
  const [agreed, setAgreed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [sending, setSending] = useState(false)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  if (backend === undefined) return <PageLoading />
  // 没连后端：说清楚为什么没有注册，而不是把用户静默弹走
  if (!backend) return <NoAccountSystemNotice page="register" />
  if (backend.accessMode === 'open' || backend.authenticated) {
    return <Navigate to="/studio" replace />
  }
  // 站点没开自助注册：回登录页，那里看得到现状说明
  if (!backend.registrationOpen) return <Navigate to="/login" replace />

  const registration = backend.registration
  const bonus = backend.credits.enabled ? backend.credits.signupBonus : 0
  const emailReady = EMAIL_PATTERN.test(email.trim())
  /** 开关开着但发信没配好：说明卡点，别让用户干等验证码 */
  const blocked = !registration.emailVerification

  const canSubmit = emailReady
    && code.trim().length === 6
    && Boolean(username.trim())
    && password.length >= MIN_PASSWORD_LENGTH
    && (!registration.requireInviteCode || Boolean(inviteCode.trim()))
    && agreed
    && !blocked
    && !submitting

  const sendCode = async () => {
    if (!emailReady || sending || cooldown > 0 || blocked) return
    setSending(true)
    setError(null)
    setNotice(null)
    try {
      const result = await requestEmailCode({ email: email.trim(), purpose: 'register' })
      setCooldown(result.resendAfterSeconds ?? 60)
      setNotice(`验证码已发到 ${email.trim()}，请查收。没看到的话翻一下垃圾邮件。`)
    } catch (err) {
      const retryAfter = (err as { retryAfterSeconds?: number }).retryAfterSeconds
      if (typeof retryAfter === 'number' && retryAfter > 0) setCooldown(retryAfter)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await submitRegister({
        username: username.trim(),
        password,
        email: email.trim(),
        code: code.trim(),
        inviteCode: inviteCode.trim(),
      })
      syncWorkspaceId(typeof result.workspaceId === 'string' ? result.workspaceId : null)
      enterStudio()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout
      image="/art/auth-register.jpg"
      quote="每一个想象，都值得被看见"
      quoteSub="Every imagination deserves to be seen."
      title="开启你的 AI 创作之旅"
      subtitle={bonus > 0 ? `注册即送 ${bonus} 积分，第一张图免费画` : '邮箱收个验证码就能开通，一分钟搞定'}
    >
      <form onSubmit={submit}>
        <label className="block">
          <span className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-[#5b5680]">
            <IconMail className="h-4 w-4 text-[#a5a1c4]" />
            邮箱
          </span>
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            disabled={blocked}
            placeholder="请输入邮箱地址"
            className={TEXT_INPUT}
          />
        </label>

        <label className="mt-5 block">
          <span className="mb-2 block text-[13px] font-medium text-[#5b5680]">验证码</span>
          <div className="flex gap-2.5">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              disabled={blocked}
              placeholder="6 位数字"
              className={`${TEXT_INPUT} flex-1 tracking-[0.3em] placeholder:tracking-normal`}
            />
            <button
              type="button"
              onClick={sendCode}
              disabled={!emailReady || sending || cooldown > 0 || blocked}
              className="w-[112px] shrink-0 rounded-xl border border-[#dcd8f0] text-[13px] font-medium text-[#6b5ce7] transition hover:border-[#7c6cf6] hover:bg-[#f4f2fe] disabled:cursor-not-allowed disabled:border-[#eceaf6] disabled:bg-[#faf9fe] disabled:text-[#b3aed0]"
            >
              {cooldown > 0 ? `${cooldown} 秒后重发` : sending ? '发送中…' : '获取验证码'}
            </button>
          </div>
        </label>

        {blocked && (
          <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-[12.5px] leading-5 text-amber-700">
            本站的邮件发信还没配置好，验证码暂时发不出去，注册走不通。
            <br />
            <span className="text-amber-600/80">如果你是管理员：到后台「邮件发信」填好邮箱授权码，这里就能用了。</span>
          </p>
        )}

        <label className="mt-5 block">
          <span className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-[#5b5680]">
            <IconUser className="h-4 w-4 text-[#a5a1c4]" />
            用户名
          </span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            disabled={blocked}
            placeholder="字母或数字开头，2-32 位"
            className={TEXT_INPUT}
          />
        </label>

        <label className="mt-5 block">
          <span className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-[#5b5680]">
            <IconLock className="h-4 w-4 text-[#a5a1c4]" />
            设置密码
          </span>
          <div className="relative">
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              disabled={blocked}
              placeholder={`请设置密码（${MIN_PASSWORD_LENGTH}-20位）`}
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

        {registration.requireInviteCode && (
          <label className="mt-5 block">
            <span className="mb-2 block text-[13px] font-medium text-[#5b5680]">邀请码</span>
            <input
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
              disabled={blocked}
              placeholder="向管理员索取"
              className={TEXT_INPUT}
            />
          </label>
        )}

        <label className="mt-5 flex cursor-pointer items-start gap-2 text-[12.5px] leading-5 text-[#8a86ac]">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(event) => setAgreed(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-[#dcd8f0] accent-[#7c6cf6]"
          />
          <span>
            我已阅读并同意
            <span className="font-medium text-[#6b5ce7]">《用户协议》</span>和
            <span className="font-medium text-[#6b5ce7]">《隐私政策》</span>
          </span>
        </label>

        {notice && <p className="mt-5 rounded-xl bg-emerald-50 px-4 py-3 text-[12.5px] leading-5 text-emerald-700">{notice}</p>}
        {error && <p className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-[12.5px] leading-5 text-red-600">{error}</p>}

        <button type="submit" disabled={!canSubmit} className={`${PRIMARY_BTN} mt-7 w-full !py-3.5`}>
          {submitting ? '注册中…' : '注册'}
        </button>
      </form>

      <p className="mt-8 text-center text-[13px] text-[#8a86ac]">
        已有账号？
        <Link to="/login" className="ml-1 font-semibold text-[#6b5ce7] transition hover:text-[#5a4cd6]">
          立即登录
        </Link>
      </p>
    </AuthLayout>
  )
}
