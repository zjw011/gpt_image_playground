// 应用内通用壳：左侧导航栏 + 顶部用户条。对应设计稿 5/7 的整体框架。
// 托管模式下渠道与模型由管理员在后台维护，用户侧不提供任何设置入口；
// 纯前端（自备密钥）模式下必须保留设置，否则用户无处填 API Key。
import { NavLink, Link, useLocation } from 'react-router-dom'
import { useStore } from '../../store'
import { getBackendUser, getCreditsConfig, isAdmin } from '../../lib/backend'
import { isBackendManagedMode } from '../../lib/presetConfig'
import { useCreditsStore } from '../../lib/creditsStore'
import { Logo } from '../theme'
import {
  IconBrush, IconGrid, IconImage, IconHeart, IconCoin, IconUser, IconHelp, IconSettings, IconSparkle, IconShield,
} from '../icons'

// 分区切换全部由这一列侧栏承担：个人中心页里不再放第二列菜单，
// 否则侧栏和个人中心各有一套入口，看着像两层导航。
const NAV_ITEMS = [
  { label: 'AI 绘画', to: '/studio', icon: IconBrush, end: true },
  { label: '作品广场', to: '/gallery', icon: IconGrid },
  { label: '我的作品', to: '/me?tab=works', icon: IconImage, tab: 'works' },
  { label: '我的收藏', to: '/me?tab=favorites', icon: IconHeart, tab: 'favorites' },
  { label: '积分中心', to: '/me?tab=ledger', icon: IconCoin, tab: 'ledger' },
  { label: '个人中心', to: '/me?tab=settings', icon: IconUser, tab: 'settings' },
]

/** 左侧导航栏 */
export function SideNav() {
  const location = useLocation()
  const setShowSettings = useStore((s) => s.setShowSettings)
  const credits = getCreditsConfig()
  const view = useCreditsStore((s) => s.view)
  const currentTab = new URLSearchParams(location.search).get('tab')
  // 只有「自备密钥」模式才需要设置入口；托管模式下渠道全在后台，用户进去也没得改。
  const showSettingsEntry = !isBackendManagedMode()

  const isActive = (item: (typeof NAV_ITEMS)[number]) => {
    const path = item.to.split('?')[0]
    if (item.tab) return location.pathname === '/me' && currentTab === item.tab
    if (item.end) return location.pathname === path
    return location.pathname.startsWith(path)
  }

  return (
    <aside className="sticky top-0 flex h-screen w-[220px] shrink-0 flex-col border-r border-[#eceaf6] bg-white px-4 py-5">
      <div className="px-2">
        <Logo to="/studio" />
      </div>

      <nav className="mt-8 flex flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.label}
            to={item.to}
            className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition ${
              isActive(item)
                ? 'bg-[#efedfd] text-[#6b5ce7]'
                : 'text-[#6f6a94] hover:bg-[#f5f4fb] hover:text-[#37335c]'
            }`}
          >
            <item.icon className="h-[18px] w-[18px]" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-6 border-t border-[#f1effa] pt-4">
        <p className="px-3.5 text-[11px] font-medium uppercase tracking-wider text-[#b3aed0]">更多</p>
        <div className="mt-2 flex flex-col gap-1">
          <NavLink to="/help" className="flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium text-[#6f6a94] transition hover:bg-[#f5f4fb] hover:text-[#37335c]">
            <IconHelp className="h-[18px] w-[18px]" />
            帮助中心
          </NavLink>
          {showSettingsEntry && (
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-left text-sm font-medium text-[#6f6a94] transition hover:bg-[#f5f4fb] hover:text-[#37335c]"
            >
              <IconSettings className="h-[18px] w-[18px]" />
              设置
            </button>
          )}
          {/* 站长账号在前台也能一键回后台，不用手动敲 /admin */}
          {isAdmin() && (
            <Link to="/admin" className="flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium text-[#6f6a94] transition hover:bg-[#f5f4fb] hover:text-[#37335c]">
              <IconShield className="h-[18px] w-[18px]" />
              管理后台
            </Link>
          )}
        </div>
      </div>

      {/* 底部积分卡：只在后台开启积分制时显示 */}
      {credits && (
        <div className="mt-auto rounded-2xl bg-gradient-to-br from-[#efedfd] to-[#e3f0ff] p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-[#6f6a94]">
            <IconSparkle className="h-3.5 w-3.5 text-[#7c6cf6]" />
            剩余积分
          </div>
          <div className="mt-1.5 text-2xl font-bold text-[#37335c]">
            {(view?.available ?? 0).toLocaleString()}
          </div>
          <Link
            to="/recharge"
            className="mt-3 flex items-center justify-center rounded-full bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] py-2 text-xs font-semibold text-white shadow-md shadow-[#7c6cf6]/25 transition hover:from-[#6b5ce7] hover:to-[#9678f5]"
          >
            充值
          </Link>
        </div>
      )}
    </aside>
  )
}

/** 右上角用户条：头像 + 昵称 + 积分 */
export function UserChip() {
  const user = getBackendUser()
  const credits = getCreditsConfig()
  const view = useCreditsStore((s) => s.view)
  const name = user?.displayName || user?.username || '本地创作者'

  return (
    <Link to="/me" className="flex items-center gap-2.5 rounded-full border border-[#eceaf6] bg-white py-1.5 pl-1.5 pr-4 shadow-sm transition hover:border-[#cdc7ee]">
      {user?.avatar ? (
        <img src={user.avatar} alt="" className="h-8 w-8 rounded-full object-cover" />
      ) : (
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#7c6cf6] to-[#a78bfa] text-sm font-bold text-white">
          {name.slice(0, 1)}
        </span>
      )}
      {/* 昵称过长会把用户条挤出视口右边（截图里「本地创作者」被窗口切掉就是这个原因） */}
      <span className="max-w-[7rem] truncate text-sm font-medium text-[#37335c]">{name}</span>
      {credits && (
        <span className="flex items-center gap-1 rounded-full bg-[#f4f2fe] px-2.5 py-0.5 text-xs font-semibold text-[#6b5ce7]">
          <IconCoin className="h-3.5 w-3.5" />
          {(view?.available ?? 0).toLocaleString()}
        </span>
      )}
    </Link>
  )
}

/** 应用页骨架：侧栏 + 顶栏（页面标题 + 用户条）+ 内容区 */
export default function AppShell({ title, children, wide }: { title?: string, children: React.ReactNode, wide?: boolean }) {
  return (
    <div className="flex min-h-screen bg-[#f5f4fb] text-[#37335c]">
      <SideNav />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-[#eceaf6] bg-[#f5f4fb]/85 px-6 backdrop-blur-xl">
          <h1 className="min-w-0 truncate text-lg font-bold">{title}</h1>
          <div className="shrink-0">
            <UserChip />
          </div>
        </header>
        <main className={`mx-auto w-full flex-1 px-6 py-6 ${wide ? 'max-w-7xl' : 'max-w-5xl'}`}>
          {children}
        </main>
      </div>
    </div>
  )
}
