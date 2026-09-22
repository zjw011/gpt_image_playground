// 余额的前端缓存与充值弹窗的开关。
//
// 余额变化的来源只有三处，全部收敛到这里，界面上任何地方读到的都是同一份数字：
//
//   1. 页面启动时的 /api/bootstrap（登录后顺带下发）
//   2. 卡密兑换接口（返回整份视图，含流水）
//   3. 生图响应头（只带本次扣费与扣完的余额）
//
// 为什么单独开一个 store 而不是塞进 backend.ts 的那份 bootstrap 快照：
// bootstrap 是「启动时解析一次」的不可变对象，用它驱动界面就会在生图后停留在旧余额上。
// 这里存的是**会变的数字**，bootstrap 里只留**不变的配置**（单价、购买链接、套餐）。
//
// 充值弹窗的开关也放在这儿：能唤起它的地方太多（顶栏徽章、余额不足的报错、生图按钮），
// 靠回调一层层传下去会把整条组件链都染上积分这个概念。

import { create } from 'zustand'
import type { BackendCreditsView } from './backend'

interface CreditsState {
  /** 当前账号的余额视图；未登录或后台未启用积分时为 null。 */
  view: BackendCreditsView | null
  /** 充值弹窗是否打开。 */
  showRedeem: boolean
  /** 余额不足时差多少，弹窗里直接告诉用户要补多少；0 表示不是被余额拦下的。 */
  shortfall: number
  setView: (view: BackendCreditsView | null) => void
  /** 只更新数字字段（生图回执只带余额，不带流水）。 */
  patch: (patch: Partial<BackendCreditsView>) => void
  openRedeem: (shortfall?: number) => void
  closeRedeem: () => void
}

export const useCreditsStore = create<CreditsState>((set, get) => ({
  view: null,
  showRedeem: false,
  shortfall: 0,

  setView: (view) => set({ view }),

  patch: (patch) => {
    const current = get().view
    if (!current) return
    const merged = { ...current, ...patch }
    // 服务端只回了余额时，按「没有在途占位」推算可用额。
    // 宁可乐观一小会儿（并发请求马上会把真实值带回来），也不要让按钮无端变灰。
    if (patch.balance != null && patch.available == null) {
      merged.available = Math.max(0, merged.balance - merged.reserved)
    }
    set({ view: merged })
  },

  openRedeem: (shortfall = 0) => set({ showRedeem: true, shortfall: Math.max(0, shortfall) }),
  closeRedeem: () => set({ showRedeem: false, shortfall: 0 }),
}))
