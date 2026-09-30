import { useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { getCreditsConfig } from '../../lib/backend'
import { assetUrl } from '../../lib/assetUrl'
import { useCreditsStore } from '../../lib/creditsStore'
import { fileToDataUrl } from '../../lib/dataUrl'
import { exportLivePhoto, type LiveMotion } from '../../lib/livePhoto'
import type { ProfessionalPresetKey } from '../../lib/professionalTools'
import { addImageFromFile, submitTask, useStore } from '../../store'
import { IconArrowLeft, IconArrowRight, IconDownload, IconMinus, IconPlus, IconSparkle, IconUpload } from '../icons'
import AppShell from './AppShell'

type ToolKey = 'ecommerce' | 'product-suite' | 'live'

const TOOLS: Array<{ key: ToolKey, title: string, eyebrow: string, description: string, image: string }> = [
  { key: 'ecommerce', title: '电商设计', eyebrow: '单图精修', description: '上传商品图，生成适合详情页、海报和营销场景的成品。', image: '/art/recharge-cat.jpg' },
  { key: 'product-suite', title: '商品电商套图', eyebrow: '批量出图', description: '围绕同一商品，一次生成视觉统一的成套电商素材。', image: '/art/work-sakura.jpg' },
  { key: 'live', title: 'Live 实况图', eyebrow: '本地视频', description: '让静态图片产生自然运镜，导出可直接使用的 WebM 短视频。', image: '/art/work-seaside.jpg' },
]

const RATIOS = [
  { label: '1:1', size: '1024x1024' },
  { label: '3:4', size: '1024x1536' },
  { label: '4:3', size: '1536x1024' },
  { label: '9:16', size: '1024x1536' },
  { label: '16:9', size: '1536x1024' },
]

const ECOMMERCE_SCENES: Array<{ key: ProfessionalPresetKey, label: string, description: string }> = [
  { key: 'ecommerce-clean', label: '白底精修', description: '干净背景与清晰商品质感' },
  { key: 'ecommerce-lifestyle', label: '场景营销', description: '自然生活场景与真实光影' },
  { key: 'ecommerce-luxury', label: '高级质感', description: '精致布光与品牌氛围' },
  { key: 'ecommerce-poster', label: '营销海报', description: '留出文案空间的商业构图' },
]

const SUITE_SCENES: Array<{ key: ProfessionalPresetKey, label: string, description: string }> = [
  { key: 'product-suite-store', label: '主图套装', description: '适合商品列表与详情页' },
  { key: 'product-suite-social', label: '种草套装', description: '适合社交平台与内容营销' },
  { key: 'product-suite-premium', label: '高端套装', description: '统一的高级品牌视觉' },
]

function ToolLanding() {
  return (
    <section>
      <div>
        <span className="inline-flex items-center gap-2 rounded-full bg-[#efedfd] px-3 py-1.5 text-xs font-semibold text-[#6b5ce7]"><IconSparkle className="h-3.5 w-3.5" />专业创作能力</span>
        <h2 className="mt-4 text-2xl font-bold tracking-tight text-[#292650]">选择一个专业工具</h2>
        <p className="mt-2 text-sm leading-6 text-[#817b9f]">从商品视觉到动态内容，每个功能都可以直接完成真实创作。</p>
      </div>
      <div className="mt-7 grid gap-5 lg:grid-cols-3">
        {TOOLS.map((tool) => (
          <Link key={tool.key} to={`/tools?tool=${tool.key}`} className="group overflow-hidden rounded-[26px] border border-[#e3dff4] bg-white shadow-sm transition duration-300 hover:-translate-y-1 hover:border-[#a99df6] hover:shadow-xl hover:shadow-[#7867f5]/10">
            <div className="relative h-52 overflow-hidden bg-[#f1effa]">
              <img src={assetUrl(tool.image)} alt="" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
              <span className="absolute left-4 top-4 rounded-full bg-white/90 px-3 py-1.5 text-[11px] font-semibold text-[#6b5ce7] shadow-sm backdrop-blur">{tool.eyebrow}</span>
            </div>
            <div className="p-5">
              <div className="flex items-center justify-between gap-3"><h3 className="text-lg font-bold text-[#35315d]">{tool.title}</h3><span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#efedfd] text-[#6b5ce7] transition group-hover:translate-x-1"><IconArrowRight className="h-4 w-4" /></span></div>
              <p className="mt-2 text-xs leading-5 text-[#918cae]">{tool.description}</p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}

function ProductImageEditor({ tool }: { tool: Exclude<ToolKey, 'live'> }) {
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputImages = useStore((s) => s.inputImages)
  const clearInputImages = useStore((s) => s.clearInputImages)
  const setPrompt = useStore((s) => s.setPrompt)
  const params = useStore((s) => s.params)
  const setParams = useStore((s) => s.setParams)
  const showToast = useStore((s) => s.showToast)
  const credits = getCreditsConfig()
  const view = useCreditsStore((s) => s.view)
  const options = tool === 'ecommerce' ? ECOMMERCE_SCENES : SUITE_SCENES
  const [scene, setScene] = useState<ProfessionalPresetKey>(options[0].key)
  const [description, setDescription] = useState('')
  const [count, setCount] = useState(tool === 'ecommerce' ? 1 : 4)
  const [submitting, setSubmitting] = useState(false)
  const currentRatio = RATIOS.find((ratio) => ratio.size === params.size)?.label ?? '1:1'
  const cost = credits ? credits.costPerImage * count : 0

  const upload = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    clearInputImages()
    await addImageFromFile(file)
  }

  const generate = async () => {
    if (inputImages.length === 0) {
      showToast('请先上传一张清晰的商品图', 'error')
      return
    }
    setSubmitting(true)
    setPrompt(description.trim() || '保持商品主体、包装、文字和外观准确，生成专业商业成品图')
    setParams({ n: count })
    try {
      if (!await submitTask({ professionalPreset: scene })) return
      navigate('/result')
    } finally {
      setSubmitting(false)
    }
  }

  const title = tool === 'ecommerce' ? '电商设计' : '商品电商套图'
  const subtitle = tool === 'ecommerce' ? '上传一张商品图，快速完成商业级场景设计。' : '保持商品一致，一次生成多张统一风格的营销素材。'

  return (
    <section className="overflow-hidden rounded-[28px] border border-[#e7e3f7] bg-gradient-to-br from-white via-[#fbfaff] to-[#efedff] p-5 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-2xl font-bold text-[#292650]">{title}</h2><p className="mt-2 text-sm text-[#817b9f]">{subtitle}</p></div><span className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-[#746e91] shadow-sm">{credits ? `预计 ${cost} 积分` : '按当前渠道计费'}</span></div>
      <div className="mt-6 grid gap-6 lg:grid-cols-[360px_1fr]">
        <div>
          <h3 className="text-sm font-bold text-[#35315d]">商品原图</h3>
          <button type="button" onClick={() => fileInputRef.current?.click()} className="mt-3 flex aspect-square w-full items-center justify-center overflow-hidden rounded-3xl border-2 border-dashed border-[#d9d4ef] bg-white text-[#8d86aa] transition hover:border-[#8c7cf7] hover:bg-[#faf9ff]">
            {inputImages[0]
              ? <img src={inputImages[0].dataUrl} alt="商品原图" className="h-full w-full object-contain" />
              : <span className="flex flex-col items-center gap-3"><span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#efedfd] text-[#6b5ce7]"><IconUpload className="h-6 w-6" /></span><span className="text-sm font-semibold">上传商品图片</span><span className="text-xs text-[#aaa5bf]">建议主体清晰、无遮挡</span></span>}
          </button>
          {inputImages[0] && <button type="button" onClick={() => fileInputRef.current?.click()} className="mt-3 w-full rounded-xl bg-white py-2.5 text-xs font-semibold text-[#6b5ce7] shadow-sm hover:bg-[#f7f5ff]">更换图片</button>}
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={(event) => { void upload(event.target.files); event.target.value = '' }} />
        </div>
        <div className="space-y-6">
          <div><h3 className="text-sm font-bold text-[#35315d]">选择方案</h3><div className="mt-3 grid gap-2 sm:grid-cols-2">{options.map((item) => <button key={item.key} type="button" onClick={() => setScene(item.key)} className={`rounded-2xl border-2 p-4 text-left transition ${scene === item.key ? 'border-[#8c7cf7] bg-[#f3f1ff]' : 'border-[#e8e5f3] bg-white hover:border-[#c6bff5]'}`}><span className={`text-sm font-bold ${scene === item.key ? 'text-[#6b5ce7]' : 'text-[#423d63]'}`}>{item.label}</span><span className="mt-1 block text-[11px] text-[#918cae]">{item.description}</span></button>)}</div></div>
          <div><h3 className="text-sm font-bold text-[#35315d]">补充要求 <span className="font-normal text-[#aaa5bf]">（可选）</span></h3><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} placeholder="例如：保留瓶身文字，暖色桌面场景，右侧留出标题空间" className="mt-3 w-full resize-none rounded-2xl border border-[#e4e0f2] bg-white p-4 text-sm leading-6 text-[#37335c] outline-none transition placeholder:text-[#aaa5bf] focus:border-[#9588f5] focus:ring-4 focus:ring-[#7867f5]/10" /></div>
          <div className="flex flex-wrap gap-x-10 gap-y-5">
            <div><h3 className="text-sm font-bold text-[#35315d]">画面比例</h3><div className="mt-2.5 flex flex-wrap gap-2">{RATIOS.map((ratio) => <button key={ratio.label} type="button" onClick={() => setParams({ size: ratio.size })} className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition ${currentRatio === ratio.label ? 'bg-[#efedfd] text-[#6b5ce7] ring-1 ring-[#8c7cf7]' : 'bg-white text-[#77718f] hover:bg-[#f3f1ff]'}`}>{ratio.label}</button>)}</div></div>
            <div><h3 className="text-sm font-bold text-[#35315d]">生成数量</h3><div className="mt-2.5 flex items-center gap-3"><button type="button" onClick={() => setCount(Math.max(1, count - 1))} className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-[#77718f] hover:bg-[#efedfd]"><IconMinus className="h-4 w-4" /></button><span className="w-5 text-center text-sm font-bold">{count}</span><button type="button" onClick={() => setCount(Math.min(4, count + 1))} className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-[#77718f] hover:bg-[#efedfd]"><IconPlus className="h-4 w-4" /></button></div></div>
          </div>
          <button type="button" disabled={submitting} onClick={() => void generate()} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#7462f3] to-[#9b76f6] px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-[#7867f5]/25 transition hover:from-[#6653e8] hover:to-[#8f69ed] disabled:cursor-wait disabled:opacity-60"><IconSparkle className="h-4 w-4" />{submitting ? '正在提交…' : `开始生成${credits ? ` · ${cost} 积分` : ''}`}</button>
          {credits && <p className="text-center text-[11px] text-[#aaa5bf]">剩余 {view?.available ?? 0} 积分 · 失败自动退分 · 幸运免单会写入积分记录</p>}
        </div>
      </div>
    </section>
  )
}

function LiveEditor() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const showToast = useStore((s) => s.showToast)
  const [image, setImage] = useState('')
  const [motion, setMotion] = useState<LiveMotion>('slow-zoom')
  const [duration, setDuration] = useState(5)
  const [exporting, setExporting] = useState(false)
  const motions: Array<{ key: LiveMotion, label: string, description: string }> = [
    { key: 'slow-zoom', label: '缓慢推进', description: '轻柔放大，突出主体' },
    { key: 'horizontal-pan', label: '横向运镜', description: '从左到右平稳移动' },
    { key: 'gentle-float', label: '自然漂浮', description: '模拟轻微手持呼吸感' },
  ]

  const upload = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    setImage(await fileToDataUrl(file))
  }

  const download = async () => {
    if (!image) {
      showToast('请先上传一张图片', 'error')
      return
    }
    setExporting(true)
    try {
      const blob = await exportLivePhoto(image, motion, duration)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `live-${Date.now()}.webm`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1_000)
      showToast('Live 视频已导出', 'success')
    } catch (err) {
      console.error(err)
      showToast('当前浏览器无法导出视频，请使用最新版 Chrome', 'error')
    } finally {
      setExporting(false)
    }
  }

  return (
    <section className="overflow-hidden rounded-[28px] border border-[#e7e3f7] bg-gradient-to-br from-white via-[#fbfaff] to-[#efedff] p-5 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-2xl font-bold text-[#292650]">Live 实况图</h2><p className="mt-2 text-sm text-[#817b9f]">在浏览器本地为静态图片添加自然运镜，导出 WebM 短视频。</p></div><span className="rounded-full bg-[#eafaf3] px-3 py-1.5 text-xs font-semibold text-[#23865e]">本地处理 · 不扣积分</span></div>
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
        <button type="button" onClick={() => fileInputRef.current?.click()} className="relative flex min-h-[480px] items-center justify-center overflow-hidden rounded-3xl border-2 border-dashed border-[#d9d4ef] bg-[#f7f6fd]">
          {image ? <img src={image} alt="Live 预览" className={`h-full min-h-[480px] w-full object-cover live-${motion}`} style={{ animationDuration: `${duration}s` }} /> : <span className="flex flex-col items-center gap-3 text-[#8d86aa]"><span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white text-[#6b5ce7] shadow-sm"><IconUpload className="h-7 w-7" /></span><span className="text-sm font-semibold">上传一张图片开始制作</span><span className="text-xs text-[#aaa5bf]">建议使用主体清晰的竖图或横图</span></span>}
          {image && <span className="absolute bottom-4 right-4 rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white backdrop-blur">点击更换图片</span>}
        </button>
        <div className="flex flex-col rounded-3xl border border-[#e5e1f3] bg-white p-5">
          <h3 className="text-sm font-bold text-[#35315d]">运镜效果</h3><div className="mt-3 space-y-2">{motions.map((item) => <button key={item.key} type="button" onClick={() => setMotion(item.key)} className={`w-full rounded-2xl border-2 p-4 text-left transition ${motion === item.key ? 'border-[#8c7cf7] bg-[#f3f1ff]' : 'border-[#ebe8f4] hover:border-[#c6bff5]'}`}><span className={`text-sm font-bold ${motion === item.key ? 'text-[#6b5ce7]' : 'text-[#423d63]'}`}>{item.label}</span><span className="mt-1 block text-[11px] text-[#918cae]">{item.description}</span></button>)}</div>
          <h3 className="mt-6 text-sm font-bold text-[#35315d]">视频时长</h3><div className="mt-3 grid grid-cols-3 gap-2">{[3, 5, 8].map((seconds) => <button key={seconds} type="button" onClick={() => setDuration(seconds)} className={`rounded-xl py-2.5 text-xs font-semibold transition ${duration === seconds ? 'bg-[#7867f5] text-white' : 'bg-[#f5f3fb] text-[#77718f] hover:bg-[#ece9fc]'}`}>{seconds} 秒</button>)}</div>
          <button type="button" disabled={exporting} onClick={() => void download()} className="mt-auto flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#7462f3] to-[#9b76f6] px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-[#7867f5]/25 transition disabled:cursor-wait disabled:opacity-60"><IconDownload className="h-4 w-4" />{exporting ? '正在导出…' : '导出 Live 视频'}</button>
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={(event) => { void upload(event.target.files); event.target.value = '' }} />
        </div>
      </div>
    </section>
  )
}

export default function ProfessionalToolsPage() {
  const [searchParams] = useSearchParams()
  const requestedTool = searchParams.get('tool')
  const tool = TOOLS.some((item) => item.key === requestedTool) ? requestedTool as ToolKey : null

  return (
    <AppShell title="专业工具" wide>
      {tool && <Link to="/tools" className="mb-4 inline-flex items-center gap-1.5 text-xs font-semibold text-[#746e91] hover:text-[#6b5ce7]"><IconArrowLeft className="h-4 w-4" />返回专业工具</Link>}
      {!tool && <ToolLanding />}
      {tool === 'ecommerce' && <ProductImageEditor key={tool} tool={tool} />}
      {tool === 'product-suite' && <ProductImageEditor key={tool} tool={tool} />}
      {tool === 'live' && <LiveEditor />}
    </AppShell>
  )
}
