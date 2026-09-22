// 积分充值页。对应设计稿 9：积分档位 + 支付方式 + 卡密兑换入口。
// 在线支付是预留入口（接口就绪前走卡密兑换）。
import { useState } from 'react'
import { getCreditsConfig } from '../../lib/backend'
import { useCreditsStore } from '../../lib/creditsStore'
import { useStore } from '../../store'
import AppShell from './AppShell'
import { IconCheck, IconCoin, IconWechat, IconWallet } from '../icons'

/** 后台没配套餐时的兜底展示 */
const FALLBACK_PACKS = [
  { name: '100 积分', price: '¥10', credits: 100 },
  { name: '500 积分', price: '¥45', credits: 500 },
  { name: '1,200 积分', price: '¥98', credits: 1200 },
  { name: '2,800 积分', price: '¥198', credits: 2800 },
]

export default function RechargePage() {
  const credits = getCreditsConfig()
  const view = useCreditsStore((s) => s.view)
  const openRedeem = useCreditsStore((s) => s.openRedeem)
  const showToast = useStore((s) => s.showToast)
  const packs = credits && credits.packs.length > 0 ? credits.packs : FALLBACK_PACKS
  const [selected, setSelected] = useState(() => Math.min(2, packs.length - 1))
  const [payMethod, setPayMethod] = useState<'wechat' | 'alipay'>('wechat')

  const pack = packs[selected]

  const pay = () => {
    // 在线支付接口还没接，先指向卡密兑换，别把用户堵死在死按钮上
    showToast('在线支付即将开放，现在可以用卡密兑换积分', 'info')
    openRedeem()
  }

  return (
    <AppShell title="积分充值">
      <div className="overflow-hidden rounded-3xl border border-[#eceaf6] bg-white shadow-sm">
        <div className="grid lg:grid-cols-[1fr_380px]">
          <div className="p-7">
            <h2 className="text-lg font-bold">积分充值</h2>
            <p className="mt-1 text-[13px] text-[#8a86ac]">
              购买积分，解锁更多创作可能
              {view ? ` · 当前余额 ${view.available.toLocaleString()} 积分` : ''}
            </p>

            {/* 档位 */}
            <div className="mt-6 grid grid-cols-2 gap-3.5 xl:grid-cols-4">
              {packs.map((item, idx) => {
                const active = idx === selected
                const hot = idx === 2
                return (
                  <button
                    key={`${item.name}-${item.credits}`}
                    type="button"
                    onClick={() => setSelected(idx)}
                    className={`relative rounded-2xl border-2 p-4 text-left transition ${
                      active ? 'border-[#7c6cf6] bg-[#f8f7fe] shadow-md shadow-[#7c6cf6]/15' : 'border-[#eceaf6] hover:border-[#cdc7ee]'
                    }`}
                  >
                    {hot && (
                      <span className="absolute -top-2.5 right-3 rounded-full bg-gradient-to-r from-[#f472b6] to-[#fb923c] px-2 py-0.5 text-[10px] font-bold text-white">
                        推荐
                      </span>
                    )}
                    <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[#5b5680]">
                      <IconCoin className="h-4 w-4 text-[#f5b83d]" />
                      {item.name}
                    </p>
                    <p className={`mt-2 text-xl font-bold ${active ? 'text-[#6b5ce7]' : 'text-[#37335c]'}`}>
                      {item.price || `${item.credits} 积分`}
                    </p>
                    {item.price && <p className="mt-0.5 text-[11px] text-[#a5a1c4]">{item.credits.toLocaleString()} 积分</p>}
                  </button>
                )
              })}
            </div>

            {/* 支付方式 */}
            <h3 className="mt-7 text-sm font-semibold">选择支付方式</h3>
            <div className="mt-3 flex gap-3">
              <button
                type="button"
                onClick={() => setPayMethod('wechat')}
                className={`flex items-center gap-2.5 rounded-xl border-2 px-5 py-3 text-sm font-medium transition ${
                  payMethod === 'wechat' ? 'border-[#22c55e]/60 bg-[#f0fdf4] text-[#16a34a]' : 'border-[#eceaf6] text-[#6f6a94] hover:border-[#cdc7ee]'
                }`}
              >
                <IconWechat className="h-5 w-5" />
                微信支付
                {payMethod === 'wechat' && <IconCheck className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => setPayMethod('alipay')}
                className={`flex items-center gap-2.5 rounded-xl border-2 px-5 py-3 text-sm font-medium transition ${
                  payMethod === 'alipay' ? 'border-[#3b82f6]/60 bg-[#eff6ff] text-[#2563eb]' : 'border-[#eceaf6] text-[#6f6a94] hover:border-[#cdc7ee]'
                }`}
              >
                <IconWallet className="h-5 w-5" />
                支付宝
                {payMethod === 'alipay' && <IconCheck className="h-4 w-4" />}
              </button>
            </div>

            <button
              type="button"
              onClick={pay}
              className="mt-7 w-full rounded-2xl bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] py-4 text-[15px] font-semibold text-white shadow-xl shadow-[#7c6cf6]/30 transition hover:from-[#6b5ce7] hover:to-[#9678f5]"
            >
              立即支付 {pack?.price || ''}
            </button>

            <div className="mt-4 flex items-center justify-center gap-4 text-xs text-[#a5a1c4]">
              <button type="button" onClick={() => openRedeem()} className="font-medium text-[#6b5ce7] hover:text-[#5a4cd6]">
                有卡密？点这里兑换
              </button>
              {credits?.purchaseUrl && (
                <a href={credits.purchaseUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-[#6b5ce7] hover:text-[#5a4cd6]">
                  去购买卡密 →
                </a>
              )}
            </div>
          </div>

          {/* 插画侧栏 */}
          <div className="relative hidden lg:block">
            <img src="/art/recharge-cat.jpg" alt="" className="absolute inset-0 h-full w-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-[#3b2f6b]/55 via-transparent to-transparent" />
            <p className="absolute bottom-8 left-7 right-7 text-lg font-bold leading-snug text-white drop-shadow">
              更多灵感，
              <br />
              从积分开始
            </p>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
