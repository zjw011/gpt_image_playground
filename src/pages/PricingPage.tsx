// 价格与积分页。对应设计稿 10：套餐卡片 + 积分说明。
// 公开访问用公开导航；已进入应用时套应用外壳。
import { Link } from 'react-router-dom'
import AppShell from './app/AppShell'
import { useInApp } from './useInApp'
import { PublicNav, SiteFooter } from './theme'
import { IconBolt, IconShield, IconWallet, IconCheck, IconCoin, IconSparkle } from './icons'

const PLANS = [
  { name: '免费体验', price: '¥0', credits: '送 20 积分', desc: '注册即得，先画一张试试', cta: '立即领取', to: '/register', hot: false },
  { name: '基础套餐', price: '¥10', credits: '100 积分', desc: '偶尔画着玩，轻量够用', cta: '立即购买', to: '/recharge', hot: false },
  { name: '进阶套餐', price: '¥98', credits: '1,200 积分', desc: '高频创作的首选，性价比之王', cta: '立即购买', to: '/recharge', hot: true },
  { name: '专业套餐', price: '¥198', credits: '2,800 积分', desc: '工作室级用量，尽情创作', cta: '立即购买', to: '/recharge', hot: false },
]

const NOTES = [
  { icon: IconBolt, title: '按次消耗', desc: '每生成一张图扣除对应积分，失败自动退回' },
  { icon: IconCoin, title: '永不过期', desc: '积分没有有效期，想什么时候用都行' },
  { icon: IconShield, title: '安全支付', desc: '支持主流支付方式，交易全程加密' },
  { icon: IconWallet, title: '开具发票', desc: '企业用户可申请开具增值税发票' },
]

function PricingContent() {
  return (
    <section className="mx-auto max-w-6xl px-5 pb-20 pt-14">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight">价格与积分</h1>
        <p className="mt-3 text-sm text-[#8a86ac]">灵活选择，满足不同创作需求</p>
      </div>

      {/* 套餐卡片 */}
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PLANS.map((plan) => (
          <div
            key={plan.name}
            className={`relative flex flex-col rounded-3xl border-2 bg-white p-6 transition hover:-translate-y-1 ${
              plan.hot ? 'border-[#7c6cf6] shadow-xl shadow-[#7c6cf6]/15' : 'border-[#eceaf6] shadow-sm hover:shadow-lg'
            }`}
          >
            {plan.hot && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] px-3.5 py-1 text-[11px] font-bold text-white shadow-md">
                最受欢迎
              </span>
            )}
            <p className="text-sm font-semibold text-[#6f6a94]">{plan.name}</p>
            <p className="mt-3">
              <span className={`text-[34px] font-bold leading-none ${plan.hot ? 'text-[#6b5ce7]' : ''}`}>{plan.price}</span>
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-[13px] font-medium text-[#f5b83d]">
              <IconCoin className="h-4 w-4" />
              {plan.credits}
            </p>
            <p className="mt-3 flex-1 text-[12.5px] leading-5 text-[#8a86ac]">{plan.desc}</p>
            <Link
              to={plan.to}
              className={`mt-6 flex items-center justify-center gap-2 rounded-full py-3 text-sm font-semibold transition ${
                plan.hot
                  ? 'bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] text-white shadow-lg shadow-[#7c6cf6]/30 hover:from-[#6b5ce7] hover:to-[#9678f5]'
                  : 'border border-[#dcd8f0] text-[#6b5ce7] hover:border-[#7c6cf6] hover:bg-[#f8f7fe]'
              }`}
            >
              <IconSparkle className="h-4 w-4" />
              {plan.cta}
            </Link>
          </div>
        ))}
      </div>

      {/* 积分说明 */}
      <div className="mt-16">
        <h2 className="text-center text-xl font-bold">积分说明</h2>
        <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {NOTES.map((note) => (
            <div key={note.title} className="rounded-2xl border border-[#eceaf6] bg-white p-5 text-center shadow-sm">
              <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-[#efedfd] to-[#e3f0ff] text-[#7c6cf6]">
                <note.icon className="h-5 w-5" />
              </span>
              <h3 className="mt-3.5 flex items-center justify-center gap-1.5 text-sm font-bold">
                {note.title}
                <IconCheck className="h-3.5 w-3.5 text-emerald-500" />
              </h3>
              <p className="mt-1.5 text-[12px] leading-5 text-[#8a86ac]">{note.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export default function PricingPage() {
  const inApp = useInApp()
  if (inApp === undefined) return null
  if (inApp) {
    return (
      <AppShell title="价格与积分">
        <PricingContent />
      </AppShell>
    )
  }

  return (
    <div className="min-h-screen bg-[#f5f4fb] text-[#37335c]">
      <PublicNav active="pricing" />
      <PricingContent />
      <SiteFooter />
    </div>
  )
}
