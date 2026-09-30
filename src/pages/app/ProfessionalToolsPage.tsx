import { Link } from 'react-router-dom'
import { assetUrl } from '../../lib/assetUrl'
import { IconArrowRight, IconEdit, IconImage, IconLayers, IconSparkle } from '../icons'
import AppShell from './AppShell'

const AVAILABLE_TOOLS = [
  {
    title: '局部重绘',
    description: '涂抹需要修改的区域，只重绘选中的局部内容。',
    image: '/art/auth-register.jpg',
    to: '/studio?mode=inpaint',
    icon: IconEdit,
  },
  {
    title: 'AI 扩图',
    description: '保留原图主体与风格，自然延展画面边界。',
    image: '/art/work-train.jpg',
    to: '/studio?mode=outpaint',
    icon: IconLayers,
  },
]

const PLANNED_TOOLS = [
  { title: '电商设计', description: '商品抠图、场景替换与营销版式设计。', image: '/art/recharge-cat.jpg' },
  { title: '商品电商套图', description: '围绕同一商品批量生成统一风格的成套素材。', image: '/art/work-sakura.jpg' },
  { title: 'Live 实况图', description: '把静态画面转为带自然运动的短视频内容。', image: '/art/work-seaside.jpg' },
]

export default function ProfessionalToolsPage() {
  return (
    <AppShell title="专业工具" wide>
      <section className="overflow-hidden rounded-[28px] border border-[#e7e3f7] bg-gradient-to-br from-white via-[#fbfaff] to-[#efedff] p-5 shadow-sm sm:p-8">
        <div className="relative">
          <span className="inline-flex items-center gap-2 rounded-full bg-[#efedfd] px-3 py-1.5 text-xs font-semibold text-[#6b5ce7]">
            <IconSparkle className="h-3.5 w-3.5" />精细创作工作台
          </span>
          <h2 className="mt-4 text-2xl font-bold tracking-tight text-[#292650]">专业工具</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#817b9f]">从局部修改到画面延展，把需要更多控制力的创作能力集中在这里。</p>

          <div className="mt-7 grid gap-4 md:grid-cols-2">
            {AVAILABLE_TOOLS.map((tool) => (
              <Link key={tool.title} to={tool.to} className="group relative min-h-[210px] overflow-hidden rounded-3xl border border-[#ded9f4] bg-white shadow-sm transition duration-200 hover:-translate-y-1 hover:border-[#a79cf5] hover:shadow-xl hover:shadow-[#7867f5]/10">
                <img src={assetUrl(tool.image)} alt="" className="absolute inset-y-0 right-0 h-full w-[52%] object-cover transition duration-500 group-hover:scale-105" />
                <span className="absolute inset-y-0 left-[35%] w-[35%] bg-gradient-to-r from-white via-white/90 to-transparent" />
                <div className="relative z-10 flex h-full max-w-[62%] flex-col p-6">
                  <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#efedfd] text-[#6b5ce7]"><tool.icon className="h-5 w-5" /></span>
                  <h3 className="mt-5 text-lg font-bold text-[#35315d]">{tool.title}</h3>
                  <p className="mt-2 text-xs leading-5 text-[#8c86a7]">{tool.description}</p>
                  <span className="mt-auto flex items-center gap-1 pt-5 text-xs font-semibold text-[#6b5ce7]">立即使用<IconArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-1" /></span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-7">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-[#35315d]">更多能力</h2>
            <p className="mt-1 text-xs text-[#918cae]">以下工具正在规划接入，正式可用前不会扣除积分。</p>
          </div>
          <span className="hidden rounded-full bg-white px-3 py-1.5 text-[11px] font-medium text-[#918cae] shadow-sm sm:inline">持续更新中</span>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PLANNED_TOOLS.map((tool) => (
            <article key={tool.title} className="overflow-hidden rounded-2xl border border-[#e7e4f2] bg-white">
              <div className="relative h-32 overflow-hidden bg-[#f0eef8]">
                <img src={assetUrl(tool.image)} alt="" loading="lazy" className="h-full w-full object-cover opacity-75 grayscale-[20%]" />
                <span className="absolute right-3 top-3 rounded-full bg-white/90 px-2.5 py-1 text-[10px] font-semibold text-[#77718f] shadow-sm">规划中</span>
              </div>
              <div className="p-4">
                <div className="flex items-center gap-2 text-[#3c375f]"><IconImage className="h-4 w-4 text-[#9185ed]" /><h3 className="text-sm font-bold">{tool.title}</h3></div>
                <p className="mt-2 text-xs leading-5 text-[#918cae]">{tool.description}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </AppShell>
  )
}
