// 纯前端模式（本地没起后端 / 静态部署）下点进登录注册页时的说明页。
// 这里原本是直接 <Navigate to="/studio">，用户点「登录」「注册」等于被静默弹走，
// 看起来就像按钮坏了；现在明确说明为什么没有账号体系，并给出下一步。
import { Link } from 'react-router-dom'
import AuthLayout from './AuthLayout'
import { PRIMARY_BTN, GHOST_BTN } from '../theme'
import { IconShield } from '../icons'

const PAGES = {
  login: {
    image: '/art/auth-login.jpg',
    quote: '灵感，从这里开始',
    quoteSub: 'Every idea starts here.',
    title: '欢迎回来',
    subtitle: '继续使用 AI 创造美好',
    action: '登录',
  },
  register: {
    image: '/art/auth-register.jpg',
    quote: '每一个想象，都值得被看见',
    quoteSub: 'Every imagination deserves to be seen.',
    title: '开启你的 AI 创作之旅',
    subtitle: '邮箱收个验证码就能开通',
    action: '注册',
  },
  forgot: {
    image: '/art/auth-forgot.jpg',
    quote: '别担心，你的创作不会丢失',
    quoteSub: "Don't worry, your creations are safe.",
    title: '找回密码',
    subtitle: '验证邮箱后即可重设密码',
    action: '找回密码',
  },
} as const

export default function NoAccountSystemNotice({ page }: { page: keyof typeof PAGES }) {
  const config = PAGES[page]
  return (
    <AuthLayout
      image={config.image}
      quote={config.quote}
      quoteSub={config.quoteSub}
      title={config.title}
      subtitle={config.subtitle}
    >
      <div className="rounded-2xl border border-[#eceaf6] bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#efedfd] text-[#7c6cf6]">
            <IconShield className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold">本站未启用账号系统</h2>
            <p className="mt-1.5 text-[13px] leading-6 text-[#8a86ac]">
              当前没有连接后端服务，所以没有{config.action}功能，创作数据只保存在这台设备的浏览器里。
              如果你正在本地调试，先启动后端即可：<code className="rounded bg-[#f5f4fb] px-1.5 py-0.5 text-[12px] text-[#6b5ce7]">npm run server</code>
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link to="/studio" className={PRIMARY_BTN}>直接开始创作</Link>
          <Link to="/" className={GHOST_BTN}>返回首页</Link>
        </div>
      </div>
    </AuthLayout>
  )
}

/**
 * 微信扫码登录还没对接（公众号 / 小程序都还没申请），
 * 但站点访问方式被配成了「微信扫码」——这时不能给一个永远扫不开的二维码，
 * 要明确说清现状，并告诉管理员怎么改回来。
 */
export function WechatLoginUnavailable() {
  return (
    <AuthLayout
      image="/art/auth-login.jpg"
      quote="灵感，从这里开始"
      quoteSub="Every idea starts here."
      title="欢迎回来"
      subtitle="继续使用 AI 创造美好"
    >
      <div className="rounded-2xl border border-[#eceaf6] bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#fffbeb] text-[#d97706]">
            <IconShield className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold">
              微信扫码登录
              <span className="ml-2 rounded-full bg-[#fff7ed] px-2 py-0.5 text-[11px] font-medium text-[#ea580c]">开发中</span>
            </h2>
            <p className="mt-1.5 text-[13px] leading-6 text-[#8a86ac]">
              本站目前把访问方式设成了「微信扫码」，但微信登录还没上线，所以现在谁都进不来。
              <br />
              管理员请到后台「站点设置」把访问方式改成「多用户账号」，用户就能用邮箱验证码注册、账号密码登录了。
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link to="/" className={GHOST_BTN}>返回首页</Link>
        </div>
      </div>
    </AuthLayout>
  )
}
