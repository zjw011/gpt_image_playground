// 卡密兑换弹窗。
//
// 充值只有一条路径：用户先从外面买到卡密（管理员配了购买链接），把卡密贴进来换积分。
// 所以这个弹窗的重点是「贴卡密」和「去哪买」两件事，其余都是辅助信息。
//
// 弹窗的开关放在 creditsStore 里而不是由父组件传：能唤起它的地方太多
// （顶栏余额徽章、余额不足的报错、生成按钮的余额提示），靠 props 往下传会把整条链染上积分概念。

import { useEffect, useRef, useState } from 'react'
import { formatCardCodeInput, getCreditsConfig, redeemCardCode } from '../lib/backend'
import { useCreditsStore } from '../lib/creditsStore'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { CardIcon, CheckCircleIcon, CloseIcon, CoinIcon, ExternalLinkIcon } from './icons'

export default function RedeemCardModal() {
  const show = useCreditsStore((s) => s.showRedeem)
  const close = useCreditsStore((s) => s.closeRedeem)
  const view = useCreditsStore((s) => s.view)
  const shortfall = useCreditsStore((s) => s.shortfall)
  const config = getCreditsConfig()

  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [credited, setCredited] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useCloseOnEscape(show, close)
  usePreventBackgroundScroll(show)

  // 每次打开都从干净状态开始：上一次的卡密、报错、成功提示都不该留到下一次。
  useEffect(() => {
    if (!show) return
    setCode('')
    setError(null)
    setSubmitting(false)
    setCredited(0)
    // 打开即聚焦，用户是奔着"贴卡密"来的，少一次点击。
    window.setTimeout(() => inputRef.current?.focus(), 60)
  }, [show])

  if (!show || !config) return null

  const submit = async () => {
    const value = code.trim()
    if (!value || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await redeemCardCode(value)
      setCredited(result.credited)
      setCode('')
    } catch (err) {
      // 服务端已经把失败原因（不存在 / 已使用 / 已作废 / 尝试过于频繁）措辞好了，直接用。
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const purchaseUrl = config.purchaseUrl

  return (
    <div
      data-no-drag-select
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      onClick={close}
    >
      <div className="absolute inset-0 animate-overlay-in bg-black/20 backdrop-blur-md dark:bg-black/40" />
      <div
        className="relative z-10 w-full max-w-md animate-confirm-in rounded-3xl border border-white/50 bg-white/95 p-6 shadow-[0_8px_40px_rgb(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur-xl dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={close}
          aria-label="关闭"
          className="absolute right-4 top-4 rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
        >
          <CloseIcon className="h-4 w-4" />
        </button>

        <h3 className="flex items-center gap-2 text-base font-bold text-gray-800 dark:text-gray-100">
          <CoinIcon className="h-5 w-5 shrink-0 text-amber-500" />
          积分充值
        </h3>

        {/* 余额：充值的唯一目的就是把这个数字变大，放在最显眼处 */}
        <div className="mt-4 flex items-baseline gap-2 rounded-2xl bg-gray-50 px-4 py-3.5 dark:bg-white/[0.04]">
          <span className="text-xs text-gray-500 dark:text-gray-400">当前余额</span>
          <span className="ml-auto text-2xl font-semibold tabular-nums text-gray-800 dark:text-gray-100">
            {view?.balance ?? 0}
          </span>
          <span className="text-xs text-gray-400 dark:text-gray-500">积分</span>
        </div>

        {shortfall > 0 && (
          <p className="mt-2 text-xs leading-5 text-amber-600 dark:text-amber-400">
            还差 {shortfall} 积分，兑换后即可继续生成。
          </p>
        )}

        {credited > 0 && (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">
            <CheckCircleIcon className="h-4 w-4 shrink-0" />
            兑换成功，到账 {credited} 积分
          </div>
        )}

        {/* 卡密输入 */}
        <label className="mt-5 flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5 transition focus-within:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:focus-within:border-blue-500/50">
          <CardIcon className="h-4 w-4 shrink-0 text-gray-400" />
          <input
            ref={inputRef}
            value={code}
            onChange={(e) => {
              setCode(formatCardCodeInput(e.target.value))
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            placeholder="GIP-XXXX-XXXX-XXXX"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            className="w-full bg-transparent font-mono text-sm tracking-wide text-gray-700 outline-none placeholder:text-gray-300 dark:text-gray-200 dark:placeholder:text-gray-600"
          />
        </label>

        {error && <p className="mt-2 text-xs leading-5 text-red-500">{error}</p>}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={!code.trim() || submitting}
          className="mt-4 w-full rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? '兑换中…' : '兑换'}
        </button>

        {/* 购买入口。管理员没填链接时整块不显示，而不是给一个点不动的按钮。 */}
        {purchaseUrl && (
          <div className="mt-5 border-t border-gray-100 pt-4 dark:border-white/[0.06]">
            <p className="text-xs text-gray-500 dark:text-gray-400">还没有卡密？</p>
            <a
              href={purchaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 flex items-center justify-center gap-1.5 rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-white/[0.08] dark:text-gray-200 dark:hover:bg-white/[0.06]"
            >
              前往购买卡密
              <ExternalLinkIcon className="h-3.5 w-3.5" />
            </a>
          </div>
        )}

        {/* 套餐价目表：只是信息展示，真正的兑换仍然靠卡密 */}
        {config.packs.length > 0 && (
          <div className="mt-5 border-t border-gray-100 pt-4 dark:border-white/[0.06]">
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">充值套餐</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {config.packs.map((pack, index) => (
                <div
                  key={`${pack.name}-${index}`}
                  className="rounded-xl border border-gray-200/70 bg-gray-50/60 px-3 py-2.5 text-center dark:border-white/[0.08] dark:bg-white/[0.02]"
                >
                  <p className="text-sm font-semibold tabular-nums text-gray-800 dark:text-gray-100">
                    {pack.credits}
                    <span className="ml-0.5 text-[10px] font-normal text-gray-400">积分</span>
                  </p>
                  {pack.price && <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{pack.price}</p>}
                  {pack.name && <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">{pack.name}</p>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
