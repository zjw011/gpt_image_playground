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
import {
  IconGrid, IconLayers, IconBolt, IconUser, IconCoin,
  IconWechat, IconMail, IconSettings, IconLogout, IconHome,
} from '../icons'

export const ADMIN_TABS = [
  { key: 'dashboard', label: '仪表盘', icon: IconGrid },
  { key: 'channels', label: '渠道链路', icon: IconLayers },
  { key: 'usage', label: '用量与健康', icon: IconBolt },
  { key: 'users', label: '用户', icon: IconUser },
  { key: 'credits', label: '积分与卡密', icon: IconCoin },
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
    <div className="flex min-h-screen bg-[#f6f8fb] text-[#334155]">
      {/* 侧栏 */}
      <aside className="sticky top-0 flex h-screen w-[220px] shrink-0 flex-col border-r border-[#e6ebf2] bg-white px-4 py-5">
        <div className="px-2">
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-[#3b82f6] to-[#60a5fa] font-bold text-white shadow-sm">
              绘
            </span>
            <span className="text-lg font-bold tracking-wide text-[#1e293b]">后台管理</span>
          </span>
        </div>

        <nav className="mt-8 flex flex-col gap-1">
          {ADMIN_TABS.map((item) => (
            <Link
              key={item.key}
              to={`/admin?tab=${item.key}`}
              className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition ${
                location.pathname === '/admin' && activeTab === item.key
                  ? 'bg-[#eff6ff] text-[#2563eb]'
                  : 'text-[#64748b] hover:bg-[#f1f5f9] hover:text-[#1e293b]'
              }`}
            >
              <item.icon className="h-[18px] w-[18px]" />
              {item.label}
            </Link>
          ))}
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
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-[#e6ebf2] bg-white/90 px-6 backdrop-blur">
          <h1 className="text-lg font-bold">{title}</h1>
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#3b82f6] to-[#60a5fa] text-sm font-bold text-white">
              {name.slice(0, 1)}
            </span>
            <span className="max-w-[10rem] truncate text-sm font-medium text-[#334155]">{name}</span>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">{children}</main>
        {/* 后台所有确认弹窗共用全站样式（store 驱动），替代原生 confirm */}
        <ConfirmDialog />
      </div>
    </div>
  )
}
