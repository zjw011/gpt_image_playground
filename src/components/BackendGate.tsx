import { useEffect, useState } from 'react'
import {
  requestEmailCode,
  readInviteFromUrl,
  submitFrontLogin,
  submitRegister,
  submitResetPassword,
  type BackendAccessMode,
  type BackendCredits,
  type BackendRegistration,
} from '../lib/backend'
import { syncWorkspaceId } from '../lib/workspace'

interface Props {
  title: string
  accessMode: BackendAccessMode
  /** 后台是否开放了自助注册。关着时连入口都不显示。 */
  registrationOpen: boolean
  /** 注册的详细可用状态：要不要邀请码、发信配好了没。 */
  registration: BackendRegistration
  credits: BackendCredits
  onUnlocked: () => void
}

type Mode = 'login' | 'register' | 'reset'

/** 邮箱格式的粗筛。真正的校验在服务端，这里只是别让用户白点一次"发送验证码"。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const MIN_PASSWORD_LENGTH = 6

/** 左侧品牌区的能力清单。文案说"能干什么"，不说技术细节。 */
const FEATURES = [
  { title: '一句话出图', detail: '描述你想要什么就行，支持参考图改图、批量生成。' },
  { title: '作品只属于你', detail: '历史记录保存在你自己的浏览器里，站方不存你的作品。' },
  { title: '多线路保障', detail: '后台配了多条生图通道，一条不稳会自动切换，你不用管。' },
]

/**
 * 前台门禁，同时也是这个平台的门面。
 *
 * 三种形态共用一个卡片：
 *   · 登录 —— 多用户模式用用户名 + 口令，共享口令模式只要口令。
 *   · 注册 —— 邮箱验证码 + 用户名 + 口令，可选邀请码。
 *   · 找回密码 —— 邮箱验证码 + 新口令。
 *
 * 宽屏上是左右分栏：左边讲"这是什么、值不值得注册"，右边是表单。
 * 窄屏上只留表单，品牌信息压成页头一行，避免用户一进来就要滚动才能看到输入框。
 */
export default function BackendGate({
  title,
  accessMode,
  registrationOpen,
  registration,
  credits,
  onUnlocked,
}: Props) {
  const accounts = accessMode === 'accounts'
  const invite = readInviteFromUrl()

  // 带着邀请链接进来的人本来就是要注册的，直接落在注册页，省一次点击。
  const [mode, setMode] = useState<Mode>(registrationOpen && invite ? 'register' : 'login')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState(invite)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [sending, setSending] = useState(false)
  /** 验证码重发倒计时（秒）。0 表示现在就能发。 */
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  const registering = mode === 'register'
  const resetting = mode === 'reset'
  // 注册和找回密码都需要邮箱验证码；发信没配好时注册入口要置灰。
  const needsEmail = registering || resetting
  const emailReady = !needsEmail || EMAIL_PATTERN.test(email.trim())
  const registrationUsable = registrationOpen && registration.emailVerification
  const bonus = credits.enabled ? credits.signupBonus : 0

  const canSubmit = Boolean(password.trim())
    && password.length >= (registering || resetting ? MIN_PASSWORD_LENGTH : 1)
    && (!accounts || registering || resetting || Boolean(username.trim()))
    && (!registering || Boolean(username.trim()))
    && (!needsEmail || (emailReady && code.trim().length === 6))
    && (!registering || !registration.requireInviteCode || Boolean(inviteCode.trim()))
    && !submitting

  const switchMode = (next: Mode) => {
    setMode(next)
    setError(null)
    setNotice(null)
    // 验证码跨用途不通用，切模式就把已填的码清掉，免得用户拿着注册码去重置密码。
    setCode('')
    setCooldown(0)
  }

  const sendCode = async () => {
    if (!emailReady || sending || cooldown > 0) return
    setSending(true)
    setError(null)
    setNotice(null)
    try {
      const result = await requestEmailCode({
        email: email.trim(),
        purpose: resetting ? 'reset' : 'register',
      })
      setCooldown(result.resendAfterSeconds ?? 60)
      setNotice(`验证码已发到 ${email.trim()}，请查收。没看到的话翻一下垃圾邮件。`)
    } catch (err) {
      // 服务端在 429 里带了"还要等多久"，直接用它的值，比自己猜一个准确。
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
    setNotice(null)
    try {
      if (resetting) {
        const result = await submitResetPassword({
          email: email.trim(),
          code: code.trim(),
          password,
        })
        // 重置成功不自动登录：让用户拿新口令再登一次，顺带确认新口令没记错。
        switchMode('login')
        setUsername(result.username)
        setNotice('密码已重设，请用新密码登录。')
        setSubmitting(false)
        return
      }

      const result = registering
        ? await submitRegister({
            username: username.trim(),
            password,
            email: email.trim(),
            code: code.trim(),
            inviteCode: inviteCode.trim(),
          })
        : await submitFrontLogin(accounts ? { username: username.trim(), password } : { password })

      // 先落工作区再刷新，省掉 App 启动时发现身份变化后的第二次刷新。
      syncWorkspaceId(typeof result.workspaceId === 'string' ? result.workspaceId : null)
      onUnlocked()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  const inputClass =
    'w-full rounded-xl border border-gray-200 bg-white px-3.5 py-3 text-sm text-gray-800 outline-none transition placeholder:text-gray-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:border-blue-500/60 dark:focus:ring-blue-500/10'

  const heading = resetting ? '重置密码' : registering ? '创建账号' : accounts ? '登录' : '输入访问口令'
  const description = resetting
    ? '输入注册时用的邮箱，我们把验证码发过去，验证后就能设置新密码。'
    : registering
      ? '注册需要验证邮箱，之后用这个邮箱对应的账号登录。'
      : accounts
        ? '用注册时的账号登录，你的作品只有自己能看到。'
        : '这个站点需要访问口令，请向管理员索取。'

  const switchLink =
    'text-xs text-gray-500 transition hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100'

  return (
    <div className="flex min-h-screen bg-gray-50 dark:bg-[#101114]">
      {/* 宽屏品牌区。窄屏隐藏，避免用户进来先滚一屏才看到表单。 */}
      <aside className="relative hidden w-[46%] max-w-[560px] flex-col justify-between overflow-hidden bg-gradient-to-br from-blue-600 via-blue-500 to-indigo-600 p-11 lg:flex">
        {/* 两个大光斑，纯装饰，不做交互。 */}
        <div className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-2xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-indigo-400/20 blur-3xl" />

        <div className="relative flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/15 text-xl font-semibold text-white ring-1 ring-inset ring-white/25 backdrop-blur">
            {title.slice(0, 1)}
          </span>
          <span className="text-lg font-semibold tracking-wide text-white">{title}</span>
        </div>

        <div className="relative mt-12">
          <h2 className="text-[26px] font-semibold leading-snug text-white">
            AI 图片创作工作台
          </h2>
          <p className="mt-3 text-sm leading-7 text-white/75">
            把想法写成一句话，剩下的交给 {title}。
          </p>

          <ul className="mt-9 space-y-5">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="flex gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/20 text-[11px] text-white">
                  ✓
                </span>
                <span>
                  <strong className="block text-sm font-medium text-white">{feature.title}</strong>
                  <span className="mt-1 block text-[13px] leading-6 text-white/65">{feature.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* 拉新钩子：只在后台确实在送积分时才说，不然就是骗人。 */}
        <div className="relative mt-12">
          {bonus > 0 ? (
            <div className="inline-flex items-baseline gap-2 rounded-2xl bg-white/15 px-5 py-3.5 ring-1 ring-inset ring-white/20 backdrop-blur">
              <span className="text-sm text-white/80">注册即送</span>
              <span className="text-2xl font-semibold text-white">{bonus}</span>
              <span className="text-sm text-white/80">积分</span>
            </div>
          ) : (
            <p className="text-xs leading-6 text-white/50">
              账号仅用于区分各自的生图记录，站方不收集你的作品。
            </p>
          )}
        </div>
      </aside>

      {/* 表单区 */}
      <main className="flex flex-1 items-center justify-center px-5 py-10">
        <div className="w-full max-w-[380px]">
          {/* 窄屏页头：品牌区藏起来之后，这里要补上"这是哪"。 */}
          <div className="mb-7 flex items-center gap-3 lg:hidden">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-lg font-semibold text-white">
              {title.slice(0, 1)}
            </span>
            <div>
              <strong className="block text-base font-semibold text-gray-800 dark:text-gray-100">{title}</strong>
              {bonus > 0 && (
                <span className="text-xs text-gray-500 dark:text-gray-400">注册即送 {bonus} 积分</span>
              )}
            </div>
          </div>

          <h1 className="text-[22px] font-semibold text-gray-900 dark:text-gray-50">{heading}</h1>
          <p className="mt-2 text-sm leading-6 text-gray-500 dark:text-gray-400">{description}</p>

          <form onSubmit={submit} className="mt-7">
            {needsEmail && (
              <>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-300">
                  邮箱
                  <input
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoFocus
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    className={`mt-1.5 ${inputClass}`}
                  />
                </label>

                <label className="mt-4 block text-xs font-medium text-gray-600 dark:text-gray-300">
                  验证码
                  <div className="mt-1.5 flex gap-2">
                    <input
                      value={code}
                      onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="6 位数字"
                      className={`flex-1 tracking-[0.35em] ${inputClass}`}
                    />
                    <button
                      type="button"
                      onClick={sendCode}
                      disabled={!emailReady || sending || cooldown > 0}
                      className="w-[104px] shrink-0 rounded-xl border border-gray-200 text-xs font-medium text-blue-600 transition hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400 disabled:hover:bg-transparent dark:border-white/10 dark:text-blue-400 dark:hover:border-blue-500/40 dark:hover:bg-blue-500/10 dark:disabled:border-white/10 dark:disabled:text-gray-500 dark:disabled:hover:bg-transparent"
                    >
                      {cooldown > 0 ? `${cooldown} 秒后重发` : sending ? '发送中…' : '获取验证码'}
                    </button>
                  </div>
                </label>

                {/* 发信没配好时说清"不是你的问题"，否则用户会反复检查自己的邮箱。 */}
                {!registration.emailVerification && registering && (
                  <p className="mt-3 rounded-xl bg-amber-50 px-3.5 py-2.5 text-xs leading-5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                    本站还没配置邮件发信，暂时没法注册。请联系管理员。
                  </p>
                )}
              </>
            )}

            {registering && (
              <label className="mt-4 block text-xs font-medium text-gray-600 dark:text-gray-300">
                用户名
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  placeholder="字母或数字开头，2-32 位"
                  className={`mt-1.5 ${inputClass}`}
                />
              </label>
            )}

            {!registering && !resetting && accounts && (
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300">
                用户名
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoFocus
                  autoComplete="username"
                  placeholder="用户名"
                  className={`mt-1.5 ${inputClass}`}
                />
              </label>
            )}

            <label
              className={`block text-xs font-medium text-gray-600 dark:text-gray-300 ${
                accounts || registering || resetting ? 'mt-4' : ''
              }`}
            >
              {resetting ? '新密码' : registering ? '设置密码' : '密码'}
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                autoComplete={registering || resetting ? 'new-password' : 'current-password'}
                autoFocus={!accounts && !registering && !resetting}
                placeholder={
                  registering || resetting
                    ? `至少 ${MIN_PASSWORD_LENGTH} 位`
                    : accounts
                      ? '登录密码'
                      : '访问口令'
                }
                className={`mt-1.5 ${inputClass}`}
              />
            </label>

            {registering && registration.requireInviteCode && (
              <label className="mt-4 block text-xs font-medium text-gray-600 dark:text-gray-300">
                邀请码
                <input
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value)}
                  placeholder="向管理员索取"
                  className={`mt-1.5 ${inputClass}`}
                />
              </label>
            )}

            {notice && (
              <p className="mt-4 rounded-xl bg-emerald-50 px-3.5 py-2.5 text-xs leading-5 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
                {notice}
              </p>
            )}
            {error && (
              <p className="mt-4 rounded-xl bg-red-50 px-3.5 py-2.5 text-xs leading-5 text-red-600 dark:bg-red-500/10 dark:text-red-400">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-6 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {submitting
                ? resetting
                  ? '提交中…'
                  : registering
                    ? '注册中…'
                    : '验证中…'
                : resetting
                  ? '重设密码'
                  : registering
                    ? '注册并进入'
                    : accounts
                      ? '登录'
                      : '进入'}
            </button>
          </form>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            {registrationUsable && !registering && !resetting && (
              <button type="button" onClick={() => switchMode('register')} className={switchLink}>
                还没有账号？注册一个
              </button>
            )}
            {registrationUsable && registering && (
              <button type="button" onClick={() => switchMode('login')} className={switchLink}>
                已经有账号了？去登录
              </button>
            )}
            {accounts && !registering && !resetting && (
              <button type="button" onClick={() => switchMode('reset')} className={switchLink}>
                忘记密码？
              </button>
            )}
            {resetting && (
              <button type="button" onClick={() => switchMode('login')} className={switchLink}>
                返回登录
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
