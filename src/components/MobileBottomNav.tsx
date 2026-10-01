import { Link, useLocation } from 'react-router-dom'
import { IconHome, IconToolbox, IconImage, IconUser } from '../pages/icons'

const ITEMS = [
  { label: '首页', to: '/', icon: IconHome },
  { label: '创作', to: '/tools', icon: IconToolbox },
  { label: '作品', to: '/me?tab=works', icon: IconImage },
  { label: '我的', to: '/me?tab=settings', icon: IconUser },
]

export default function MobileBottomNav() {
  const location = useLocation()
  const tab = new URLSearchParams(location.search).get('tab') || 'works'
  const active = location.pathname === '/' ? '首页'
    : ['/studio', '/tools', '/result'].includes(location.pathname) ? '创作'
    : location.pathname === '/me' && ['works', 'favorites'].includes(tab) ? '作品'
    : location.pathname === '/me' || location.pathname === '/recharge' ? '我的' : ''

  return (
    <nav aria-label="手机底部导航" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-[#eceaf6] bg-white/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
      {ITEMS.map((item) => (
        <Link key={item.label} to={item.to} aria-current={active === item.label ? 'page' : undefined} className={`flex min-h-[60px] flex-col items-center justify-center gap-1 text-[11px] font-medium ${active === item.label ? 'text-[#7955ed]' : 'text-[#8a86ac]'}`}>
          <item.icon className="h-5 w-5" />{item.label}
        </Link>
      ))}
    </nav>
  )
}
