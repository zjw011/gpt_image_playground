// 微信扫码登录门禁。
//
// 支持两种登录方式，界面按服务端返回的 mode 自己切：
//
//   code 模式   左侧固定二维码（先关注），右侧 6 位验证码。
//               用户扫码关注后在公众号里把数字发过来，这台电脑就登录了。
//               未认证订阅号也能用，是默认方式。
//
//   qrcode 模式 一张带参数二维码，扫码即登录。只有已认证公众号才调得通。
//
// 两者对前端的差别只有「画什么」和「要不要显示数字」，
// 轮询、倒计时、成功后刷新这一整套是共用的。

import { useCallback, useEffect, useRef, useState } from 'react'
import { startWechatLogin, pollWechatLogin, type BackendWechatLoginStart } from '../lib/backend'
import { syncWorkspaceId } from '../lib/workspace'
import { AlertCircleIcon, CheckCircleIcon, RefreshIcon, WechatIcon } from './icons'

interface Props {
  title: string
  /** 管理员是否上传了公众号固定二维码。没传时验证码仍然能用，只是少一张图。 */
  hasQrcodeImage: boolean
  onUnlocked: () => void
}

/** 轮询间隔。2 秒：够快让人感觉"扫完就进去了"，又不至于把服务端刷出压力。 */
const POLL_INTERVAL_MS = 2_000

/** 把剩余秒数写成 m:ss。 */
function formatCountdown(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds))
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`
}

export default function WechatGate({ title, hasQrcodeImage, onUnlocked }: Props) {
  const [session, setSession] = useState<BackendWechatLoginStart | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)
  // 扫码成功与轮询成功之间有几秒空档，用它把状态条从"等待扫码"换成"正在进入"。
  const [matched, setMatched] = useState(false)
  const [remaining, setRemaining] = useState(0)

  // 轮询是定时器驱动的，用 ref 记"是否已经结束"，避免过期后还继续打接口。
  const settledRef = useRef(false)

  const begin = useCallback(async () => {
    settledRef.current = false
    setLoading(true)
    setError(null)
    setExpired(false)
    setMatched(false)
    setSession(null)
    try {
      const next = await startWechatLogin()
      setSession(next)
      setRemaining(next.expiresIn)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void begin()
  }, [begin])

  const pollToken = session?.pollToken ?? ''

  // 轮询：拿到 ok 就落工作区并刷新，expired 就翻到过期态提示重新获取。
  useEffect(() => {
    if (!pollToken) return

    let stopped = false
    const timer = window.setInterval(() => {
      if (stopped || settledRef.current) return
      void (async () => {
        try {
          const result = await pollWechatLogin(pollToken)
          if (stopped || settledRef.current) return

          if (result.status === 'expired') {
            settledRef.current = true
            setExpired(true)
            return
          }
          if (result.status === 'pending') return

          settledRef.current = true
          setMatched(true)
          // 工作区决定 localStorage / IndexedDB 的键，必须在下发会话后立刻对齐，
          // 否则刷新回来读到的还是上一个账号的数据。
          syncWorkspaceId(result.workspaceId)
          onUnlocked()
        } catch (err) {
          // 轮询失败不当作致命错误：多数是网络抖一下，下一次 tick 会自愈。
          // 真正配错（未启用微信登录）会在发起那一步就被拦下。
          if (!stopped) setError(err instanceof Error ? err.message : String(err))
        }
      })()
    }, POLL_INTERVAL_MS)

    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [pollToken, onUnlocked])

  // 倒计时。到 0 不直接翻过期——服务端才是权威，等下一次轮询拿到 expired 再翻，
  // 否则会因为客户端时钟偏差把一个还有效的会话判死。
  useEffect(() => {
    if (!session || expired) return
    const timer = window.setInterval(() => {
      setRemaining((current) => (current <= 1 ? 0 : current - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [session, expired])

  const codeMode = session?.mode !== 'qrcode'
  const qrSource = codeMode ? (session?.qrImage ?? '') : (session?.qrUrl ?? '')
  const showQrPlaceholder = codeMode && !qrSource

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10 dark:bg-[#141518]">
      <div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-gray-200/70 bg-white shadow-[0_10px_50px_rgb(0,0,0,0.07)] dark:border-white/[0.08] dark:bg-white/[0.03]">
        {/* 头部：把"这是什么站"和"怎么进"一次说清 */}
        <div className="border-b border-gray-100 px-8 pt-8 pb-6 text-center dark:border-white/[0.06]">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[#07C160]/10 text-[#07C160]">
            <WechatIcon className="h-7 w-7" />
          </span>
          <h1 className="mt-4 text-lg font-semibold tracking-tight text-gray-800 dark:text-gray-100">{title}</h1>
          <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
            用微信扫码关注公众号即可登录，无需注册账号
          </p>
        </div>

        <div className="px-8 py-7">
          {loading && <LoadingBlock />}

          {!loading && error && !session && (
            <ErrorBlock message={error} onRetry={() => void begin()} />
          )}

          {!loading && session && (
            <div className="flex flex-col items-center gap-7 sm:flex-row sm:items-start sm:justify-center">
              {/* 左：二维码 */}
              <div className="shrink-0 text-center">
                <div className="mx-auto flex h-[168px] w-[168px] items-center justify-center overflow-hidden rounded-2xl border border-gray-200 bg-white p-2.5 dark:border-white/[0.08] dark:bg-white">
                  {qrSource ? (
                    <img
                      src={qrSource}
                      alt="公众号二维码"
                      className="h-full w-full object-contain"
                      draggable={false}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center rounded-xl bg-gray-50 px-3 text-center text-[11px] leading-5 text-gray-400 dark:bg-white/[0.04]">
                      {hasQrcodeImage ? '二维码加载中…' : '公众号二维码待管理员上传'}
                    </div>
                  )}
                </div>
                <p className="mt-2.5 text-xs text-gray-400 dark:text-gray-500">
                  {codeMode ? '微信扫码关注公众号' : '微信扫一扫直接登录'}
                </p>
              </div>

              {/* 右：步骤 + 验证码 */}
              <div className="min-w-0 flex-1 sm:max-w-xs">
                {codeMode ? (
                  <CodePanel code={session.code ?? ''} remaining={remaining} expired={expired} />
                ) : (
                  <QrcodePanel remaining={remaining} expired={expired} />
                )}

                {/* 降级说明：管理员配了带参数二维码但公众号没认证时会走这里 */}
                {session.degraded && session.degradedReason && (
                  <div className="mt-4 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                    <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
                    <span>{session.degradedReason}</span>
                  </div>
                )}

                {showQrPlaceholder && (
                  <p className="mt-4 rounded-xl bg-gray-50 px-3 py-2.5 text-xs leading-5 text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
                    如果你还没有关注本公众号，请先向管理员索取二维码；已经关注过的，直接在公众号里回复上面的数字即可。
                  </p>
                )}

                {error && session && (
                  <p className="mt-4 text-xs leading-5 text-red-500">{error}</p>
                )}

                <StatusBar matched={matched} expired={expired} remaining={remaining} />

                {expired && (
                  <button
                    type="button"
                    onClick={() => void begin()}
                    className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#07C160] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#06AD56]"
                  >
                    <RefreshIcon className="h-4 w-4" />
                    重新获取
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 验证码模式的核心：那串 6 位数字。放大、等宽、逐位分开，方便对着念。 */
function CodePanel({ code, remaining, expired }: { code: string; remaining: number; expired: boolean }) {
  const digits = code.split('')

  return (
    <div>
      <ol className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
        <Step index={1}>用微信扫左侧二维码，关注公众号</Step>
        <Step index={2}>在公众号的对话框里，发送下面这串数字</Step>
      </ol>

      <div className={`mt-4 rounded-2xl border px-4 py-3.5 text-center transition ${expired ? 'border-gray-200 bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.02]' : 'border-[#07C160]/25 bg-[#07C160]/[0.06]'}`}>
        <div className={`flex items-center justify-center gap-1.5 font-mono text-3xl font-semibold tracking-wider ${expired ? 'text-gray-300 line-through dark:text-gray-600' : 'text-gray-800 dark:text-gray-100'}`}>
          {digits.length > 0 ? digits.map((digit, index) => (
            <span key={index} className="tabular-nums">{digit}</span>
          )) : <span className="text-base font-normal text-gray-400">暂无验证码</span>}
        </div>
        <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
          {expired ? '已失效' : `${formatCountdown(remaining)} 后失效`}
        </p>
      </div>
    </div>
  )
}

/** 带参数二维码模式：没有数字，只需要扫码。 */
function QrcodePanel({ remaining, expired }: { remaining: number; expired: boolean }) {
  return (
    <div>
      <ol className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
        <Step index={1}>打开微信，扫描左侧二维码</Step>
        <Step index={2}>在手机上确认登录，本页面会自动进入</Step>
      </ol>
      <p className="mt-4 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3.5 text-center text-xs text-gray-400 dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-gray-500">
        {expired ? '二维码已失效' : `${formatCountdown(remaining)} 后失效`}
      </p>
    </div>
  )
}

function Step({ index, children }: { index: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-semibold text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
        {index}
      </span>
      <span className="leading-5">{children}</span>
    </li>
  )
}

/** 底部状态条。三种状态：等待扫码 / 已扫码正在进入 / 已失效。 */
function StatusBar({ matched, expired, remaining }: { matched: boolean; expired: boolean; remaining: number }) {
  const tone = expired
    ? 'text-gray-400 dark:text-gray-500'
    : matched
      ? 'text-[#07C160]'
      : 'text-gray-500 dark:text-gray-400'

  return (
    <div className={`mt-5 flex items-center gap-2 text-xs ${tone}`}>
      {matched ? (
        <CheckCircleIcon className="h-3.5 w-3.5" />
      ) : (
        <span className={`relative flex h-2 w-2 shrink-0 ${expired ? '' : 'animate-pulse'}`}>
          <span className={`absolute inline-flex h-full w-full rounded-full ${expired ? 'bg-gray-300 dark:bg-gray-600' : 'bg-[#07C160]/60'}`} />
        </span>
      )}
      {matched ? '扫码成功，正在进入…' : expired ? '二维码已失效，请重新获取' : remaining === 0 ? '正在确认…' : '等待扫码关注…'}
    </div>
  )
}

function LoadingBlock() {
  return (
    <div className="flex flex-col items-center gap-3 py-10">
      <span className="h-9 w-9 animate-spin rounded-full border-2 border-gray-200 border-t-[#07C160] dark:border-white/10 dark:border-t-[#07C160]" />
      <p className="text-sm text-gray-400 dark:text-gray-500">正在获取登录二维码…</p>
    </div>
  )
}

function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-red-50 text-red-500 dark:bg-red-500/10">
        <AlertCircleIcon className="h-6 w-6" />
      </span>
      <div>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200">无法获取登录二维码</p>
        <p className="mt-1.5 text-xs leading-5 text-gray-500 dark:text-gray-400">{message}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 rounded-xl bg-[#07C160] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#06AD56]"
      >
        <RefreshIcon className="h-4 w-4" />
        重试
      </button>
    </div>
  )
}
