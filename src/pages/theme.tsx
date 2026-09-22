// 「绘想」设计基座：品牌标识、配色与通用控件样式。
// 视觉基调是紫罗兰渐变 + 浅薰衣草底 + 白色圆角卡片，对应设计稿的梦幻插画风。
import { Link, NavLink } from 'react-router-dom'
import { IconSparkle } from './icons'

export const BRAND_NAME = '绘想'
export const BRAND_SLOGAN = '用 AI · 绘出无限想象'

/** 主按钮：紫罗兰渐变胶囊 */
export const PRIMARY_BTN =
  'inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-[#7c6cf6]/30 transition hover:from-[#6b5ce7] hover:to-[#9678f5] hover:shadow-[#7c6cf6]/40 disabled:cursor-not-allowed disabled:from-gray-200 disabled:to-gray-200 disabled:text-gray-400 disabled:shadow-none'

/** 次要按钮：白底描边 */
export const GHOST_BTN =
  'inline-flex items-center justify-center gap-2 rounded-full border border-[#dcd8f0] bg-white px-6 py-3 text-sm font-medium text-[#5b5680] transition hover:border-[#7c6cf6] hover:text-[#7c6cf6]'

/** 表单输入框 */
export const TEXT_INPUT =
  'w-full rounded-xl border border-[#e4e1f2] bg-[#faf9fe] px-4 py-3 text-sm text-[#37335c] outline-none transition placeholder:text-[#a5a1c4] hover:border-[#c9c3ea] focus:border-[#7c6cf6] focus:bg-white focus:ring-4 focus:ring-[#7c6cf6]/10 disabled:cursor-not-allowed disabled:text-gray-400'

/** 页面浅底 */
export const PAGE_BG = 'min-h-screen bg-[#f5f4fb] text-[#37335c]'

/** 等后端 bootstrap 时的整页占位：什么都不画会让人以为站点挂了 */
export function PageLoading({ text = '正在加载…' }: { text?: string }) {
  return (
    <div className={PAGE_BG}>
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <span className="h-9 w-9 animate-spin rounded-full border-[3px] border-[#e4e1f2] border-t-[#7c6cf6]" />
        <p className="text-sm text-[#8a86ac]">{text}</p>
      </div>
    </div>
  )
}

/** 品牌 Logo：星形图标 + 绘想字标。应用内传 to="/studio"，免得点一下跳出应用。 */
export function Logo({ light, size = 'md', to = '/' }: { light?: boolean, size?: 'md' | 'lg', to?: string }) {
  const box = size === 'lg' ? 'h-11 w-11 rounded-xl text-xl' : 'h-9 w-9 rounded-lg text-base'
  const text = size === 'lg' ? 'text-2xl' : 'text-lg'
  return (
    <Link to={to} className="flex items-center gap-2.5">
      <span className={`flex items-center justify-center bg-gradient-to-br from-[#7c6cf6] to-[#a78bfa] font-bold text-white shadow-md shadow-[#7c6cf6]/30 ${box}`}>
        绘
      </span>
      <span className={`font-bold tracking-wide ${text} ${light ? 'text-white' : 'text-[#37335c]'}`}>
        {BRAND_NAME}
      </span>
    </Link>
  )
}

/** 公开页底部：品牌标语 + 开源署名。署名是 MIT 许可要求保留的，别删。 */
export function SiteFooter() {
  return (
    <footer className="border-t border-[#eceaf6] py-8 text-center text-xs text-[#a5a1c4]">
      <p>绘想 · 用 AI 绘出无限想象</p>
      <p className="mt-2">
        基于开源项目{' '}
        <a
          href="https://github.com/CookSleep/gpt_image_playground"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#8a86ac] underline underline-offset-2 transition hover:text-[#6b5ce7]"
        >
          GPT Image Playground
        </a>
        {' '}(@CookSleep, MIT License) 修改
      </p>
    </footer>
  )
}

/**
 * 公开页顶部导航：首页 / AI 绘画 / 作品广场 / 价格与积分 / 帮助中心。
 * inApp 为真说明访问者已经在应用里了，右侧换成「进入创作」——已登录还劝人注册很怪。
 */
export function PublicNav({ active, overlay, inApp }: { active?: string, overlay?: boolean, inApp?: boolean }) {
  const items = [
    { label: '首页', to: '/', key: 'home' },
    { label: 'AI 绘画', to: '/studio', key: 'studio' },
    { label: '作品广场', to: '/gallery', key: 'gallery' },
    { label: '价格与积分', to: '/pricing', key: 'pricing' },
    { label: '帮助中心', to: '/help', key: 'help' },
  ]
  return (
    <header className={`sticky top-0 z-40 ${overlay ? 'bg-white/70 backdrop-blur-xl' : 'border-b border-[#eceaf6] bg-white/85 backdrop-blur-xl'}`}>
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <Logo />
        <nav className="hidden items-center gap-1 md:flex">
          {items.map((item) => (
            <NavLink
              key={item.key}
              to={item.to}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                active === item.key
                  ? 'bg-[#efedfd] text-[#6b5ce7]'
                  : 'text-[#6f6a94] hover:bg-[#f3f2fb] hover:text-[#37335c]'
              }`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        {inApp ? (
          <Link to="/studio" className={`${PRIMARY_BTN} !px-5 !py-2`}>
            <IconSparkle className="h-4 w-4" />
            进入创作
          </Link>
        ) : (
          <div className="flex items-center gap-2.5">
            <Link to="/login" className="rounded-full px-4 py-2 text-sm font-medium text-[#6f6a94] transition hover:text-[#37335c]">
              登录
            </Link>
            <Link to="/register" className={`${PRIMARY_BTN} !px-5 !py-2`}>
              <IconSparkle className="h-4 w-4" />
              注册
            </Link>
          </div>
        )}
      </div>
    </header>
  )
}
