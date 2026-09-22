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
  /** 已启用的账号数。够多才拿出来当社会认同，太少反而是反效果。 */
  userCount: number
  onUnlocked: () => void
}

type Mode = 'login' | 'register' | 'reset'

/** 邮箱格式的粗筛。真正的校验在服务端，这里只是别让用户白点一次"发送验证码"。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const MIN_PASSWORD_LENGTH = 6

/**
 * 社会认同只在人数过得去时才说。写"已有 2 位创作者加入"比不写更劝退，
 * 所以这里设了个下限——宁可少一句文案，不要给人"这站没人用"的第一印象。
 */
const SOCIAL_PROOF_MIN_USERS = 10

/**
 * 左侧品牌区的能力清单。
 * 每条的前半句是用户能拿到的结果，后半句才是支撑它的事实——先讲收益，再讲原理。
 * 图标用一次性内联 SVG：只有 4 个、形状简单，为此引一个图标库不划算。
 */
const FEATURES = [
  {
    title: '一句话出图',
    detail: '描述你想要的画面就行，几十秒拿到成品图。',
    icon: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z',
  },
  {
    title: '改图 · 批量 · 多轮',
    detail: '参考图改造、一次出多张、边聊边改，都在同一个输入框里完成。',
    icon: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
  },
  {
    title: '失败不扣积分',
    detail: '出图成功才结算，失败自动把积分全额退回，试错没有成本。',
    icon: 'M12 3l7 3v6c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6l7-3zM9 12l2 2 4-4',
  },
  {
    title: '作品只属于你',
    detail: '历史记录存在你自己的浏览器里，站方不保存、也看不到你的图。',
    icon: 'M5 11h14v9H5zM9 11V8a3 3 0 016 0v3',
  },
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
  userCount,
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
  const costPerImage = credits.enabled ? credits.costPerImage : 0
  const packs = credits.enabled ? credits.packs : []
  const showSocialProof = userCount >= SOCIAL_PROOF_MIN_USERS

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
      ? bonus > 0
        ? `邮箱收个验证码就能开通，注册立刻到账 ${bonus} 积分。`
        : '填个邮箱收验证码就能开通，一分钟搞定。'
      : accounts
        ? '用注册时的用户名和密码登录。'
        : '这个站点需要访问口令，请向管理员索取。'

  const switchLink =
    'text-xs text-gray-500 transition hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100'

  return (
    <div className="flex min-h-screen bg-gray-50 dark:bg-[#101114]">
      {/* 宽屏品牌区。窄屏隐藏，避免用户进来先滚一屏才看到表单。 */}
      <aside className="relative hidden w-[50%] max-w-[620px] flex-col justify-between overflow-hidden bg-gradient-to-br from-blue-600 via-blue-500 to-indigo-600 p-11 lg:flex">
        {/* 两个大光斑，纯装饰，不做交互。 */}
        <div className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-2xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-indigo-400/20 blur-3xl" />

        <div className="relative flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/15 text-xl font-semibold text-white ring-1 ring-inset ring-white/25 backdrop-blur">
            {title.slice(0, 1)}
          </span>
          <div>
            <span className="block text-lg font-semibold tracking-wide text-white">{title}</span>
            <span className="block text-[10px] tracking-[0.22em] text-white/50">AI IMAGE STUDIO</span>
          </div>
        </div>

        <div className="relative mt-10">
          <h2 className="text-[30px] font-semibold leading-[1.3] text-white">
            一句话，
            <br />
            就是一张成品图。
          </h2>
          <p className="mt-4 text-sm leading-7 text-white/70">
            不用学提示词工程，也不用装设计软件。把需求说清楚，剩下的交给 {title}。
          </p>

          <ul className="mt-9 space-y-5">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="flex gap-3.5">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/15 ring-1 ring-inset ring-white/20">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4 text-white"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d={feature.icon} />
                  </svg>
                </span>
                <span>
                  <strong className="block text-sm font-medium text-white">{feature.title}</strong>
                  <span className="mt-1 block text-[13px] leading-6 text-white/60">{feature.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* 计费卡：只在后台确实开了积分制时才说，不然就是骗人。 */}
        <div className="relative mt-10">
          {credits.enabled ? (
            <div className="rounded-2xl bg-white/12 p-5 ring-1 ring-inset ring-white/20 backdrop-blur">
              {bonus > 0 ? (
                <div className="flex items-baseline gap-2">
                  <span className="text-sm text-white/75">注册即送</span>
                  <span className="text-3xl font-semibold leading-none text-white">{bonus}</span>
                  <span className="text-sm text-white/75">积分</span>
                </div>
              ) : (
                <p className="text-sm font-medium text-white">按量计费，用多少花多少</p>
              )}
              <p className="mt-2 text-xs leading-6 text-white/55">
                每张图 {costPerImage} 积分起 · 出图失败自动退分
              </p>
              {/* 套餐只是价目表，最多摆 4 个，多了会挤成一片反而看不清。 */}
              {packs.length > 0 && (
                <div className="mt-3.5 flex flex-wrap gap-1.5">
                  {packs.slice(0, 4).map((pack) => (
                    <span
                      key={`${pack.name}-${pack.credits}`}
                      className="rounded-lg bg-white/10 px-2.5 py-1 text-[11px] text-white/80 ring-1 ring-inset ring-white/15"
                    >
                      {pack.name}
                      {pack.price ? ` ${pack.price}` : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs leading-6 text-white/50">
              账号用于区分各自的生图记录与历史，站方不保存你的作品。
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

          {/* 按钮下方一行短说明，回答"我凭什么把这个邮箱交给你"。 */}
          <p className="mt-4 text-center text-[11px] leading-5 text-gray-400 dark:text-gray-500">
            邮箱只用于登录与找回密码
            {credits.enabled ? ' · 出图失败不扣积分' : ''}
          </p>

          {showSocialProof && (
            <p className="mt-2 text-center text-[11px] text-gray-400 dark:text-gray-500">
              已有 {userCount} 位创作者加入
            </p>
          )}

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
