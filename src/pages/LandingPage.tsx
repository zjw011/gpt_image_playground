import { Link } from 'react-router-dom'
import { PublicNav, SiteFooter, PRIMARY_BTN, GHOST_BTN, BrandMark } from './theme'
import SafeImg from '../components/SafeImg'
import { assetUrl } from '../lib/assetUrl'
import { useInApp } from './useInApp'
import { IconSparkle, IconBolt, IconCoin, IconShield, IconArrowRight, IconImage } from './icons'

const TOOLS = [
  { title: 'AI 绘画', desc: '输入文字，生成想象中的画面', to: '/studio', img: '/art/hero-home-v2.jpg', position: '80% 35%', color: 'from-[#efe4ff] to-[#faf6ff]', accent: '#8a48db' },
  { title: '图生图', desc: '上传图片，探索新的风格', to: '/studio?mode=image', img: '/art/work-cat.jpg', position: 'center', color: 'from-[#e3edff] to-[#f6f9ff]', accent: '#6676f4' },
  { title: '局部重绘', desc: '涂抹选区，精细调整细节', to: '/studio?mode=inpaint', img: '/art/hero-home-v2.jpg', position: '80% 25%', color: 'from-[#ffe3f0] to-[#fff7fa]', accent: '#df4d96' },
  { title: 'AI 扩图', desc: '延展画面，让创意更开阔', to: '/studio?mode=outpaint', img: '/art/work-train.jpg', position: 'center', color: 'from-[#def4ee] to-[#f5fcfa]', accent: '#2eaa96' },
  { title: '电商设计', desc: '商品精修与营销场景设计', to: '/tools?tool=ecommerce', img: '/art/cover-commerce-v2.jpg', position: 'center', color: 'from-[#ffe7cb] to-[#fff8ed]', accent: '#b97537' },
  { title: '商品电商套图', desc: '同一商品，统一视觉素材', to: '/tools?tool=product-suite', img: '/art/cover-suite-v2.jpg', position: 'center', color: 'from-[#dce8ff] to-[#f2f7ff]', accent: '#497bea' },
  { title: 'Live 实况图', desc: '让静态照片轻轻动起来', to: '/tools?tool=live', img: '/art/hero-home-v2.jpg', position: '80% 40%', color: 'from-[#e9ddff] to-[#faf6ff]', accent: '#9861d9' },
]

const FEATURES = [
  { icon: IconSparkle, title: '多场景创作', desc: '绘画、编辑、商品设计与实况创作' },
  { icon: IconBolt, title: '简单易用', desc: '描述画面，选择风格，开始创作' },
  { icon: IconCoin, title: '积分清晰', desc: '提交前看消耗，积分中心查记录' },
  { icon: IconShield, title: '作品随时查看', desc: '任务进度与生成结果都有迹可循' },
]

const SHOWCASE = [
  { img: '/art/work-hanfu.jpg', title: '桃花依旧', style: '国风灵感' },
  { img: '/art/work-cyber.jpg', title: '霓虹雨夜', style: '赛博城市' },
  { img: '/art/hero-home-v2.jpg', title: '蝴蝶与光', style: '人物插画' },
  { img: '/art/cover-commerce-v2.jpg', title: '花间香气', style: '商品视觉' },
  { img: '/art/work-train.jpg', title: '星空下的列车', style: '氛围场景' },
  { img: '/art/work-cat.jpg', title: '温柔的猫', style: '萌宠灵感' },
]

const SCENES = [
  { title: '商品视觉设计', desc: '让商品拥有更好的展示画面', img: '/art/cover-commerce-v2.jpg', to: '/tools?tool=ecommerce' },
  { title: '成套营销素材', desc: '围绕同一商品，延续统一风格', img: '/art/cover-suite-v2.jpg', to: '/tools?tool=product-suite' },
  { title: 'Live 轻微动态', desc: '留住一瞬间，也让它轻轻动起来', img: '/art/hero-home-v2.jpg', to: '/tools?tool=live' },
  { title: '东方国风创作', desc: '在细腻光影里，寻找东方意境', img: '/art/work-hanfu.jpg', to: '/studio' },
]

export default function LandingPage() {
  const inApp = useInApp() === true

  return (
    <div className="min-h-screen bg-[#fcfbff] text-[#211b4f]">
      <PublicNav active="home" overlay inApp={inApp} />
      <main>
      <div className="relative isolate bg-[#f4efff]">
        <SafeImg src={assetUrl('/art/hero-home-v2.jpg')} alt="流光蝴蝶与长发少女，绘想创作主视觉" loading="eager" className="pointer-events-none absolute inset-0 -z-10 h-full w-full object-cover object-[75%_top] md:object-top" />
        <div className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-r from-[#f8f5ff]/95 via-[#f8f5ff]/80 to-[#f8f5ff]/75 md:via-transparent md:to-transparent" />
          <section className="relative mx-auto max-w-7xl px-5 pb-24 pt-10 sm:pt-16 lg:min-h-[470px] lg:pb-28">
            <div className="relative max-w-xl">
              <p className="flex items-center gap-2 text-sm font-medium tracking-[0.15em] text-[#7754bc]">让想象，变成图像<IconSparkle className="h-4 w-4" /></p>
              <h1 className="mt-6 text-4xl font-bold leading-[1.25] tracking-tight sm:text-5xl lg:text-[52px]">用 <span className="text-[#814aff]">AI</span> · 绘出<br className="sm:hidden" />无限想象</h1>
              <p className="mt-5 max-w-lg text-sm leading-7 text-[#746697] sm:text-base">集 AI 绘画、图像编辑、电商设计与 Live 实况于一体。<br className="hidden sm:block" />从一个灵感开始，找到属于你的创作方式。</p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Link to="/studio" className={PRIMARY_BTN}>立即创作<IconArrowRight className="h-4 w-4" /></Link>
                <Link to="/gallery" className={`${GHOST_BTN} !bg-white/65`}>探索作品广场</Link>
              </div>
              <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-xs font-medium text-[#72648f]">
                <span className="inline-flex items-center gap-2"><IconImage className="h-4 w-4 text-[#976af4]" />多场景创作</span>
                <span className="inline-flex items-center gap-2"><IconSparkle className="h-4 w-4 text-[#976af4]" />内置风格</span>
                <span className="inline-flex items-center gap-2"><IconBolt className="h-4 w-4 text-[#976af4]" />进度随时查看</span>
              </div>
            </div>
            <p className="absolute bottom-24 right-8 hidden rounded-full border border-white/90 bg-white/85 px-5 py-2.5 text-xs text-[#8a70b7] shadow-lg shadow-[#8664c5]/10 backdrop-blur lg:block">一段描述，一幅属于你的作品 <span className="ml-3 text-[#976af4]">✦</span></p>
          </section>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-[#fcfbff] to-transparent" />
      </div>

      <div className="relative">
        <section aria-label="创作工具" className="relative mx-auto -mt-16 max-w-7xl px-5 pb-10">
          <h2 className="sr-only">选择你的创作方式</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
            {TOOLS.map((tool, idx) => (
              <Link key={tool.title} to={tool.to} className={`group overflow-hidden rounded-xl border bg-gradient-to-b ${tool.color} shadow-md shadow-[#9d81cc]/10 transition hover:-translate-y-1 hover:shadow-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#7955ed] ${idx === 0 ? 'border-[#b79afa] ring-2 ring-[#a080ef]/35' : 'border-[#ebe3fa] hover:border-[#b8a7f5]'}`}>
                <div className="relative aspect-square overflow-hidden lg:aspect-[4/5]">
                  <img src={assetUrl(tool.img)} alt="" loading="lazy" style={{ objectPosition: tool.position }} className={`h-full w-full object-cover transition duration-500 group-hover:scale-105 ${idx === 2 ? 'scale-125 group-hover:scale-[1.3]' : ''}`} />
                  {idx === 2 && <span aria-hidden="true" className="absolute right-[18%] top-[25%] h-9 w-9 rounded-xl border border-dashed border-white/90 shadow-sm" />}
                  {tool.title === 'Live 实况图' && <span className="absolute bottom-3 right-3 flex h-8 w-8 items-center justify-center rounded-full bg-white/95 text-xs font-bold text-[#7752bf] shadow-sm">▶</span>}
                </div>
                <div className="p-3"><div className="flex items-center justify-between gap-1"><h3 className="text-[13px] font-bold">{tool.title}</h3><span style={{ backgroundColor: tool.accent }} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white"><IconArrowRight className="h-3.5 w-3.5" /></span></div><p className="mt-1.5 text-[10px] leading-5 text-[#7f739a]">{tool.desc}</p></div>
              </Link>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-5 pb-12">
          <div className="flex items-center justify-between gap-4"><h2 className="flex items-center gap-2.5 text-xl font-bold"><IconSparkle className="h-6 w-6 text-[#9761f5]" />更多专业工具</h2><Link to="/tools" className="text-xs font-semibold text-[#8a5ee9]">查看全部工具 →</Link></div>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {TOOLS.slice(4).map((tool) => <Link key={tool.title} to={tool.to} className="group flex items-center gap-4 rounded-xl border border-[#ece6f7] bg-gradient-to-r from-white to-[#f5f2ff] px-4 py-3 transition hover:border-[#c1a8ed] hover:shadow-md"><img src={assetUrl(tool.img)} alt="" loading="lazy" style={{ objectPosition: tool.position }} className="h-12 w-12 shrink-0 rounded-xl object-cover" /><div className="min-w-0"><h3 className="text-sm font-bold">{tool.title}</h3><p className="mt-1 text-[11px] text-[#8c7da6]">{tool.desc}</p></div><IconArrowRight className="ml-auto h-4 w-4 shrink-0 text-[#a58acb]" /></Link>)}
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-5 pb-12">
          <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-x-5 gap-y-2"><h2 className="flex items-center gap-2.5 text-xl font-bold"><IconImage className="h-6 w-6 text-[#9761f5]" />灵感画廊</h2><span className="text-xs text-[#9585ad]">AI 生成的风格示例</span></div><Link to="/gallery" className="text-xs font-semibold text-[#8a5ee9]">探索作品广场 →</Link></div>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {SHOWCASE.map((work) => <Link key={work.title} to="/gallery" className="group relative overflow-hidden rounded-xl bg-[#eee9fc] shadow-sm transition hover:-translate-y-1 hover:shadow-lg"><img src={assetUrl(work.img)} alt={work.title} loading="lazy" style={{ objectPosition: work.img.includes('hero-home') ? '80% 35%' : 'center' }} className="aspect-[3/4] w-full object-cover transition duration-500 group-hover:scale-105" /><div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#211536]/80 to-transparent px-3 pb-3 pt-12 text-white"><span className="text-[10px] text-white/80">{work.style}</span><h3 className="mt-1 text-xs font-semibold">{work.title}</h3></div></Link>)}
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-5 pb-12">
          <div className="relative isolate flex flex-wrap items-center justify-between gap-6 overflow-hidden rounded-2xl bg-gradient-to-r from-[#292052] via-[#42317e] to-[#5f45a9] px-6 py-8 text-white sm:px-10">
            <div className="pointer-events-none absolute -right-16 -top-20 -z-10 h-72 w-72 rounded-full bg-[#b477ff]/20 blur-3xl" />
            <div className="flex items-center gap-5"><BrandMark className="hidden h-20 w-20 sm:block" /><div><h2 className="text-xl font-bold sm:text-2xl">每一个想象，都值得被看见</h2><p className="mt-3 text-xs text-white/65">{inApp ? '接着上次的灵感，继续画下去' : '创建账号，开始你的第一幅作品'}</p></div></div>
            <Link to={inApp ? '/studio' : '/register'} className="inline-flex items-center gap-2 rounded-full bg-white px-7 py-3 text-sm font-semibold text-[#6b5ce7] shadow-lg transition hover:bg-[#f0eaff]">{inApp ? '继续创作' : '免费开始创作'}<IconArrowRight className="h-4 w-4" /></Link>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-5 pb-12">
          <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-x-5 gap-y-2"><h2 className="flex items-center gap-2.5 text-xl font-bold"><IconSparkle className="h-6 w-6 text-[#9761f5]" />创作灵感</h2><span className="text-xs text-[#9585ad]">找到一个场景，让想法开始发生</span></div><Link to="/studio" className="text-xs font-semibold text-[#8a5ee9]">进入创作 →</Link></div>
          <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">{SCENES.map((scene) => <Link key={scene.title} to={scene.to} className="group overflow-hidden rounded-xl border border-[#ece4f7] bg-white transition hover:-translate-y-1 hover:shadow-lg"><div className="overflow-hidden"><img src={assetUrl(scene.img)} alt="" loading="lazy" style={{ objectPosition: scene.img.includes('hero-home') ? '80% 35%' : 'center' }} className="aspect-[4/3] w-full object-cover transition duration-500 group-hover:scale-105" /></div><div className="p-4"><h3 className="text-sm font-bold">{scene.title}</h3><p className="mt-2 text-[11px] leading-5 text-[#9281a7]">{scene.desc}</p><span className="mt-3 inline-block rounded-full bg-[#f4eeff] px-3 py-1 text-[10px] font-semibold text-[#9466e2]">开始创作 →</span></div></Link>)}</div>
        </section>

        <section className="mx-auto max-w-7xl px-5 pb-14">
          <h2 className="flex items-center gap-2 text-xl font-bold"><BrandMark className="h-7 w-7" />为什么选择绘想？</h2>
          <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">{FEATURES.map((feature) => <div key={feature.title} className="flex gap-4"><span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[#e6d9ff] bg-[#f2edff] text-[#9465ed]"><feature.icon className="h-5 w-5" /></span><div><h3 className="text-sm font-bold">{feature.title}</h3><p className="mt-2 text-[11px] leading-5 text-[#9585ad]">{feature.desc}</p></div></div>)}</div>
        </section>
      </div>
      </main>
      <SiteFooter />
    </div>
  )
}
