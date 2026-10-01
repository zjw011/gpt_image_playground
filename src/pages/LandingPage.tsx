import { Link } from 'react-router-dom'
import { PublicNav, SiteFooter, PRIMARY_BTN, GHOST_BTN } from './theme'
import SafeImg from '../components/SafeImg'
import { assetUrl } from '../lib/assetUrl'
import { useInApp } from './useInApp'
import { IconSparkle, IconBolt, IconCoin, IconShield, IconArrowRight } from './icons'

const TOOLS = [
  { title: 'AI 绘画', desc: '输入文字，让灵感成为画面', to: '/studio', img: '/art/work-seaside.jpg', color: 'from-[#f1e9ff] to-[#faf6ff]' },
  { title: '图生图', desc: '上传图片，探索新的风格', to: '/studio?mode=image', img: '/art/work-cat.jpg', color: 'from-[#e2efff] to-[#f5faff]' },
  { title: '局部重绘', desc: '涂抹选区，精细调整细节', to: '/studio?mode=inpaint', img: '/art/auth-register.jpg', color: 'from-[#ffe6f0] to-[#fff7fa]' },
  { title: 'AI 扩图', desc: '保留主体，自然延展画面', to: '/studio?mode=outpaint', img: '/art/work-train.jpg', color: 'from-[#dff4ef] to-[#f5fcfa]' },
  { title: '电商设计', desc: '商品精修与营销场景设计', to: '/tools?tool=ecommerce', img: '/art/tool-commerce.svg', color: 'from-[#ffe5c9] to-[#fff8ed]' },
  { title: '商品电商套图', desc: '同一商品，统一视觉素材', to: '/tools?tool=product-suite', img: '/art/tool-product-suite.svg', color: 'from-[#dce8ff] to-[#f2f7ff]' },
  { title: 'Live 实况图', desc: '让静态照片轻轻动起来', to: '/tools?tool=live', img: '/art/work-hanfu.jpg', color: 'from-[#e9ddff] to-[#faf6ff]' },
]

const FEATURES = [
  { icon: IconSparkle, title: '多场景创作', desc: '绘画、图像编辑、商品素材与轻微动态' },
  { icon: IconBolt, title: '简单易用', desc: '描述画面，选择风格，开始创作' },
  { icon: IconCoin, title: '积分清晰', desc: '提交前查看消耗，积分中心查询记录' },
  { icon: IconShield, title: '作品随时查看', desc: '在我的作品中查看任务与生成结果' },
]

const SHOWCASE = [
  { img: '/art/work-hanfu.jpg', title: '桃花依旧', style: '国风灵感' },
  { img: '/art/work-cyber.jpg', title: '霓虹雨夜', style: '赛博城市' },
  { img: '/art/work-seaside.jpg', title: '海边的少女', style: '动漫画面' },
  { img: '/art/work-train.jpg', title: '星空下的列车', style: '氛围场景' },
  { img: '/art/work-sakura.jpg', title: '樱花街道', style: '春日插画' },
  { img: '/art/work-cat.jpg', title: '温柔的猫', style: '萌宠灵感' },
]

export default function LandingPage() {
  const inApp = useInApp() === true

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#f4f0ff] via-white to-[#f7f6fc] text-[#292650]">
      <PublicNav active="home" overlay inApp={inApp} />
      <main>
        <section className="relative mx-auto max-w-7xl overflow-hidden px-5 pb-10 pt-8 sm:pt-12 lg:pb-16">
          <div className="relative isolate overflow-hidden rounded-[32px] border border-white bg-[#eee9fc] shadow-xl shadow-[#a899dc]/10">
            <SafeImg src={assetUrl('/art/hero.jpg')} alt="云海与水晶蝴蝶中的少女，绘想 AI 插画" loading="eager" className="absolute inset-0 h-full w-full object-cover object-[65%_center]" />
            <div className="absolute inset-0 bg-gradient-to-r from-[#f5f1ff] via-[#f5f1ff]/90 to-transparent md:via-[#f5f1ff]/60" />
            <div className="relative max-w-xl px-6 py-14 sm:px-10 sm:py-20 lg:px-14 lg:py-24">
              <span className="inline-flex items-center gap-2 rounded-full border border-white bg-white/75 px-3 py-1.5 text-xs font-semibold text-[#7762dc]"><IconSparkle className="h-4 w-4" />让想象，变成图像</span>
              <h1 className="mt-6 text-4xl font-bold leading-[1.25] tracking-tight sm:text-5xl">用 <span className="text-[#7955ed]">AI</span> · 绘出<br className="sm:hidden" />无限想象</h1>
              <p className="mt-5 max-w-sm text-sm leading-7 text-[#6d658b] sm:text-base">从一句描述开始，探索绘画、图像编辑、商品设计和 Live 实况创作。让每一个灵感，都有自己的画面。</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link to="/studio" className={PRIMARY_BTN}>立即创作<IconArrowRight className="h-4 w-4" /></Link>
                <Link to="/gallery" className={`${GHOST_BTN} !bg-white/70`}>逛逛作品广场</Link>
              </div>
              <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-xs font-medium text-[#776b98]"><span>文字与图片创作</span><span>多种内置风格</span><span>作品进度随时查看</span></div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-5 pb-14">
          <div className="flex items-center justify-between gap-4"><div><h2 className="text-xl font-bold sm:text-2xl">选择你的创作方式</h2><p className="mt-2 text-xs leading-5 text-[#8a80a4] sm:text-sm">熟悉的工具，更直接的入口。点击卡片就能开始。</p></div><Link to="/tools" className="shrink-0 text-xs font-semibold text-[#7955ed] sm:text-sm">专业工具 →</Link></div>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
            {TOOLS.map((tool) => (
              <Link key={tool.title} to={tool.to} className={`group overflow-hidden rounded-2xl border border-[#e7e0f6] bg-gradient-to-b ${tool.color} shadow-sm transition hover:-translate-y-1 hover:border-[#b8a7f5] hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#7955ed]`}>
                <div className="relative aspect-[5/4] overflow-hidden">
                  <img src={assetUrl(tool.img)} alt="" loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                  {tool.title === 'Live 实况图' && <span className="absolute bottom-2 right-2 rounded-full bg-white/90 px-2 py-1 text-[10px] font-bold text-[#6b5ce7]">LIVE</span>}
                </div>
                <div className="p-3"><div className="flex items-center justify-between gap-1"><h3 className="text-sm font-bold">{tool.title}</h3><IconArrowRight className="h-4 w-4 shrink-0 text-[#8061df]" /></div><p className="mt-1.5 text-[11px] leading-5 text-[#7f739a]">{tool.desc}</p></div>
              </Link>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-5 pb-14">
          <div className="flex items-center justify-between gap-4"><div><h2 className="text-xl font-bold sm:text-2xl">灵感画廊</h2><p className="mt-2 text-xs leading-5 text-[#8a80a4] sm:text-sm">AI 生成的风格示例，发现下一张图的方向</p></div><Link to="/gallery" className="shrink-0 text-xs font-semibold text-[#7955ed] sm:text-sm">探索作品广场 →</Link></div>
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {SHOWCASE.map((work) => (
              <Link key={work.title} to="/gallery" className="group relative overflow-hidden rounded-2xl bg-[#eee9fc] shadow-sm transition hover:-translate-y-1 hover:shadow-lg">
                <img src={assetUrl(work.img)} alt={work.title} loading="lazy" className="aspect-[3/4] w-full object-cover transition duration-500 group-hover:scale-105" />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#211536]/85 to-transparent px-4 pb-4 pt-12 text-white"><span className="text-[10px] text-white/80">{work.style}</span><h3 className="mt-1 text-sm font-semibold">{work.title}</h3></div>
              </Link>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-5 pb-14">
          <h2 className="text-xl font-bold sm:text-2xl">为什么选择绘想？</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{FEATURES.map((feature) => <div key={feature.title} className="flex gap-4 rounded-2xl border border-[#ece7f7] bg-white/80 p-5"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#f0eaff] text-[#8865ef]"><feature.icon className="h-5 w-5" /></span><div><h3 className="text-sm font-bold">{feature.title}</h3><p className="mt-2 text-xs leading-6 text-[#8a80a4]">{feature.desc}</p></div></div>)}</div>
        </section>

        <section className="mx-auto max-w-7xl px-5 pb-16">
          <div className="flex flex-wrap items-center justify-between gap-6 rounded-[28px] bg-gradient-to-r from-[#33236b] via-[#53409d] to-[#8160d6] px-7 py-10 text-white sm:px-12">
            <div><h2 className="text-2xl font-bold">每一个想象，都值得被看见</h2><p className="mt-3 text-sm text-white/75">{inApp ? '接着上次的灵感，继续画下去' : '创建账号，开始你的第一幅作品'}</p></div>
            <Link to={inApp ? '/studio' : '/register'} className="inline-flex items-center gap-2 rounded-full bg-white px-7 py-3 text-sm font-semibold text-[#6b5ce7] transition hover:bg-[#f0eaff]">{inApp ? '继续创作' : '免费开始创作'}<IconArrowRight className="h-4 w-4" /></Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  )
}
