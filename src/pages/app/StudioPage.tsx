import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useStore, submitTask, addImageFromFile } from '../../store'
import { getCreditsConfig } from '../../lib/backend'
import { useCreditsStore } from '../../lib/creditsStore'
import { assetUrl } from '../../lib/assetUrl'
import { STYLE_PRESETS, type StylePresetKey } from '../../lib/stylePresets'
import AppShell from './AppShell'
import { useThumbnail } from './useTaskImage'
import { IconImage, IconSparkle, IconUpload, IconBrush, IconArrowRight, IconPlus, IconMinus, IconEdit } from '../icons'

type TabKey = 'text' | 'image' | 'inpaint' | 'outpaint'

const MODES: Array<{ key: TabKey, label: string, description: string, image: string }> = [
  { key: 'text', label: '文生图', description: '输入文字生成精美画面', image: '/art/work-seaside.jpg' },
  { key: 'image', label: '图生图', description: '上传图片生成新图', image: '/art/work-cat.jpg' },
  { key: 'inpaint', label: '局部重绘', description: '涂抹修改，精细编辑', image: '/art/auth-register.jpg' },
  { key: 'outpaint', label: 'AI 扩图', description: '一键延展画面', image: '/art/work-train.jpg' },
]

const RATIOS = [
  { label: '1:1', size: '1024x1024' },
  { label: '3:4', size: '1024x1536' },
  { label: '4:3', size: '1536x1024' },
  { label: '9:16', size: '1024x1536' },
  { label: '16:9', size: '1536x1024' },
]

const RANDOM_PROMPTS = [
  '雨后的未来城市街道，霓虹灯倒映在路面，电影感构图',
  '海边少女回头微笑，粉蓝色天空，海鸥，柔和夕阳',
  '云海之上的东方宫殿，清晨薄雾，金色天光，宏大远景',
  '一只戴着蝴蝶结的布偶猫，窗边自然光，温柔安静的氛围',
  '春日樱花街道，透明雨伞，花瓣随风飘落，治愈画面',
]

const OUTPAINT_SUFFIX = '保持原图内容与风格不变，画面自然向外扩展延伸'

function RecentThumb({ imageId, taskId }: { imageId: string, taskId: string }) {
  const src = useThumbnail(imageId)
  return (
    <Link to={`/result?task=${taskId}`} className="group relative aspect-square shrink-0 overflow-hidden rounded-xl border border-[#eceaf6] bg-white">
      {src
        ? <img src={src} alt="" className="h-full w-full object-cover transition duration-300 group-hover:scale-105" />
        : <span className="flex h-full w-full items-center justify-center text-[#d8d4ec]"><IconImage className="h-6 w-6" /></span>}
    </Link>
  )
}

export default function StudioPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const prompt = useStore((s) => s.prompt)
  const setPrompt = useStore((s) => s.setPrompt)
  const inputImages = useStore((s) => s.inputImages)
  const removeInputImage = useStore((s) => s.removeInputImage)
  const clearInputImages = useStore((s) => s.clearInputImages)
  const params = useStore((s) => s.params)
  const setParams = useStore((s) => s.setParams)
  const maskDraft = useStore((s) => s.maskDraft)
  const setMaskEditorImageId = useStore((s) => s.setMaskEditorImageId)
  const showToast = useStore((s) => s.showToast)
  const tasks = useStore((s) => s.tasks)

  const requestedMode = searchParams.get('mode')
  const [tab, setTab] = useState<TabKey>(() => MODES.some((mode) => mode.key === requestedMode) ? requestedMode as TabKey : 'text')
  const [selectedStyle, setSelectedStyle] = useState<StylePresetKey | null>(null)
  useEffect(() => {
    setTab(MODES.some((mode) => mode.key === requestedMode) ? requestedMode as TabKey : 'text')
  }, [requestedMode])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const credits = getCreditsConfig()
  const view = useCreditsStore((s) => s.view)
  const needsUpload = tab !== 'text'
  const count = Math.max(1, Math.min(4, params.n || 1))
  const cost = credits ? credits.costPerImage * count : 0
  const currentRatio = RATIOS.find((ratio) => ratio.size === params.size)?.label ?? '1:1'
  const recentTasks = tasks.filter((task) => task.status === 'done' && task.outputImages.length > 0).slice(0, 6)

  const pickFiles = async (files: FileList | null) => {
    if (!files) return
    for (const file of Array.from(files)) await addImageFromFile(file)
  }

  const generate = async () => {
    if (!prompt.trim()) {
      showToast('先描述一下你想画的画面', 'error')
      return
    }
    if (needsUpload && inputImages.length === 0) {
      showToast('这个模式需要先上传一张参考图', 'error')
      return
    }
    if (tab === 'outpaint' && !prompt.includes(OUTPAINT_SUFFIX)) {
      setPrompt(prompt.trim() ? `${prompt.trim()}，${OUTPAINT_SUFFIX}` : OUTPAINT_SUFFIX)
    }
    if (!await submitTask({ stylePreset: selectedStyle ?? undefined })) return
    navigate('/result')
  }

  return (
    <AppShell title="AI 绘画" wide>
      <div className="relative overflow-hidden rounded-[28px] border border-[#e8e5f7] bg-gradient-to-br from-white via-[#fbfaff] to-[#f0efff] p-4 shadow-sm sm:p-6">
        <div className="pointer-events-none absolute -right-24 top-10 h-72 w-72 rounded-full bg-[#c4bcff]/20 blur-3xl" />
        <div className="relative">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold tracking-tight text-[#292650]">用 AI 把想象变成图像</h2>
              <p className="mt-1 text-xs text-[#918cae]">输入文字、选择风格，即刻生成属于你的作品</p>
            </div>
            <Link to="/me?tab=works" className="rounded-full border border-[#dfd8f6] bg-white px-4 py-2 text-xs font-semibold text-[#7b65d9] transition hover:bg-[#f1ecff]">我的作品与进度 →</Link>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            {MODES.map((mode) => (
              <button
                key={mode.key}
                type="button"
                onClick={() => setTab(mode.key)}
                aria-pressed={tab === mode.key}
                className={`group relative h-[106px] cursor-pointer overflow-hidden rounded-2xl border-2 text-left shadow-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-md ${
                  tab === mode.key
                    ? 'border-[#7867f5] bg-[#f8f7ff] ring-2 ring-[#7867f5]/15 shadow-[#7867f5]/15'
                    : 'border-[#ddd9eb] bg-[#faf9fd] hover:border-[#aaa0ef] hover:bg-white'
                }`}
              >
                <span className={`absolute right-2.5 top-2.5 z-20 flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-bold transition ${
                  tab === mode.key
                    ? 'border-[#7867f5] bg-[#7867f5] text-white shadow-sm'
                    : 'border-[#bbb5d2] bg-white/90 text-transparent group-hover:border-[#8c7cf7]'
                }`} aria-hidden="true">✓</span>
                <div className="relative z-10 w-full p-3 sm:w-[62%] sm:p-4">
                  <p className={`whitespace-nowrap text-[13px] font-bold sm:text-[15px] ${tab === mode.key ? 'text-[#6958e9]' : 'text-[#35315d]'}`}>{mode.label}</p>
                  <p className="mt-1 text-[10px] leading-4 text-[#918cae]">{mode.description}</p>
                </div>
                <img src={assetUrl(mode.image)} alt="" className="absolute inset-y-0 right-0 h-full w-full object-cover opacity-20 transition duration-300 group-hover:scale-105 sm:w-[48%] sm:opacity-90" />
                <span className="absolute inset-y-0 right-[32%] hidden w-20 bg-gradient-to-r from-white via-white/85 to-transparent sm:block" />
                {tab === mode.key && <span className="absolute -bottom-1 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-b-2 border-r-2 border-[#7867f5] bg-white" />}
              </button>
            ))}
          </div>

          <div className="mt-6 rounded-2xl border border-[#e6e2f4] bg-white/95 p-4 shadow-sm transition focus-within:border-[#9a8ef8] focus-within:ring-4 focus-within:ring-[#7867f5]/8 sm:p-5">
            <label htmlFor="studio-description" className="mb-3 flex items-center gap-2 text-sm font-bold text-[#35315d]"><span className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#eee9ff] text-xs text-[#7b65d9]">1</span>描述你的画面</label>
            <textarea
              id="studio-description"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              placeholder="描述你想要的画面……例如：樱花下的少女，夕阳，唯美，动漫风格"
              className="min-h-[86px] w-full resize-none bg-transparent px-1 text-sm leading-6 text-[#37335c] outline-none placeholder:text-[#aaa5bf]"
            />
            <div className="flex flex-wrap items-center gap-2 border-t border-[#f0eef8] pt-3">
              <button type="button" onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 rounded-lg bg-[#f7f6fc] px-3 py-2 text-xs font-medium text-[#615c7f] transition hover:bg-[#efedfd] hover:text-[#6b5ce7]">
                <IconUpload className="h-4 w-4" />参考图{tab === 'text' ? '（可选）' : ''}
              </button>
              <button type="button" onClick={() => setPrompt(RANDOM_PROMPTS[Math.floor(Math.random() * RANDOM_PROMPTS.length)])} className="flex items-center gap-1.5 rounded-lg bg-[#fff8ed] px-3 py-2 text-xs font-medium text-[#b67a2c] transition hover:bg-[#ffefd5]">
                <IconSparkle className="h-4 w-4" />随机灵感
              </button>
              {inputImages.length > 0 && <button type="button" onClick={clearInputImages} className="rounded-lg px-2 py-2 text-xs text-[#918cae] hover:text-red-500">清除参考图</button>}
              <span className="ml-auto text-[11px] text-[#aaa5bf]">已输入 {prompt.length.toLocaleString()} 字</span>
              <button type="button" onClick={() => void generate()} className="hidden min-w-[150px] items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#7462f3] to-[#9b76f6] px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-[#7867f5]/25 transition hover:from-[#6653e8] hover:to-[#8f69ed] sm:flex">
                <IconSparkle className="h-4 w-4" />生成{credits ? ` · ${cost} 积分` : ''}
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { void pickFiles(event.target.files); event.target.value = '' }} />
            </div>
          </div>

          {inputImages.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2.5 rounded-2xl border border-[#e8e5f5] bg-white/80 p-3">
              {inputImages.map((img, idx) => (
                <div key={img.id} className="group relative h-16 w-16 overflow-hidden rounded-xl border border-[#e4e1f2]">
                  <img src={img.dataUrl} alt="" className="h-full w-full object-cover" />
                  <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/45 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                    {tab === 'inpaint' && <button type="button" onClick={() => setMaskEditorImageId(img.id)} title="涂抹遮罩" className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/90 text-[#6b5ce7]"><IconEdit className="h-3.5 w-3.5" /></button>}
                    <button type="button" onClick={() => removeInputImage(idx)} title="移除" className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/90 text-red-500"><IconMinus className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
              ))}
              <button type="button" onClick={() => fileInputRef.current?.click()} className="flex h-16 w-16 items-center justify-center rounded-xl border-2 border-dashed border-[#dcd8f0] text-[#aaa5bf] hover:border-[#7c6cf6] hover:text-[#7c6cf6]"><IconPlus className="h-5 w-5" /></button>
              <p className="text-xs text-[#918cae]">
                {tab === 'inpaint' ? maskDraft ? '遮罩已绘制，提交后只重绘涂抹区域' : '悬停图片并点击编辑按钮，涂抹要重绘的区域' : tab === 'outpaint' ? 'AI 会保持主体并自然延展画面' : '本次将结合参考图进行创作'}
              </p>
            </div>
          )}

          <div className="mt-5 rounded-2xl border border-[#e9e4f5] bg-white/70 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-bold text-[#35315d]"><span className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#eee9ff] text-xs text-[#7b65d9]">2</span>选择风格</h3>
              <span className="text-[11px] text-[#918cae]">风格自动应用，输入框只保留你的描述</span>
            </div>
            <div className="hide-scrollbar mt-3 flex gap-2.5 overflow-x-auto pb-1">
              <button type="button" aria-pressed={selectedStyle === null} onClick={() => setSelectedStyle(null)} className={`flex h-[104px] w-[96px] shrink-0 flex-col items-center justify-center gap-2 rounded-xl border-2 transition ${selectedStyle === null ? 'border-[#8c7cf7] bg-[#f3f1ff] text-[#6b5ce7]' : 'border-[#e3ddef] bg-white text-[#746f92] hover:border-[#b3a3e8]'}`}>
                <IconImage className="h-6 w-6" /><span className="text-[11px] font-semibold">不限风格</span>
              </button>
              {STYLE_PRESETS.map((style) => (
                <button key={style.key} type="button" onClick={() => setSelectedStyle(style.key)} aria-pressed={selectedStyle === style.key} className={`relative h-[104px] w-[104px] shrink-0 overflow-hidden rounded-xl border-2 text-left transition ${selectedStyle === style.key ? 'border-[#8c7cf7] shadow-md shadow-[#7867f5]/20' : 'border-[#e3ddef] hover:border-[#b3a3e8]'}`}>
                  <img src={assetUrl(style.image)} alt="" loading="lazy" className="h-full w-full object-cover" />
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2 pb-1.5 pt-6 text-center text-[10px] font-semibold text-white">{style.label}</span>
                  {selectedStyle === style.key && <span aria-hidden="true" className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-[#7867f5] text-xs text-white">✓</span>}
                </button>
              ))}
            </div>
          </div>

          <p className="mt-2 px-1 text-[11px] text-[#918cae]">左右滑动查看更多风格</p>

          <div className="mt-5 flex flex-wrap items-end gap-x-12 gap-y-5 rounded-2xl border border-[#e9e4f5] bg-white/70 p-4 sm:p-5">
            <div>
              <h3 className="text-sm font-bold text-[#35315d]">画面比例</h3>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {RATIOS.map((ratio) => (
                  <button key={ratio.label} type="button" onClick={() => setParams({ size: ratio.size })} className={`min-h-11 min-w-[62px] rounded-lg px-3.5 py-2 text-[12px] font-semibold transition ${currentRatio === ratio.label ? 'bg-[#efedfd] text-[#6b5ce7] ring-1 ring-[#8c7cf7]' : 'bg-white text-[#77718f] hover:bg-[#f3f1ff]'}`}>{ratio.label}</button>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-bold text-[#35315d]">生成数量</h3>
              <div className="mt-2.5 flex items-center gap-3">
                <button type="button" aria-label="减少生成数量" disabled={count === 1} onClick={() => setParams({ n: Math.max(1, count - 1) })} className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#e4def1] bg-white text-[#77718f] hover:bg-[#efedfd] hover:text-[#6b5ce7] disabled:cursor-not-allowed disabled:opacity-40"><IconMinus className="h-4 w-4" /></button>
                <span className="w-6 text-center text-sm font-bold">{count}</span>
                <button type="button" aria-label="增加生成数量" disabled={count === 4} onClick={() => setParams({ n: Math.min(4, count + 1) })} className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#e4def1] bg-white text-[#77718f] hover:bg-[#efedfd] hover:text-[#6b5ce7] disabled:cursor-not-allowed disabled:opacity-40"><IconPlus className="h-4 w-4" /></button>
              </div>
            </div>
            {credits && <p className="ml-auto text-[11px] text-[#aaa5bf]">剩余 {view?.available ?? 0} 积分 · 失败自动退分</p>}
          </div>
          <button type="button" onClick={() => void generate()} className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#7462f3] to-[#9b76f6] px-4 text-sm font-semibold text-white shadow-lg shadow-[#7867f5]/25 sm:hidden"><IconSparkle className="h-4 w-4" />立即生成{credits ? ` · ${cost} 积分` : ''}</button>
        </div>
      </div>

      {recentTasks.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><IconBrush className="h-4 w-4 text-[#7c6cf6]" />最近作品</h3>
            <Link to="/me?tab=works" className="flex items-center gap-1 text-xs font-medium text-[#6b5ce7] hover:text-[#5a4cd6]">全部作品<IconArrowRight className="h-3.5 w-3.5" /></Link>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-6">{recentTasks.map((task) => <RecentThumb key={task.id} imageId={task.outputImages[0]} taskId={task.id} />)}</div>
        </div>
      )}
    </AppShell>
  )
}
