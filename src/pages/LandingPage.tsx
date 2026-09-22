// 首页（未登录落地页）：主视觉插画 + 标语 + 特性卡片 + 作品流。对应设计稿 1。
import { Link } from 'react-router-dom'
import { PublicNav, SiteFooter, BRAND_SLOGAN } from './theme'
import { useInApp } from './useInApp'
import { IconSparkle, IconBolt, IconCoin, IconShield, IconArrowRight, IconHeart, IconEye } from './icons'

const FEATURES = [
  { icon: IconSparkle, title: '高质量生成', desc: '多种风格模型任选，细节拉满' },
  { icon: IconBolt, title: '简单易用', desc: '一句话描述，一键生成' },
  { icon: IconCoin, title: '积分付费', desc: '按量计费，用多少花多少' },
  { icon: IconShield, title: '安全可靠', desc: '保护你的创作与隐私' },
]

/** 作品流用的示例图（AI 生成的风格示例），让首页有"社区已经在创作"的氛围 */
const SHOWCASE = [
  { img: '/art/work-train.jpg', title: '星空下的列车', likes: '1.2k' },
  { img: '/art/work-seaside.jpg', title: '海边的少女', likes: '986' },
  { img: '/art/work-cyber.jpg', title: '霓虹雨夜', likes: '2.1k' },
  { img: '/art/work-hanfu.jpg', title: '桃花依旧', likes: '764' },
  { img: '/art/work-sakura.jpg', title: '樱花街道', likes: '1.5k' },
  { img: '/art/work-cat.jpg', title: '温柔的猫', likes: '2.8k' },
]

export default function LandingPage() {
  // 已登录的话不再劝注册：顶部和底部 CTA 都换成「继续创作」。
  // inApp 尚未确定（undefined）时按未登录渲染，首屏不空着等一个导航栏。
  const inApp = useInApp() === true

  return (
    <div className="min-h-screen bg-[#f5f4fb] text-[#37335c]">
      <PublicNav active="home" overlay inApp={inApp} />

      {/* 主视觉：左侧标语 + 右侧插画 */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[#efedfd] via-[#f5f4fb] to-[#e3f0ff]" />
        <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-5 pb-16 pt-14 md:grid-cols-2 md:pb-24 md:pt-20">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#dcd8f0] bg-white/80 px-3.5 py-1.5 text-xs font-medium text-[#6b5ce7]">
              <IconSparkle className="h-3.5 w-3.5" />
              AI 图像创作平台
            </span>
            <h1 className="mt-5 text-4xl font-bold leading-[1.2] tracking-tight md:text-[44px]">
              用 <span className="bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] bg-clip-text text-transparent">AI</span> · 绘出无限想象
            </h1>
            <p className="mt-4 max-w-md text-[15px] leading-7 text-[#6f6a94]">
              一句话，让你的想象变成看得见的世界。{BRAND_SLOGAN}，无需学习复杂的提示词工程。
            </p>
            <div className="mt-8 flex items-center gap-4">
              <Link
                to="/studio"
                className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] px-8 py-3.5 text-[15px] font-semibold text-white shadow-xl shadow-[#7c6cf6]/35 transition hover:from-[#6b5ce7] hover:to-[#9678f5]"
              >
                立即创作
                <IconArrowRight className="h-4 w-4" />
              </Link>
              <Link to="/gallery" className="text-sm font-medium text-[#6b5ce7] transition hover:text-[#5a4cd6]">
                逛逛作品广场 →
              </Link>
            </div>
          </div>

          <div className="relative">
            <div className="overflow-hidden rounded-[28px] shadow-2xl shadow-[#7c6cf6]/20 ring-1 ring-white/60">
              <img src="/art/hero.jpg" alt="绘想 AI 主视觉" className="aspect-[3/2] w-full object-cover" />
            </div>
            {/* 漂浮的提示词气泡，增加灵动感 */}
            <div className="absolute -bottom-4 left-6 rounded-2xl border border-white/70 bg-white/90 px-4 py-2.5 text-xs text-[#6f6a94] shadow-lg backdrop-blur">
              「银发少女与水晶蝴蝶，梦幻云海」
            </div>
          </div>
        </div>
      </section>

      {/* 特性卡片 */}
      <section className="mx-auto max-w-6xl px-5 pb-16">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="rounded-2xl border border-[#eceaf6] bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-lg hover:shadow-[#7c6cf6]/10">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-[#efedfd] to-[#e3f0ff] text-[#7c6cf6]">
                <feature.icon className="h-5 w-5" />
              </span>
              <h3 className="mt-4 text-[15px] font-bold">{feature.title}</h3>
              <p className="mt-1.5 text-[13px] leading-6 text-[#8a86ac]">{feature.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 灵感作品流 */}
      <section className="mx-auto max-w-6xl px-5 pb-20">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-2xl font-bold">来自创作者的灵感</h2>
            <p className="mt-1.5 text-sm text-[#8a86ac]">看看大家用绘想画出了什么</p>
          </div>
          <Link to="/gallery" className="text-sm font-medium text-[#6b5ce7] transition hover:text-[#5a4cd6]">
            查看全部 →
          </Link>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          {SHOWCASE.map((work) => (
            <Link key={work.title} to="/gallery" className="group overflow-hidden rounded-2xl border border-[#eceaf6] bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-lg">
              <div className="overflow-hidden">
                <img src={work.img} alt={work.title} loading="lazy" className="aspect-square w-full object-cover transition duration-300 group-hover:scale-105" />
              </div>
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className="truncate text-xs font-medium">{work.title}</span>
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-[#a5a1c4]">
                  <IconHeart className="h-3 w-3" filled />
                  {work.likes}
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* 底部 CTA */}
      <section className="mx-auto max-w-6xl px-5 pb-20">
        <div className="relative overflow-hidden rounded-[28px] bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] px-8 py-14 text-center text-white shadow-2xl shadow-[#7c6cf6]/30">
          <div className="pointer-events-none absolute -left-20 -top-24 h-64 w-64 rounded-full bg-white/10 blur-2xl" />
          <div className="pointer-events-none absolute -bottom-24 -right-16 h-64 w-64 rounded-full bg-white/10 blur-2xl" />
          <h2 className="relative text-2xl font-bold md:text-3xl">每一个想象，都值得被看见</h2>
          <p className="relative mt-3 text-sm text-white/80">
            {inApp ? '接着上次的灵感，继续画下去' : '注册即送体验积分，第一张图免费画'}
          </p>
          <Link to={inApp ? '/studio' : '/register'} className="relative mt-7 inline-flex items-center gap-2 rounded-full bg-white px-8 py-3.5 text-[15px] font-semibold text-[#6b5ce7] shadow-lg transition hover:bg-[#f5f4fb]">
            <IconEye className="h-4 w-4" />
            {inApp ? '继续创作' : '免费开始创作'}
          </Link>
        </div>
      </section>

      <SiteFooter />
    </div>
  )
}
