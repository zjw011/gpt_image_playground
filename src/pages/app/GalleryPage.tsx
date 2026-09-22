// 作品广场。对应设计稿 7：推荐/最新/最热 + 风格筛选 + 卡片网格。
// 目前是演示数据（AI 生成的示例作品），发布/点赞等真实接口就绪后再替换。
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../../store'
import AppShell from './AppShell'
import { IconHeart, IconEye, IconSearch, IconSparkle } from '../icons'

interface GalleryWork {
  img: string
  title: string
  author: string
  likes: number
  views: string
  style: string
  prompt: string
  at: number
}

const WORKS: GalleryWork[] = [
  { img: '/art/work-train.jpg', title: '星空下的列车', author: '星野', likes: 1280, views: '3.2k', style: '动漫', prompt: '星空下的列车，璀璨银河，车窗暖光，新海诚风格', at: 6 },
  { img: '/art/work-seaside.jpg', title: '海边的少女', author: '蓝调', likes: 986, views: '2.1k', style: '动漫', prompt: '海边少女回头微笑，粉蓝色天空，海鸥，唯美治愈', at: 5 },
  { img: '/art/work-cyber.jpg', title: '霓虹雨夜', author: 'NightCity', likes: 2100, views: '5.6k', style: '赛博', prompt: '赛博朋克城市夜景，霓虹灯牌，雨后街道倒影', at: 4 },
  { img: '/art/work-cat.jpg', title: '温柔的猫', author: '喵星人', likes: 2800, views: '6.8k', style: '写实', prompt: '布偶猫特写肖像，蓝眼睛，淡紫蝴蝶结，花瓣光斑', at: 3 },
  { img: '/art/work-hanfu.jpg', title: '桃花依旧', author: '古风小筑', likes: 764, views: '1.8k', style: '古风', prompt: '汉服少女桃花树下，江南水乡，柔和晨光，国风插画', at: 2 },
  { img: '/art/work-sakura.jpg', title: '樱花街道', author: '春日部', likes: 1500, views: '4.1k', style: '动漫', prompt: '春日樱花街道，透明雨伞少女背影，花瓣纷飞', at: 1 },
]

const TABS = ['推荐', '最新', '最热'] as const
const STYLE_FILTERS = ['全部风格', '动漫', '写实', '古风', '赛博'] as const

export default function GalleryPage() {
  const navigate = useNavigate()
  const setPrompt = useStore((s) => s.setPrompt)
  const showToast = useStore((s) => s.showToast)
  const [tab, setTab] = useState<(typeof TABS)[number]>('推荐')
  const [style, setStyle] = useState<(typeof STYLE_FILTERS)[number]>('全部风格')
  const [keyword, setKeyword] = useState('')
  const [liked, setLiked] = useState<string[]>([])
  const [preview, setPreview] = useState<GalleryWork | null>(null)

  const works = useMemo(() => {
    let list = WORKS
    if (style !== '全部风格') list = list.filter((work) => work.style === style)
    if (keyword.trim()) list = list.filter((work) => work.title.includes(keyword.trim()) || work.prompt.includes(keyword.trim()))
    if (tab === '最新') list = [...list].sort((a, b) => a.at - b.at)
    if (tab === '最热') list = [...list].sort((a, b) => b.likes - a.likes)
    return list
  }, [tab, style, keyword])

  const toggleLike = (title: string) => {
    setLiked((current) => current.includes(title) ? current.filter((item) => item !== title) : [...current, title])
  }

  const useSamePrompt = (work: GalleryWork) => {
    setPrompt(work.prompt)
    showToast('提示词已填入，去创作同款吧', 'success')
    navigate('/studio')
  }

  return (
    <AppShell title="作品广场" wide>
      {/* 工具行：Tab + 风格筛选 + 搜索 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-full border border-[#eceaf6] bg-white p-1">
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={`rounded-full px-4 py-1.5 text-[13px] font-medium transition ${
                tab === item ? 'bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] text-white shadow-sm' : 'text-[#6f6a94] hover:text-[#37335c]'
              }`}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          {STYLE_FILTERS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setStyle(item)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
                style === item ? 'bg-[#efedfd] text-[#6b5ce7] ring-1 ring-[#7c6cf6]/40' : 'bg-white text-[#8a86ac] ring-1 ring-[#eceaf6] hover:text-[#6b5ce7]'
              }`}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <IconSearch className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#b3aed0]" />
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索作品或提示词"
            className="w-56 rounded-full border border-[#eceaf6] bg-white py-2 pl-10 pr-4 text-[13px] outline-none transition placeholder:text-[#b3aed0] focus:border-[#7c6cf6] focus:ring-4 focus:ring-[#7c6cf6]/10"
          />
        </div>
      </div>

      {/* 卡片网格 */}
      {works.length === 0 ? (
        <div className="mt-6 rounded-3xl border border-[#eceaf6] bg-white py-20 text-center text-sm text-[#a5a1c4]">
          没有找到相关作品，换个关键词试试
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
          {works.map((work) => {
            const isLiked = liked.includes(work.title)
            return (
              <div key={work.title} className="group overflow-hidden rounded-2xl border border-[#eceaf6] bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-lg hover:shadow-[#7c6cf6]/10">
                <button type="button" onClick={() => setPreview(work)} className="relative block w-full overflow-hidden">
                  <img src={work.img} alt={work.title} loading="lazy" className="aspect-square w-full object-cover transition duration-300 group-hover:scale-105" />
                  <span className="absolute inset-0 flex items-end bg-gradient-to-t from-black/55 via-transparent to-transparent p-3.5 opacity-0 transition group-hover:opacity-100">
                    <span className="line-clamp-2 text-left text-xs leading-5 text-white">{work.prompt}</span>
                  </span>
                </button>
                <div className="px-3.5 py-3">
                  <p className="truncate text-[13.5px] font-semibold">{work.title}</p>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#7c6cf6] to-[#a78bfa] text-[10px] font-bold text-white">
                        {work.author.slice(0, 1)}
                      </span>
                      <span className="truncate text-xs text-[#8a86ac]">{work.author}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2.5 text-[11px] text-[#a5a1c4]">
                      <button
                        type="button"
                        onClick={() => toggleLike(work.title)}
                        className={`flex items-center gap-1 transition ${isLiked ? 'text-[#f472b6]' : 'hover:text-[#f472b6]'}`}
                      >
                        <IconHeart className="h-3.5 w-3.5" filled={isLiked} />
                        {(work.likes + (isLiked ? 1 : 0)).toLocaleString()}
                      </button>
                      <span className="flex items-center gap-1">
                        <IconEye className="h-3.5 w-3.5" />
                        {work.views}
                      </span>
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 作品预览弹层 */}
      {preview && (
        <div className="animate-overlay-in fixed inset-0 z-50 flex items-center justify-center bg-[#3b2f6b]/45 p-6 backdrop-blur-sm" onClick={() => setPreview(null)}>
          <div className="animate-modal-in flex max-h-full w-full max-w-3xl overflow-hidden rounded-3xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <img src={preview.img} alt={preview.title} className="hidden w-1/2 object-cover sm:block" />
            <div className="flex min-w-0 flex-1 flex-col p-6">
              <h3 className="text-lg font-bold">{preview.title}</h3>
              <p className="mt-1 text-xs text-[#a5a1c4]">{preview.author} · {preview.style}</p>
              <div className="mt-4 rounded-2xl bg-[#faf9fe] p-4">
                <p className="text-[11px] font-medium uppercase tracking-wider text-[#b3aed0]">提示词</p>
                <p className="mt-1.5 text-[13px] leading-6 text-[#5b5680]">{preview.prompt}</p>
              </div>
              <div className="mt-auto flex gap-2.5 pt-6">
                <button
                  type="button"
                  onClick={() => useSamePrompt(preview)}
                  className="flex flex-1 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] py-2.5 text-sm font-semibold text-white shadow-md shadow-[#7c6cf6]/25 transition hover:from-[#6b5ce7] hover:to-[#9678f5]"
                >
                  <IconSparkle className="h-4 w-4" />
                  画同款
                </button>
                <button
                  type="button"
                  onClick={() => setPreview(null)}
                  className="rounded-full border border-[#dcd8f0] px-5 py-2.5 text-sm font-medium text-[#6f6a94] transition hover:border-[#7c6cf6] hover:text-[#7c6cf6]"
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  )
}
