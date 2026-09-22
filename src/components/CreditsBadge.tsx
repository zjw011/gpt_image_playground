// 顶栏的积分余额徽章。
//
// 只在后台开了积分制、且当前有账号时渲染——没积分的站点不该多一个看不懂的数字。
// 余额低到不够发一张图时变色提醒：让用户在点"生成"之前就知道要充值，
// 而不是等一句 402 报错再弹窗。

import { getCreditsConfig } from '../lib/backend'
import { useCreditsStore } from '../lib/creditsStore'
import { CoinIcon } from './icons'

export default function CreditsBadge() {
  // 订阅 store 而不是读 bootstrap 快照：生图扣费只更新 store，不重拉 bootstrap。
  const view = useCreditsStore((s) => s.view)
  const openRedeem = useCreditsStore((s) => s.openRedeem)
  const config = getCreditsConfig()

  if (!config || !view) return null

  // 在途占位要算进去：并发发图时余额看着够、实际排不上队，这种"点了才知道不行"最招人烦。
  const usable = view.available
  const low = config.costPerImage > 0 && usable < config.costPerImage

  return (
    <button
      type="button"
      onClick={() => openRedeem(0)}
      title={low ? '积分不足，点击充值' : '点击充值'}
      className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium tabular-nums transition-colors ${
        low
          ? 'bg-amber-50 text-amber-600 hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-400 dark:hover:bg-amber-500/15'
          : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]'
      }`}
    >
      <CoinIcon className="h-3.5 w-3.5 shrink-0" />
      <span>{usable}</span>
    </button>
  )
}
