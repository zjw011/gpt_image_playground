// 认证页布局：左表单 + 右侧梦幻插画面板（带一句氛围文案）。对应设计稿 2/3/4。
import { Logo } from '../theme'

interface Props {
  /** 右侧插画地址 */
  image: string
  /** 插画上的氛围文案 */
  quote: string
  quoteSub?: string
  title: string
  subtitle: string
  children: React.ReactNode
}

export default function AuthLayout({ image, quote, quoteSub, title, subtitle, children }: Props) {
  return (
    <div className="flex min-h-screen bg-[#f5f4fb] text-[#37335c]">
      {/* 表单区 */}
      <section className="flex w-full flex-col px-6 py-8 sm:px-12 lg:w-[52%] lg:px-16">
        <Logo />
        <div className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">
          <h1 className="text-[26px] font-bold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-[#8a86ac]">{subtitle}</p>
          <div className="mt-8">{children}</div>
        </div>
      </section>

      {/* 插画区：窄屏隐藏，让表单独占首屏 */}
      <section className="relative hidden flex-1 overflow-hidden lg:block">
        <img src={image} alt="" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#3b2f6b]/60 via-transparent to-transparent" />
        <div className="absolute bottom-14 left-10 right-10 text-white">
          <p className="text-2xl font-bold leading-snug drop-shadow-md">{quote}</p>
          {quoteSub && <p className="mt-2 text-sm italic text-white/75">{quoteSub}</p>}
        </div>
      </section>
    </div>
  )
}
