// 管理后台外壳：浅白浅蓝主题（区别于前台的紫罗兰插画风）。
// 左侧导航 + 顶栏。所有后台页面共用，路由是 /admin（分区走 ?tab=）。
//
// 为什么用 ?tab= 而不是 /admin/channels 这种子路径：产物是用 base:'./' 构建的，
// 让它可以塞进任意子路径部署。两层以上路径（/admin/channels）在浏览器里会把
// ./assets/xxx.js 解析成 /admin/assets/xxx.js，直接白屏——只有一层才安全。
// 前台个人中心的分区页签本来就是 /me?tab=xxx，这里保持一致。
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import ConfirmDialog from '../../components/ConfirmDialog'
import { getBackendUser, submitFrontLogout } from '../../lib/backend'
import { BrandMark } from '../theme'
import {
  IconGrid, IconLayers, IconBolt, IconUser, IconCoin,
  IconWechat, IconMail, IconSettings, IconLogout, IconHome,
  IconMessage, IconShield,
} from '../icons'

export const ADMIN_TABS = [
  { key: 'dashboard', label: '仪表盘', icon: IconGrid },
  { key: 'channels', label: '渠道链路', icon: IconLayers },
  { key: 'usage', label: '用量与健康', icon: IconBolt },
  { key: 'users', label: '用户', icon: IconUser },
  { key: 'credits', label: '积分与卡密', icon: IconCoin },
  { key: 'comments', label: '评论审核', icon: IconMessage },
  { key: 'wechat', label: '微信登录', icon: IconWechat },
  { key: 'smtp', label: '邮件发信', icon: IconMail },
  { key: 'site', label: '站点设置', icon: IconSettings },
] as const

export type AdminTab = (typeof ADMIN_TABS)[number]['key']

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const user = getBackendUser()
  const name = user?.displayName || user?.username || '管理员'

  const activeTab = searchParams.get('tab') ?? 'dashboard'
  const title = ADMIN_TABS.find((item) => item.key === activeTab)?.label ?? '后台管理'

  const logout = async () => {
    try { await submitFrontLogout() } catch {}
    window.location.assign(import.meta.env.BASE_URL)
  }

  return (
    <div className="flex min-h-screen bg-[radial-gradient(circle_at_85%_0%,rgba(219,234,254,0.65),transparent_28%),#f6f8fb] text-[#334155]">
      {/* 侧栏 */}
      <aside className="sticky top-0 flex h-screen w-[236px] shrink-0 flex-col overflow-y-auto border-r border-[#e6ebf2] bg-white/95 px-4 py-5 shadow-[8px_0_32px_rgba(148,163,184,0.06)] backdrop-blur">
        <div className="px-2.5">
          <span className="flex items-center gap-3">
            <BrandMark className="h-11 w-11" />
            <span>
              <span className="block text-[17px] font-bold tracking-wide text-[#1e293b]">绘想后台</span>
              <span className="mt-0.5 block text-[9px] font-semibold tracking-[0.22em] text-[#94a3b8]">CONTROL</span>
            </span>
          </span>
        </div>

        <nav className="mt-8 flex flex-col gap-1">
          {ADMIN_TABS.map((item, idx) => {
            const active = location.pathname === '/admin' && activeTab === item.key
            return (
              <div key={item.key}>
                {(idx === 0 || idx === 6) && (
                  <p className={`${idx === 6 ? 'mt-5' : ''} mb-2 px-3 text-[10px] font-semibold tracking-[0.18em] text-[#a8b3c4]`}>
                    {idx === 0 ? '运营管理' : '系统配置'}
                  </p>
                )}
                <Link
                  to={`/admin?tab=${item.key}`}
                  className={`group relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-all ${
                    active
                      ? 'bg-gradient-to-r from-[#eaf3ff] to-[#f3f7ff] text-[#2563eb] shadow-[inset_0_0_0_1px_rgba(96,165,250,0.12)]'
                      : 'text-[#64748b] hover:bg-[#f5f8fc] hover:text-[#1e293b]'
                  }`}
                >
                  <span className={`flex h-7 w-7 items-center justify-center rounded-lg transition ${active ? 'bg-white text-[#2563eb] shadow-sm' : 'text-[#7c8da6] group-hover:bg-white group-hover:shadow-sm'}`}>
                    <item.icon className="h-[17px] w-[17px]" />
                  </span>
                  {item.label}
                  {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[#3b82f6] shadow-[0_0_0_4px_rgba(59,130,246,0.1)]" />}
                </Link>
              </div>
            )
          })}
        </nav>

        <div className="mt-auto flex flex-col gap-1 border-t border-[#f1f5f9] pt-4">
          <Link to="/studio" className="flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium text-[#64748b] transition hover:bg-[#f1f5f9] hover:text-[#1e293b]">
            <IconHome className="h-[18px] w-[18px]" />
            返回前台
          </Link>
          <button
            type="button"
            onClick={() => void logout()}
            className="flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-left text-sm font-medium text-red-400 transition hover:bg-red-50 hover:text-red-500"
          >
            <IconLogout className="h-[18px] w-[18px]" />
            退出登录
          </button>
        </div>
      </aside>

      {/* 主区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-[72px] items-center justify-between border-b border-[#e6ebf2] bg-white/85 px-7 backdrop-blur-xl">
          <div>
            <p className="text-[11px] font-medium text-[#94a3b8]">绘想控制台&nbsp; / &nbsp;{title}</p>
            <h1 className="mt-1 text-[17px] font-bold text-[#1e293b]">{title}</h1>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden items-center gap-2 rounded-full border border-emerald-100 bg-emerald-50/80 px-3 py-1.5 text-xs font-medium text-emerald-600 sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.1)]" />
              系统运行中
            </span>
            <span className="h-7 w-px bg-[#e6ebf2]" />
            <div className="flex items-center gap-2.5 rounded-full border border-[#e6ebf2] bg-white py-1.5 pl-1.5 pr-3 shadow-sm">
              {user?.avatar
                ? <img src={user.avatar} alt="" className="h-8 w-8 rounded-full object-cover shadow-sm" />
                : <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#2563eb] to-[#60a5fa] text-sm font-bold text-white shadow-sm">{name.slice(0, 1)}</span>}
              <span>
                <span className="block max-w-[8rem] truncate text-xs font-semibold text-[#334155]">{name}</span>
                <span className="flex items-center gap-1 text-[9px] text-[#94a3b8]"><IconShield className="h-2.5 w-2.5" />管理员</span>
              </span>
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-5 py-6 lg:px-7 lg:py-7">{children}</main>
        {/* 后台所有确认弹窗共用全站样式（store 驱动），替代原生 confirm */}
        <ConfirmDialog />
      </div>
    </div>
  )
}
