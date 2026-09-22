import { lazy, Suspense, useEffect, useState } from 'react'
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

/**
 * three.js 有 600KB 上下，而它只负责背景。拆成独立 chunk 懒加载，
 * 并且等首屏表单画完再挂——别让一个装饰性的东西挡住用户第一眼要看的输入框。
 */
const GateScene = lazy(() => import('./GateScene'))

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
 * 品牌区的一句话卖点。
 * 都是能在代码里找到对应实现的承诺，不写做不到的话——尤其是"失败不扣积分"，
 * 服务端的积分是先冻结再结算的，失败必然全额退回。
 */
const HIGHLIGHTS = ['一句话出图', '改图 · 批量 · 多轮', '失败不扣积分', '作品只存在你的浏览器']

/** 打字机轮播的示例提示词。写得具体一点，比"输入你的创意"更能让人立刻上手。 */
const PROMPTS = [
  '赛博朋克城市夜景，霓虹倒映在湿漉漉的街道上',
  '水彩人像，柔和光线，背景大面积留白',
  '极简产品主图，纯白背景，柔和投影',
  '夏日乡村，厚厚的积云，吉卜力色调',
]

/**
 * 底层星云色晕。哪怕 WebGL 不可用、懒加载还没到，这一层本身就是张完整的背景，
 * 页面不会出现"黑的什么都没有"的空窗期。
 */
const NEBULA_BACKGROUND = [
  'radial-gradient(58% 46% at 20% 26%, rgba(79,70,229,0.42) 0%, transparent 62%)',
  'radial-gradient(50% 44% at 60% 72%, rgba(139,92,246,0.34) 0%, transparent 64%)',
  'radial-gradient(44% 38% at 84% 16%, rgba(34,211,238,0.20) 0%, transparent 60%)',
  'radial-gradient(72% 56% at 46% 106%, rgba(30,58,138,0.42) 0%, transparent 66%)',
].join(', ')

const GRID_TEXTURE = {
  backgroundImage:
    'linear-gradient(rgba(255,255,255,0.022) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.022) 1px, transparent 1px)',
  backgroundSize: '54px 54px',
}

/** 24×24 线性图标，`stroke` 描边、不填充。只有几个，不值得引图标库。 */
function Icon({ paths, className }: { paths: string[]; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

const ICON_SPARKLE = ['M12 3.5l1.7 4.6 4.6 1.7-4.6 1.7L12 16.1l-1.7-4.6L5.7 9.8l4.6-1.7L12 3.5z']
const ICON_CHECK = ['M20 6.5L9.5 17 4 11.6']

/**
 * 逐字打出提示词，再逐字删掉换下一条。
 *
 * 尊重 prefers-reduced-motion：开着的话直接静态显示第一条，不做逐字动画——
 * 前庭敏感的人对持续闪烁的文字是有生理反应的。
 */
function useTypewriter(items: readonly string[], animate: boolean) {
  const [text, setText] = useState(animate ? '' : items[0])

  useEffect(() => {
    if (!animate) {
      setText(items[0])
      return
    }
    let index = 0
    let chars = 0
    let deleting = false
    let timer = 0

    const tick = () => {
      const current = items[index]
      if (!deleting) {
        chars += 1
        setText(current.slice(0, chars))
        if (chars >= current.length) {
          deleting = true
          timer = window.setTimeout(tick, 2300)
          return
        }
        timer = window.setTimeout(tick, 62)
        return
      }
      chars -= 1
      setText(current.slice(0, chars))
      if (chars <= 0) {
        deleting = false
        index = (index + 1) % items.length
        timer = window.setTimeout(tick, 340)
        return
      }
      timer = window.setTimeout(tick, 24)
    }

    timer = window.setTimeout(tick, 500)
    return () => window.clearTimeout(timer)
  }, [items, animate])

  return text
}

/**
 * 前台门禁，同时也是这个平台的门面。
 *
 * 三种形态共用一套表单：
 *   · 登录 —— 多用户模式用用户名 + 口令，共享口令模式只要口令。
 *   · 注册 —— 邮箱验证码 + 用户名 + 口令，可选邀请码。
 *   · 找回密码 —— 邮箱验证码 + 新口令。
 *
 * 整页是深色底 + 全屏 3D 粒子星云（鼠标扫过会被推开），左边讲"这是什么"，
 * 右边一张白色卡片放表单。宽屏左文右卡，窄屏只留卡片、品牌信息压成卡片上的一行。
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

  const [motionOk, setMotionOk] = useState(true)
  const [mountScene, setMountScene] = useState(false)

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    setMotionOk(!reduced)
    if (reduced) return
    // 先让表单上屏，再拉 3D。两帧的间隙足够浏览器把文字画出来了。
    const timer = window.setTimeout(() => setMountScene(true), 120)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  const prompt = useTypewriter(PROMPTS, motionOk)

  const registering = mode === 'register'
  const resetting = mode === 'reset'
  // 注册和找回密码都需要邮箱验证码；发信没配好时注册入口要置灰。
  const needsEmail = registering || resetting
  const emailReady = !needsEmail || EMAIL_PATTERN.test(email.trim())
  /**
   * 注册入口只看后台那个开关，**不看邮件有没有配好**。
   *
   * 早先的写法要求"开关打开 + 发信就绪"同时成立才显示入口，结果管理员刚打开注册、
   * 邮件还没来得及配的时候，入口整块消失、一个字都不解释——在管理员眼里就是
   * "怎么没有注册按钮"。现在改成：开关开着就给入口，走不通的部分进去之后说清楚。
   */
  const showRegisterEntry = registrationOpen
  /** 注册流程暂时走不通：开关开着，但发信还没配好，验证码根本发不出去。 */
  const registerBlocked = registering && !registration.emailVerification
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
    && !registerBlocked
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
    if (!emailReady || sending || cooldown > 0 || registerBlocked) return
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

  // 表单卡片始终是白的，所以这里不写 dark: 变体——卡片自己就是恒定浅色。
  const inputClass =
    'w-full rounded-xl border border-gray-200 bg-white px-4 py-3.5 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 hover:border-gray-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400'

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
    'rounded-lg px-2.5 py-1 text-[13px] font-medium text-gray-500 transition hover:bg-gray-100 hover:text-gray-900'

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#05060d]">
      {/* 底：星云色晕 + 网格 + 3D 粒子。三层叠起来才有纵深，单靠一层都显得平。 */}
      <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: NEBULA_BACKGROUND }} />
      <div className="pointer-events-none absolute inset-0" style={GRID_TEXTURE} />
      {mountScene && (
        <Suspense fallback={null}>
          <GateScene />
        </Suspense>
      )}
      {/* 左侧压暗，保证长段文字压在星云上也读得清。 */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#05060d] via-[#05060d]/72 to-transparent lg:via-[#05060d]/45" />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1500px] flex-col lg:flex-row">
        {/* 品牌区。窄屏隐藏，让用户一进来就看到输入框。 */}
        <section className="hidden flex-1 flex-col justify-between px-10 py-12 lg:flex xl:px-16 xl:py-14">
          <div className="flex items-center gap-3.5">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 via-indigo-500 to-violet-600 text-[22px] font-semibold text-white shadow-lg shadow-indigo-900/50">
              {title.slice(0, 1)}
            </span>
            <div>
              <span className="block text-[19px] font-semibold tracking-wide text-white">{title}</span>
              <span className="mt-0.5 block text-[10px] font-medium tracking-[0.26em] text-white/40">
                AI IMAGE STUDIO
              </span>
            </div>
          </div>

          <div className="max-w-[540px] py-10">
            <h2 className="text-[38px] font-bold leading-[1.18] tracking-tight text-white xl:text-[46px]">
              一句话，
              <br />
              <span className="bg-gradient-to-r from-blue-400 via-indigo-300 to-cyan-300 bg-clip-text text-transparent">
                就是一张成品图。
              </span>
            </h2>
            <p className="mt-5 max-w-[440px] text-[15px] leading-7 text-white/55">
              不用学提示词工程，也不用装设计软件。把需求说清楚，剩下的交给 {title}。
            </p>

            {/* 打字机演示：把"怎么用"直接演一遍，比再写一句解释强。 */}
            <div className="mt-8 inline-flex max-w-full items-center gap-2.5 rounded-full border border-white/10 bg-white/[0.05] px-4 py-2.5 backdrop-blur-md">
              <Icon paths={ICON_SPARKLE} className="h-4 w-4 shrink-0 text-blue-400" />
              <span className="truncate text-[13px] text-white/70">{prompt}</span>
              {motionOk && <span className="h-4 w-[2px] shrink-0 animate-pulse rounded-full bg-blue-400/80" />}
            </div>

            <div className="mt-7 flex flex-wrap gap-x-5 gap-y-2.5">
              {HIGHLIGHTS.map((highlight) => (
                <span key={highlight} className="inline-flex items-center gap-1.5 text-[12.5px] text-white/50">
                  <Icon paths={ICON_CHECK} className="h-3.5 w-3.5 text-blue-400/80" />
                  {highlight}
                </span>
              ))}
            </div>
          </div>

          {/* 计费卡：只在后台确实开了积分制时才说，不然就是骗人。 */}
          <div className="max-w-[440px]">
            {credits.enabled ? (
              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.04] p-5 backdrop-blur-xl">
                {bonus > 0 ? (
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] text-white/55">注册即送</span>
                    <span className="text-[32px] font-bold leading-none text-white">{bonus}</span>
                    <span className="text-[13px] text-white/55">积分</span>
                  </div>
                ) : (
                  <p className="text-[15px] font-semibold text-white">按量计费，用多少花多少</p>
                )}
                <p className="mt-2.5 text-[12px] leading-5 text-white/40">
                  每张图 {costPerImage} 积分起 · 出图失败自动退分
                </p>

                {/* 套餐只是价目表，最多摆 3 个。摆满 4 个会挤成一片反而看不清。 */}
                {packs.length > 0 && (
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    {packs.slice(0, 3).map((pack) => (
                      <div
                        key={`${pack.name}-${pack.credits}`}
                        className="rounded-xl bg-white/[0.06] px-3 py-2.5 ring-1 ring-inset ring-white/[0.08]"
                      >
                        <div className="text-[14px] font-semibold text-white">
                          {pack.price || `${pack.credits} 积分`}
                        </div>
                        <div className="mt-1 truncate text-[11px] text-white/40">
                          {pack.price ? pack.name || `${pack.credits} 积分` : '充值套餐'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs leading-6 text-white/35">
                账号用于区分各自的生图记录与历史，站方不保存你的作品。
              </p>
            )}
          </div>
        </section>

        {/* 表单区 */}
        <section className="flex w-full flex-1 items-center justify-center px-5 py-10 lg:w-[46%] lg:max-w-[620px] lg:flex-none lg:px-10">
          <div className="w-full max-w-[420px]">
            {/* 窄屏品牌头：品牌区藏起来之后，这里要补上"这是哪"。 */}
            <div className="mb-6 flex items-center gap-3.5 lg:hidden">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 via-indigo-500 to-violet-600 text-[20px] font-semibold text-white shadow-lg shadow-indigo-500/25">
                {title.slice(0, 1)}
              </span>
              <div>
                <strong className="block text-[17px] font-semibold text-white">{title}</strong>
                {bonus > 0 && <span className="mt-0.5 block text-[12.5px] text-white/50">注册即送 {bonus} 积分</span>}
              </div>
            </div>

            <div className="rounded-3xl border border-white/[0.12] bg-white/[0.94] p-7 shadow-2xl shadow-black/50 backdrop-blur-2xl sm:p-8">
              <h1 className="text-[25px] font-bold tracking-tight text-gray-900">{heading}</h1>
              <p className="mt-2.5 text-[13.5px] leading-6 text-gray-500">{description}</p>

              <form onSubmit={submit} className="mt-7">
                {needsEmail && (
                  <>
                    <label className="block text-[13px] font-medium text-gray-700">
                      邮箱
                      <input
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        autoFocus
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        disabled={registerBlocked}
                        placeholder="you@example.com"
                        className={`mt-2 ${inputClass}`}
                      />
                    </label>

                    <label className="mt-5 block text-[13px] font-medium text-gray-700">
                      验证码
                      <div className="mt-2 flex gap-2.5">
                        <input
                          value={code}
                          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          disabled={registerBlocked}
                          placeholder="6 位数字"
                          className={`flex-1 tracking-[0.3em] placeholder:tracking-normal ${inputClass}`}
                        />
                        <button
                          type="button"
                          onClick={sendCode}
                          disabled={!emailReady || sending || cooldown > 0 || registerBlocked}
                          className="w-[112px] shrink-0 rounded-xl border border-gray-200 text-[13px] font-medium text-blue-600 transition hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-400"
                        >
                          {cooldown > 0 ? `${cooldown} 秒后重发` : sending ? '发送中…' : '获取验证码'}
                        </button>
                      </div>
                    </label>

                    {/*
                      发信没配好时说清"不是你的问题"，并给出下一步该找谁。
                      否则用户会反复翻自己的邮箱，管理员也只会看到"没有注册按钮"。
                    */}
                    {registerBlocked && (
                      <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-[12.5px] leading-5 text-amber-700">
                        本站的邮件发信还没配置好，验证码暂时发不出去，注册走不通。
                        <br />
                        <span className="text-amber-600/80">
                          如果你是管理员：到后台「邮件发信」填好邮箱授权码，这里就能用了。
                        </span>
                      </p>
                    )}
                  </>
                )}

                {registering && (
                  <label className="mt-5 block text-[13px] font-medium text-gray-700">
                    用户名
                    <input
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      autoComplete="username"
                      placeholder="字母或数字开头，2-32 位"
                      className={`mt-2 ${inputClass}`}
                    />
                  </label>
                )}

                {!registering && !resetting && accounts && (
                  <label className="block text-[13px] font-medium text-gray-700">
                    用户名
                    <input
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      autoFocus
                      autoComplete="username"
                      placeholder="用户名"
                      className={`mt-2 ${inputClass}`}
                    />
                  </label>
                )}

                <label
                  className={`block text-[13px] font-medium text-gray-700 ${
                    accounts || registering || resetting ? 'mt-5' : ''
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
                    className={`mt-2 ${inputClass}`}
                  />
                </label>

                {registering && registration.requireInviteCode && (
                  <label className="mt-5 block text-[13px] font-medium text-gray-700">
                    邀请码
                    <input
                      value={inviteCode}
                      onChange={(event) => setInviteCode(event.target.value)}
                      placeholder="向管理员索取"
                      className={`mt-2 ${inputClass}`}
                    />
                  </label>
                )}

                {notice && (
                  <p className="mt-5 rounded-xl bg-emerald-50 px-4 py-3 text-[12.5px] leading-5 text-emerald-700">
                    {notice}
                  </p>
                )}
                {error && (
                  <p className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-[12.5px] leading-5 text-red-600">
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="mt-7 w-full rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-3.5 text-[14.5px] font-semibold text-white shadow-lg shadow-blue-600/25 transition hover:from-blue-700 hover:to-indigo-700 hover:shadow-blue-600/35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:from-gray-200 disabled:to-gray-200 disabled:text-gray-400 disabled:shadow-none"
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
              <p className="mt-5 text-center text-[12px] leading-5 text-gray-400">
                邮箱只用于登录与找回密码
                {credits.enabled ? ' · 出图失败不扣积分' : ''}
                {showSocialProof ? ` · 已有 ${userCount} 位创作者加入` : ''}
              </p>

              {/* 注册开着但发信没配好时，直说卡在哪——不然管理员只会看到"没有注册按钮"。 */}
              {showRegisterEntry && !registration.emailVerification && (
                <p className="mt-3 text-center text-[11.5px] leading-5 text-amber-600">
                  注册入口已开启，但邮件发信还没配置，暂时收不到验证码。
                </p>
              )}

              <div className="mt-5 flex flex-wrap items-center justify-center gap-x-2 gap-y-2">
                {showRegisterEntry && !registering && !resetting && (
                  <button type="button" onClick={() => switchMode('register')} className={switchLink}>
                    还没有账号？注册一个
                  </button>
                )}
                {showRegisterEntry && registering && (
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
          </div>
        </section>
      </div>
    </div>
  )
}
