// 应用内通用壳：左侧导航栏 + 顶部用户条。对应设计稿 5/7 的整体框架。
// 渠道与模型由管理员在后台维护，用户侧不提供设置入口。
import { useRef } from 'react'
import { NavLink, Link, useLocation } from 'react-router-dom'
import MobileBottomNav from '../../components/MobileBottomNav'
import { getBackendUser, getCreditsConfig, getInviteInfo, isAdmin } from '../../lib/backend'
import { useCreditsStore } from '../../lib/creditsStore'
import { BrandMark, Logo } from '../theme'
import {
  IconBrush, IconGrid, IconImage, IconCoin, IconUser, IconHelp, IconShare, IconSparkle, IconShield, IconToolbox, IconShirt, IconPose,
} from '../icons'
import { useToolsRecipeStore } from '../../lib/toolsGallery/recipeStore'

// 分区切换全部由这一列侧栏承担：个人中心页里不再放第二列菜单，
// 否则侧栏和个人中心各有一套入口，看着像两层导航。
const CREATE_NAV = [
  { label: 'AI 绘画', to: '/studio', icon: IconBrush, end: true },
  { label: '专业工具', to: '/tools', icon: IconToolbox, match: '/tools' },
] as const

const ATLAS_NAV = [
  { label: '图库总览', to: '/atlas', icon: IconGrid, end: true },
  { label: 'AI 角色合成台', to: '/compose', icon: IconSparkle, pro: true },
  { label: '动作姿势库', to: '/poses', icon: IconPose, count: '1,439' },
  { label: '服装穿搭库', to: '/costumes', icon: IconShirt, count: '3,224' },
  { label: '人像颜值库', to: '/portraits', icon: IconUser, count: '1,499' },
] as const

const ACCOUNT_NAV = [
  { label: '作品广场', to: '/gallery', icon: IconGrid },
  // 「我的收藏」并入我的作品（作品页内可切收藏页签，收藏作品带星标），侧栏不再单挂
  { label: '我的作品', to: '/me?tab=works', icon: IconImage, tab: 'works' },
  { label: '积分中心', to: '/me?tab=ledger', icon: IconCoin, tab: 'ledger' },
  { label: '个人中心', to: '/me?tab=settings', icon: IconUser, tab: 'settings' },
] as const

type NavItem = {
  label: string
  to: string
  icon: (typeof CREATE_NAV)[number]['icon']
  end?: boolean
  tab?: string
  match?: string
  pro?: boolean
  count?: string
}

function navItemActive(item: NavItem, pathname: string, currentTab: string | null) {
  const path = item.to.split('?')[0]
  if (item.tab) return pathname === '/me' && currentTab === item.tab
  if (item.end) return pathname === path
  // 专业工具只匹配 /tools，避免和参考图库单层路由撞车
  if (item.match) return pathname === item.match || pathname.startsWith(`${item.match}?`)
  return pathname === path || pathname.startsWith(`${path}/`)
}

function SideNavLink({ item, active, recipeCount }: { item: NavItem; active: boolean; recipeCount?: number }) {
  return (
    <NavLink
      to={item.to}
      title={item.label}
      className={`flex items-center justify-center gap-2.5 rounded-xl px-2 py-2.5 text-sm font-medium transition lg:justify-start lg:px-3.5 ${
        active
          ? 'bg-[#efedfd] text-[#6b5ce7]'
          : 'text-[#6f6a94] hover:bg-[#f5f4fb] hover:text-[#37335c]'
      }`}
    >
      <item.icon className="h-[18px] w-[18px] shrink-0" />
      <span className="hidden min-w-0 flex-1 truncate lg:inline">{item.label}</span>
      {item.pro && (
        <span className="hidden rounded-md bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] px-1.5 py-0.5 text-[10px] font-bold text-white lg:inline">
          PRO
        </span>
      )}
      {item.to === '/compose' && recipeCount && recipeCount > 0 ? (
        <span className="hidden rounded-full bg-[#7c6cf6] px-1.5 text-[10px] font-bold text-white lg:inline">{recipeCount}</span>
      ) : item.count ? (
        <span className="hidden text-[11px] tabular-nums text-[#b3aed0] lg:inline">{item.count}</span>
      ) : null}
    </NavLink>
  )
}

/** 左侧导航栏 */
export function SideNav() {
  const location = useLocation()
  const credits = getCreditsConfig()
  const invite = getInviteInfo()
  const view = useCreditsStore((s) => s.view)
  const recipe = useToolsRecipeStore((s) => s.recipe)
  const recipeCount = [recipe.portrait, recipe.costume, recipe.pose].filter(Boolean).length
  const currentTab = new URLSearchParams(location.search).get('tab')

  // 手机使用抽屉与底部导航，平板保留图标栏，桌面显示完整侧栏。
  return (
    <aside className="sticky top-0 hidden h-screen w-16 shrink-0 flex-col border-r border-[#eceaf6] bg-white px-2 py-4 md:flex lg:w-[220px] lg:px-4 lg:py-5">
      <div className="hidden px-2 lg:block">
        <Logo to="/studio" />
      </div>
      <div className="flex justify-center lg:hidden">
        <Link to="/studio" className="flex h-10 w-10 items-center justify-center">
          <BrandMark appIcon className="h-9 w-9" />
        </Link>
      </div>

      <nav className="mt-6 flex flex-col gap-1 overflow-y-auto lg:mt-8">
        <p className="hidden px-3.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-[#b3aed0] lg:block">创作</p>
        {CREATE_NAV.map((item) => (
          <SideNavLink
            key={item.label}
            item={item}
            active={navItemActive(item, location.pathname, currentTab)}
          />
        ))}

        <div className="my-3 border-t border-[#f1effa]" />
        <p className="hidden px-3.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-[#b3aed0] lg:block">工作台</p>
        {ATLAS_NAV.slice(0, 2).map((item) => (
          <SideNavLink
            key={item.label}
            item={item}
            active={navItemActive(item, location.pathname, currentTab)}
            recipeCount={recipeCount}
          />
        ))}
        <p className="mt-3 hidden px-3.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-[#b3aed0] lg:block">三大参考图库</p>
        {ATLAS_NAV.slice(2).map((item) => (
          <SideNavLink
            key={item.label}
            item={item}
            active={navItemActive(item, location.pathname, currentTab)}
          />
        ))}

        <div className="my-3 border-t border-[#f1effa]" />
        {ACCOUNT_NAV.map((item) => (
          <SideNavLink
            key={item.label}
            item={item}
            active={navItemActive(item, location.pathname, currentTab)}
          />
        ))}
      </nav>

      <div className="mt-5 border-t border-[#f1effa] pt-4 lg:mt-6">
        <p className="hidden px-3.5 text-[11px] font-medium uppercase tracking-wider text-[#b3aed0] lg:block">更多</p>
        <div className="mt-2 flex flex-col gap-1">
          <NavLink to="/help" title="帮助中心" className="flex items-center justify-center gap-3 rounded-xl px-2 py-2.5 text-sm font-medium text-[#6f6a94] transition hover:bg-[#f5f4fb] hover:text-[#37335c] lg:justify-start lg:px-3.5">
            <IconHelp className="h-[18px] w-[18px] shrink-0" />
            <span className="hidden lg:inline">帮助中心</span>
          </NavLink>
          {/* 站长账号在前台也能一键回后台，不用手动敲 /admin */}
          {isAdmin() && (
            <Link to="/admin" title="管理后台" className="flex items-center justify-center gap-3 rounded-xl px-2 py-2.5 text-sm font-medium text-[#6f6a94] transition hover:bg-[#f5f4fb] hover:text-[#37335c] lg:justify-start lg:px-3.5">
              <IconShield className="h-[18px] w-[18px] shrink-0" />
              <span className="hidden lg:inline">管理后台</span>
            </Link>
          )}
        </div>
      </div>

      {/* 底部积分卡：只在后台开启积分制时显示 */}
      {credits && (
        <div className="mt-auto rounded-2xl bg-gradient-to-br from-[#efedfd] to-[#e3f0ff] p-2 lg:p-4">
          <div className="hidden items-center gap-2 text-xs font-medium text-[#6f6a94] lg:flex">
            <IconSparkle className="h-3.5 w-3.5 text-[#7c6cf6]" />
            剩余积分
          </div>
          <div className="text-center text-base font-bold text-[#37335c] lg:mt-1.5 lg:text-left lg:text-2xl" title="剩余积分">
            {(view?.available ?? 0).toLocaleString()}
          </div>
          {(invite?.enabled || credits.luckyEnabled) && (
            <div className="mt-3 hidden flex-col gap-1.5 lg:flex">
              {invite?.enabled && (
                <Link
                  to="/me?tab=ledger"
                  className="flex items-center gap-2 rounded-xl bg-white/70 px-2.5 py-2 text-[11px] font-medium text-[#5b5680] transition hover:bg-white hover:text-[#6b5ce7]"
                  title="分享邀请链接，好友完成首次创作后获得积分"
                >
                  <IconShare className="h-3.5 w-3.5 shrink-0 text-[#7c6cf6]" />
                  <span className="min-w-0 flex-1 truncate">分享赚积分</span>
                  <span className="shrink-0 font-semibold text-[#7c6cf6]">+{invite.reward}</span>
                </Link>
              )}
              {credits.luckyEnabled && (
                <Link
                  to="/studio"
                  className="flex items-center gap-2 rounded-xl bg-white/70 px-2.5 py-2 text-[11px] font-medium text-[#5b5680] transition hover:bg-white hover:text-[#6b5ce7]"
                  title="每次创作都有机会随机免扣积分"
                >
                  <IconSparkle className="h-3.5 w-3.5 shrink-0 text-[#f0a94b]" />
                  <span className="min-w-0 flex-1 truncate">每日幸运免单</span>
                  <span className="shrink-0 font-semibold text-[#d58a28]">{credits.luckyRate}%</span>
                </Link>
              )}
            </div>
          )}
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
    <Link to="/me?tab=settings" aria-label="个人中心" className="flex min-h-11 items-center gap-1.5 rounded-full border border-[#eceaf6] bg-white py-1.5 pl-1.5 pr-2 shadow-sm transition hover:border-[#cdc7ee] sm:gap-2.5 sm:pr-4">
      {user?.avatar ? (
        <img src={user.avatar} alt="" className="h-8 w-8 rounded-full object-cover" />
      ) : (
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#7c6cf6] to-[#a78bfa] text-sm font-bold text-white">
          {name.slice(0, 1)}
        </span>
      )}
      {/* 昵称过长会把用户条挤出视口右边（截图里「本地创作者」被窗口切掉就是这个原因） */}
      <span className="hidden max-w-[7rem] truncate text-sm font-medium text-[#37335c] sm:block">{name}</span>
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
  const drawer = useRef<HTMLDialogElement>(null)
  return (
    <div className="flex min-h-screen bg-[#f5f4fb] text-[#37335c]">
      <SideNav />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b border-[#eceaf6] bg-[#f5f4fb]/85 px-3 backdrop-blur-xl md:h-16 md:gap-4 md:px-6">
          <div className="flex min-w-0 items-center gap-1">
            <button type="button" aria-label="打开手机菜单" onClick={() => drawer.current?.showModal()} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[#6b5ce7] md:hidden"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button>
            <h1 className="min-w-0 truncate text-base font-bold md:text-lg">{title}</h1>
          </div>
          <div className="shrink-0">
            <UserChip />
          </div>
        </header>
        <main className={`mx-auto w-full min-w-0 flex-1 px-3 pt-4 pb-[calc(5rem+env(safe-area-inset-bottom))] sm:px-5 md:px-6 md:py-6 ${wide ? 'max-w-7xl' : 'max-w-5xl'}`}>
          {children}
        </main>
      </div>
      <MobileBottomNav />
      <dialog ref={drawer} aria-label="手机菜单" onClick={(event) => { if (event.target === event.currentTarget) drawer.current?.close() }} className="m-0 h-dvh max-h-none w-[min(85vw,320px)] max-w-none border-0 bg-white p-5 text-[#37335c] shadow-xl backdrop:bg-[#211b4f]/40">
        <div className="flex items-center justify-between"><Logo to="/" /><button type="button" aria-label="关闭手机菜单" onClick={() => drawer.current?.close()} className="h-11 w-11 rounded-xl text-xl">×</button></div>
        <nav aria-label="手机完整导航" className="mt-6 flex flex-col gap-2">
          <p className="px-4 text-[11px] font-medium uppercase tracking-wider text-[#b3aed0]">创作</p>
          {CREATE_NAV.map((item) => <Link key={item.to} to={item.to} onClick={() => drawer.current?.close()} className="flex min-h-12 items-center gap-3 rounded-xl bg-[#f7f5ff] px-4 text-sm font-medium"><item.icon className="h-5 w-5 text-[#7955ed]" />{item.label}</Link>)}
          <div className="my-1 border-t border-[#f1effa]" />
          <p className="px-4 text-[11px] font-medium uppercase tracking-wider text-[#b3aed0]">参考图库</p>
          {ATLAS_NAV.map((item) => (
            <Link key={item.to} to={item.to} onClick={() => drawer.current?.close()} className="flex min-h-12 items-center gap-3 rounded-xl bg-[#f7f5ff] px-4 text-sm font-medium">
              <item.icon className="h-5 w-5 text-[#7955ed]" />
              <span className="min-w-0 flex-1">{item.label}</span>
              {'pro' in item && item.pro && <span className="rounded-md bg-[#7c6cf6] px-1.5 py-0.5 text-[10px] font-bold text-white">PRO</span>}
              {'count' in item && item.count && <span className="text-[11px] text-[#b3aed0]">{item.count}</span>}
            </Link>
          ))}
          <div className="my-1 border-t border-[#f1effa]" />
          {ACCOUNT_NAV.map((item) => <Link key={item.to} to={item.to} onClick={() => drawer.current?.close()} className="flex min-h-12 items-center gap-3 rounded-xl bg-[#f7f5ff] px-4 text-sm font-medium"><item.icon className="h-5 w-5 text-[#7955ed]" />{item.label}</Link>)}
          {getCreditsConfig() && <Link to="/recharge" onClick={() => drawer.current?.close()} className="flex min-h-12 items-center gap-3 rounded-xl bg-[#efedfd] px-4 text-sm font-semibold text-[#7955ed]"><IconCoin className="h-5 w-5" />积分充值</Link>}
          <Link to="/help" onClick={() => drawer.current?.close()} className="flex min-h-12 items-center gap-3 px-4 text-sm"><IconHelp className="h-5 w-5" />帮助中心</Link>
          {isAdmin() && <Link to="/admin" onClick={() => drawer.current?.close()} className="flex min-h-12 items-center gap-3 px-4 text-sm"><IconShield className="h-5 w-5" />管理后台</Link>}
        </nav>
      </dialog>
    </div>
  )
}
