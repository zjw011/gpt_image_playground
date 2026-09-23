// 找回密码页。对应设计稿 4：邮箱验证码 + 新密码，成功后回登录页。
import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { requestEmailCode, submitResetPassword } from '../../lib/backend'
import AuthLayout from './AuthLayout'
import NoAccountSystemNotice from './NoAccountSystemNotice'
import { useAuthBootstrap } from './useAuthBootstrap'
import { TEXT_INPUT, PRIMARY_BTN, PageLoading } from '../theme'
import { IconArrowLeft, IconLock, IconMail, IconEye } from '../icons'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD_LENGTH = 6

export default function ForgotPasswordPage() {
  const backend = useAuthBootstrap()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [sending, setSending] = useState(false)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  if (backend === undefined) return <PageLoading />
  // 没连后端：说清楚为什么没有找回密码，而不是把用户静默弹走
  if (!backend) return <NoAccountSystemNotice page="forgot" />
  if (backend.accessMode === 'open' || backend.authenticated) {
    return <Navigate to="/studio" replace />
  }

  const emailReady = EMAIL_PATTERN.test(email.trim())
  // 找回密码本质是改邮箱账号的密码：本站不是账号密码登录，或者邮件发信没配好，
  // 这条路都走不通——先说清楚，别让用户填完一整张表才被后端拒。
  const noPasswordAccount = backend.accessMode !== 'accounts'
  const blocked = noPasswordAccount || !backend.registration.emailVerification
  const canSubmit = emailReady && code.trim().length === 6 && password.length >= MIN_PASSWORD_LENGTH && !blocked && !submitting

  const sendCode = async () => {
    if (!emailReady || sending || cooldown > 0 || blocked) return
    setSending(true)
    setError(null)
    setNotice(null)
    try {
      const result = await requestEmailCode({ email: email.trim(), purpose: 'reset' })
      setCooldown(result.resendAfterSeconds ?? 60)
      setNotice(`验证码已发到 ${email.trim()}，请查收。`)
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
      await submitResetPassword({ email: email.trim(), code: code.trim(), password })
      // 不自动登录：让用户拿新密码再登一次，顺带确认没记错
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout
      image="/art/auth-forgot.jpg"
      quote="别担心，你的创作不会丢失"
      quoteSub="Don't worry, your creations are safe."
      title="找回密码"
      subtitle="我们会发验证码到你的邮箱，验证后即可重设密码"
    >
      {done ? (
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-6 text-center">
          <p className="text-[15px] font-semibold text-emerald-700">密码已重设成功</p>
          <p className="mt-2 text-[13px] text-emerald-600/80">请使用新密码登录你的账号。</p>
          <Link to="/login" className={`${PRIMARY_BTN} mt-6 w-full !py-3`}>
            返回登录
          </Link>
        </div>
      ) : (
        <form onSubmit={submit}>
          {blocked && (
            <p className="mb-5 rounded-xl bg-amber-50 px-4 py-3 text-[12.5px] leading-5 text-amber-700">
              {noPasswordAccount
                ? '本站不是用邮箱密码登录的，没有可重置的密码。回到登录页按当前方式进入即可。'
                : '本站的邮件发信还没配置好，验证码暂时发不出去，找回密码走不通。'}
              <br />
              <span className="text-amber-600/80">
                {noPasswordAccount
                  ? '如果这是误判，请联系站点管理员确认登录方式。'
                  : '如果你是管理员：到后台「邮件发信」填好邮箱授权码，这里就能用了。'}
              </span>
            </p>
          )}

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
              placeholder="请输入注册时用的邮箱"
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

          <label className="mt-5 block">
            <span className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-[#5b5680]">
              <IconLock className="h-4 w-4 text-[#a5a1c4]" />
              新密码
            </span>
            <div className="relative">
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                disabled={blocked}
                placeholder={`请设置新密码（${MIN_PASSWORD_LENGTH}-20位）`}
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

          {notice && <p className="mt-5 rounded-xl bg-emerald-50 px-4 py-3 text-[12.5px] leading-5 text-emerald-700">{notice}</p>}
          {error && <p className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-[12.5px] leading-5 text-red-600">{error}</p>}

          <button type="submit" disabled={!canSubmit} className={`${PRIMARY_BTN} mt-7 w-full !py-3.5`}>
            {submitting ? '提交中…' : '重设密码'}
          </button>
        </form>
      )}

      <p className="mt-8 text-center">
        <Link to="/login" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#8a86ac] transition hover:text-[#6b5ce7]">
          <IconArrowLeft className="h-4 w-4" />
          返回登录
        </Link>
      </p>
    </AuthLayout>
  )
}
