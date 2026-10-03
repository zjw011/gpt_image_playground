import { useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { getCreditsConfig } from '../../lib/backend'
import { assetUrl } from '../../lib/assetUrl'
import { IMAGE_RATIO_PRESETS as RATIOS } from '../../lib/size'
import { useCreditsStore } from '../../lib/creditsStore'
import type { ProfessionalPresetKey } from '../../lib/professionalTools'
import { addImageFromFile, submitTask, useStore } from '../../store'
import { IconArrowLeft, IconArrowRight, IconMinus, IconPlus, IconSparkle, IconUpload, IconLayers, IconUser, IconImage, IconToolbox, IconCheck } from '../icons'
import AppShell from './AppShell'
import QuickMotionEditor from '../../components/QuickMotionEditor'
import TryOnEditor from '../../components/TryOnEditor'
import ProfessionalStep from '../../components/ProfessionalStep'
import './professionalTools.css'

type ToolKey = 'ecommerce' | 'product-suite' | 'live' | 'try-on'

const TOOLS: Array<{ key: ToolKey, title: string, eyebrow: string, description: string, image: string }> = [
  { key: 'ecommerce', title: '电商设计', eyebrow: '单图精修', description: '上传商品图，生成适合详情页、海报和营销场景的成品。', image: '/art/cover-commerce-v2.jpg' },
  { key: 'product-suite', title: '商品电商套图', eyebrow: '批量出图', description: '围绕同一商品，一次生成视觉统一的成套电商素材。', image: '/art/cover-suite-v2.jpg' },
  { key: 'live', title: 'Live 实况图', eyebrow: '快速运镜 / AI 微动作', description: '单图轻微缩放、平移，或用 AI 创作微动作，预览并导出短视频。', image: '/art/work-seaside.jpg' },
  { key: 'try-on', title: 'AI 换装与种草', eyebrow: '单品上身 / 爆款参考', description: '人物搭配商品或穿搭参考，支持自然手持、整套换装与随机姿势。', image: '/art/cover-try-on.svg' },
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
      <div className="mt-7 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
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

function ProductImageEditor({ tool }: { tool: 'ecommerce' | 'product-suite' }) {
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
  const currentRatio = RATIOS.find((ratio) => ratio.size === params.size)?.label
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

  const selected = options.find((item) => item.key === scene)!
  return (
    <section>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3 px-1">
        <div><h2 className="text-xl font-bold tracking-tight text-[#292650] sm:text-2xl">{title}</h2><p className="mt-1.5 text-xs leading-6 text-[#9187ac] sm:text-sm">{subtitle}</p></div>
        <span className="rounded-full border border-[#e9e2f7] bg-white px-3 py-1.5 text-xs text-[#817695]">{credits ? `预计 ${cost} 积分` : '按当前渠道计费'}</span>
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)]">
        <div className="professional-panel min-w-0 space-y-7 p-4 sm:p-6">
          <div>
            <ProfessionalStep step={1}>上传商品图</ProfessionalStep>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button type="button" aria-label="上传商品图片" onClick={() => fileInputRef.current?.click()} className="group relative flex aspect-[4/3] min-w-0 flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border-2 border-dashed border-[#dcd2f6] bg-[#faf8ff] px-2 text-[#8d86aa] transition hover:border-[#aa8ff8] hover:bg-[#f3eeff]">
                {inputImages[0] ? <img src={inputImages[0].dataUrl} alt="商品原图" className="h-full w-full object-contain p-2" /> : <><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#eee7ff] text-[#8c6cf5]"><IconUpload className="h-5 w-5" /></span><span className="text-xs font-semibold">上传商品图片</span></>}
              </button>
              <div className="flex min-w-0 flex-col justify-center rounded-2xl border border-[#f0eafa] bg-gradient-to-br from-[#fcfaff] to-[#f5f0ff] p-3 sm:p-4">
                <span className="text-xs font-bold text-[#74658f]">好素材，才有好设计</span>
                <p className="mt-2 text-[11px] leading-5 text-[#a397b9]">主体清晰、无遮挡。尽量保留完整包装与商品细节。</p>
                {inputImages[0] && <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => fileInputRef.current?.click()} className="min-h-11 rounded-xl bg-white px-3 text-xs font-semibold text-[#8064db] shadow-sm">更换图片</button><button type="button" onClick={() => clearInputImages()} className="min-h-11 px-2 text-xs text-[#9b8bac]">移除</button></div>}
              </div>
            </div>
            <input aria-label="选择商品图片" ref={fileInputRef} type="file" accept="image/*" hidden onChange={(event) => { void upload(event.target.files); event.target.value = '' }} />
          </div>
          <div>
            <ProfessionalStep step={2}>选择设计方案</ProfessionalStep>
            <div className={`mt-4 grid grid-cols-2 gap-3 ${tool === 'product-suite' ? 'sm:grid-cols-3' : 'sm:grid-cols-4'}`}>
              {options.map((item, idx) => <button key={item.key} type="button" aria-pressed={scene === item.key} onClick={() => setScene(item.key)} className={`group min-w-0 overflow-hidden rounded-2xl border-2 text-left transition ${scene === item.key ? 'border-[#a187fa] bg-[#f4efff] shadow-sm shadow-violet-200' : 'border-[#eee8f7] bg-[#faf8fe] hover:border-[#c8b7f5]'}`}>
                <div className={`relative aspect-[4/3] overflow-hidden ${idx === 0 ? 'bg-[#eee8fa]' : 'bg-[#f7e6dc]'}`}><img src={assetUrl(tool === 'product-suite' ? '/art/cover-suite-v2.jpg' : '/art/cover-commerce-v2.jpg')} alt="" className={`h-full w-full object-cover transition duration-300 group-hover:scale-105 ${idx === 2 ? 'saturate-75' : ''}`} /><span className="absolute bottom-1 right-1 rounded bg-white/85 px-1.5 text-[9px] leading-4 text-[#897699]">示意</span></div>
                <span className={`block px-2 py-2.5 text-center text-xs font-bold ${scene === item.key ? 'text-[#7755df]' : 'text-[#655b80]'}`}>{item.label}</span>
              </button>)}
            </div>
            <p className="mt-2.5 text-[11px] leading-5 text-[#9a8fad]">{selected.description}</p>
          </div>
          <div>
            <ProfessionalStep step={3}>补充要求 <span className="font-normal text-[#afa3be]">（可选）</span></ProfessionalStep>
            <div className="mt-4 overflow-hidden rounded-2xl border border-[#e9e1f4] bg-[#fdfbff] focus-within:border-[#b39bf4] focus-within:ring-4 focus-within:ring-violet-100/60">
              <textarea aria-label="补充要求" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="例如：保留瓶身文字，暖色桌面场景，右侧留出标题空间" className="w-full resize-y bg-transparent p-3.5 text-sm leading-6 text-[#37335c] outline-none placeholder:text-[#b3a7c2]" />
              <div className="flex justify-end px-3 pb-2 text-[10px] text-[#b1a5bf]">{description.length} 字</div>
            </div>
          </div>
          <div>
            <ProfessionalStep step={4}>设置画面</ProfessionalStep>
            <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:flex-wrap">
              <div className="min-w-0 flex-1"><h4 className="text-xs font-semibold text-[#8a7c9f]">画面比例</h4><div className="mt-2.5 flex flex-wrap gap-2">{RATIOS.map((ratio) => <button key={ratio.label} type="button" aria-pressed={currentRatio === ratio.label} onClick={() => setParams({ size: ratio.size })} className={`min-h-11 rounded-xl border px-3 text-xs font-semibold transition ${currentRatio === ratio.label ? 'border-[#baa4f7] bg-[#efe8ff] text-[#7755df]' : 'border-[#eee8f7] bg-[#f8f5fc] text-[#9687a9] hover:bg-[#eee7fa]'}`}>{ratio.label}</button>)}</div></div>
              <div><h4 className="text-xs font-semibold text-[#8a7c9f]">生成数量</h4><div className="mt-2.5 flex items-center gap-2"><button type="button" aria-label="减少生成数量" disabled={count === 1} onClick={() => setCount(Math.max(1, count - 1))} className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#f5f0fb] text-[#9687a9] disabled:opacity-40"><IconMinus className="h-4 w-4" /></button><span aria-label="生成数量" className="w-5 text-center text-sm font-bold">{count}</span><button type="button" aria-label="增加生成数量" disabled={count === 4} onClick={() => setCount(Math.min(4, count + 1))} className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#f5f0fb] text-[#9687a9] disabled:opacity-40"><IconPlus className="h-4 w-4" /></button></div></div>
            </div>
          </div>
        </div>
        <div className="min-w-0 xl:sticky xl:top-24">
          <div className="professional-panel p-4 sm:p-6">
            <div className="mb-4 flex items-center justify-between gap-3"><h3 className="text-base font-bold text-[#35315d]">设计方向</h3><span className="rounded-full bg-[#f2ecff] px-3 py-1.5 text-[11px] font-semibold text-[#9278ca]">方案示意</span></div>
            <div className="relative overflow-hidden rounded-2xl bg-[#f9eee8]">
              <img src={assetUrl(tool === 'product-suite' ? '/art/cover-suite-v2.jpg' : '/art/cover-commerce-v2.jpg')} alt="设计方案示意，非生成结果" className="aspect-[4/3] w-full object-cover sm:aspect-square" />
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-[#382330]/75 to-transparent px-5 pb-5 pt-12 text-white"><p className="text-base font-bold">商品视觉示意</p><p className="mt-1 text-xs text-white/85">已选方案：{selected.label} · 以实际生成结果为准</p></div>
            </div>
            <p className="mt-3 text-[11px] leading-5 text-[#a395b4]">示例仅展示设计方向，不是你的商品生成结果。提交后将在结果页查看真实作品。</p>
          </div>
          <button type="button" disabled={submitting} onClick={() => void generate()} className="mt-4 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#8060fa] to-[#ac7afa] px-6 py-4 text-sm font-semibold text-white shadow-lg shadow-[#9876e7]/25 transition hover:brightness-105 disabled:cursor-wait disabled:opacity-60"><IconSparkle className="h-5 w-5" />{submitting ? '正在提交…' : `开始生成${credits ? ` · ${cost} 积分` : ''}`}</button>
          {credits && <p className="mt-3 text-center text-[11px] leading-5 text-[#aaa5bf]">剩余 {view?.available ?? 0} 积分 · 失败自动退分 · 幸运免单会写入积分记录</p>}
        </div>
      </div>
    </section>
  )
}

function AiLiveEditor() {
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
  const frameOptions = [6, 8]
  const [motion, setMotion] = useState<ProfessionalPresetKey>('live-blink')
  const [frameCount, setFrameCount] = useState(frameOptions[frameOptions.length - 1])
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const motions: Array<{ key: ProfessionalPresetKey, label: string, description: string }> = [
    { key: 'live-blink', label: '自然眨眼', description: '眼神和眼睑发生极轻微变化' },
    { key: 'live-breeze', label: '微风轻动', description: '发梢、衣角或植物轻轻摆动' },
    { key: 'live-breath', label: '呼吸起伏', description: '肩颈出现细微自然呼吸变化' },
  ]
  const currentRatio = RATIOS.find((ratio) => ratio.size === params.size)?.label
  const cost = credits ? credits.costPerImage * frameCount : 0

  const upload = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    clearInputImages()
    await addImageFromFile(file)
  }

  const generate = async () => {
    if (inputImages.length === 0) {
      showToast('请先上传一张实况参考图', 'error')
      return
    }
    setSubmitting(true)
    setPrompt(description.trim() || '保持原图人物与场景完全一致，只生成自然、克制、连续的轻微动态变化')
    setParams({ n: 1 })
    try {
      if (!await submitTask({ professionalPreset: motion, liveFrameCount: frameCount })) return
      navigate('/result')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="professional-editor">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-2xl font-bold text-[#292650]">Live 实况图</h2><p className="mt-2 text-sm text-[#817b9f]">AI 逐帧生成 6–8 张连续画面，每张完成后作为下一帧参考，结果页自动补帧播放并可下载短视频。</p></div><span className="rounded-full bg-[#fff6e5] px-3 py-1.5 text-xs font-semibold text-[#b67922]">串行连续帧 · {frameCount} 张</span></div>
      <div className="mt-6 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <button type="button" onClick={() => fileInputRef.current?.click()} className="professional-panel relative flex min-h-[260px] min-w-0 items-center justify-center overflow-hidden border-2 border-dashed border-[#d9d4ef] bg-[#faf8ff] lg:order-2 sm:min-h-[480px]">
          {inputImages[0] ? <img src={inputImages[0].dataUrl} alt="Live 参考图" className="h-full min-h-[260px] w-full object-contain sm:min-h-[480px]" /> : <span className="flex flex-col items-center gap-3 px-3 text-[#8d86aa]"><span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white text-[#6b5ce7] shadow-sm"><IconUpload className="h-7 w-7" /></span><span className="text-sm font-semibold">上传一张图片开始制作</span><span className="text-xs text-[#aaa5bf]">人物、宠物或轻微环境动态效果更自然</span></span>}
          {inputImages[0] && <span className="absolute bottom-4 right-4 rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white backdrop-blur">点击更换图片</span>}
        </button>
        <div className="professional-panel flex min-w-0 flex-col p-4 lg:order-1 sm:p-6">
          <ProfessionalStep step={1}>轻微动态</ProfessionalStep><div className="mt-4 space-y-2">{motions.map((item) => <button key={item.key} type="button" aria-pressed={motion === item.key} onClick={() => setMotion(item.key)} className={`w-full rounded-2xl border-2 p-4 text-left transition ${motion === item.key ? 'border-[#b29cf7] bg-gradient-to-r from-[#f3edff] to-[#fcfaff]' : 'border-[#ebe8f4] bg-[#fcfaff] hover:border-[#c6bff5]'}`}><span className={`text-sm font-bold ${motion === item.key ? 'text-[#6b5ce7]' : 'text-[#423d63]'}`}>{item.label}</span><span className="mt-1 block text-[11px] text-[#918cae]">{item.description}</span></button>)}</div>
          <div className="mt-6"><ProfessionalStep step={2}>AI 关键帧</ProfessionalStep></div><div className="mt-3 grid grid-cols-2 gap-2">{frameOptions.map((count) => <button key={count} type="button" aria-pressed={frameCount === count} onClick={() => setFrameCount(count)} className={`min-h-11 rounded-xl py-2.5 text-xs font-semibold transition ${frameCount === count ? 'bg-gradient-to-r from-[#8c6cf5] to-[#a681f5] text-white' : 'bg-[#f5f3fb] text-[#77718f] hover:bg-[#ece9fc]'}`}>{count} 张{count === 8 ? ' · 更自然' : ' · 更省积分'}</button>)}</div>
          <div className="mt-6"><ProfessionalStep step={3}>画面比例</ProfessionalStep></div><div className="mt-3 flex flex-wrap gap-2">{RATIOS.map((ratio) => <button key={ratio.label} type="button" aria-pressed={currentRatio === ratio.label} onClick={() => setParams({ size: ratio.size })} className={`min-h-11 rounded-xl border px-3 py-2 text-xs font-semibold transition ${currentRatio === ratio.label ? 'border-[#baa4f7] bg-[#efe8ff] text-[#7755df]' : 'border-[#eee8f7] bg-[#f8f5fc] text-[#9687a9] hover:bg-[#eee7fa]'}`}>{ratio.label}</button>)}</div>
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="可选：补充希望发生的极轻微动作" className="mt-5 w-full resize-none rounded-2xl border border-[#e4e0f2] bg-white p-3.5 text-sm leading-6 text-[#37335c] outline-none placeholder:text-[#aaa5bf] focus:border-[#9588f5]" />
          <p className="mt-3 text-[11px] leading-5 text-[#aaa5bf]">系统会依次提交 {frameCount} 次单图任务，上一帧返回后才继续下一帧；完成后按往返顺序平滑混合成约 {((frameCount * 2 - 2) * 0.28).toFixed(1)} 秒的短视频。视频不是苹果相册中的原生实况照片。</p>
          <button type="button" disabled={submitting} onClick={() => void generate()} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#7462f3] to-[#9b76f6] px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-[#7867f5]/25 transition disabled:cursor-wait disabled:opacity-60"><IconSparkle className="h-4 w-4" />{submitting ? '正在提交…' : `生成 Live 实况${credits ? ` · ${cost} 积分` : ''}`}</button>
          {credits && <p className="mt-2 text-center text-[11px] text-[#aaa5bf]">剩余 {view?.available ?? 0} 积分 · 按本次提交帧数计费 · 失败自动退分</p>}
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={(event) => { void upload(event.target.files); event.target.value = '' }} />
        </div>
      </div>
    </section>
  )
}

function LiveEditor() {
  const [searchParams, setSearchParams] = useSearchParams()
  const ai = searchParams.get('liveMode') === 'ai'

  return (
    <div>
      <div role="tablist" aria-label="实况制作方式" className="mb-5 grid max-w-lg grid-cols-2 gap-2 rounded-2xl border border-[#e7e1f5] bg-white p-1.5">
        {[{ key: 'quick', label: '快速运镜', note: '原图轻动 · 0 积分' }, { key: 'ai', label: 'AI 微动作', note: '眨眼 / 微风 / 呼吸' }].map((item) => (
          <button key={item.key} id={`live-tab-${item.key}`} type="button" role="tab" aria-selected={ai === (item.key === 'ai')} aria-controls={`live-panel-${item.key}`} onClick={() => {
            const next = new URLSearchParams(searchParams)
            next.set('liveMode', item.key)
            next.delete('task')
            setSearchParams(next, { replace: true })
          }} className={`rounded-xl px-3 py-3 text-left transition ${ai === (item.key === 'ai') ? 'bg-[#eee8ff] text-[#7352db] shadow-sm' : 'text-[#817695] hover:bg-[#f7f3ff]'}`}>
            <span className="block text-sm font-bold">{item.label}</span>
            <span className="mt-1 block text-[11px] opacity-80">{item.note}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`live-panel-${ai ? 'ai' : 'quick'}`} aria-labelledby={`live-tab-${ai ? 'ai' : 'quick'}`}>
        {ai ? <AiLiveEditor /> : <QuickMotionEditor />}
      </div>
    </div>
  )
}

export default function ProfessionalToolsPage() {
  const [searchParams] = useSearchParams()
  const requestedTool = searchParams.get('tool')
  const tool = TOOLS.some((item) => item.key === requestedTool) ? requestedTool as ToolKey : null

  return (
    <AppShell title="专业工具" wide>
      <div className="professional-workspace">
        {tool && <div className="mb-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <Link to="/tools" className="inline-flex min-h-11 items-center gap-1.5 text-xs font-semibold text-[#746e91] hover:text-[#6b5ce7]"><IconArrowLeft className="h-4 w-4" />返回专业工具</Link>
            <Link to="/me?tab=works" className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[#e8e2f6] bg-white px-4 text-xs font-semibold text-[#746e91] hover:border-[#b9a7f4]"><IconImage className="h-4 w-4" />创作记录</Link>
          </div>
          <nav aria-label="专业工具切换" className="grid grid-cols-2 gap-2.5 lg:grid-cols-4 lg:gap-3">
            {TOOLS.map((item) => {
              const Icon = item.key === 'ecommerce' ? IconToolbox : item.key === 'product-suite' ? IconLayers : item.key === 'live' ? IconSparkle : IconUser
              const selected = tool === item.key
              return <Link key={item.key} to={`/tools?tool=${item.key}`} aria-current={selected ? 'page' : undefined} className={`group relative flex min-h-[82px] min-w-0 items-center gap-2.5 rounded-2xl border px-3 py-3 transition sm:gap-4 sm:px-5 sm:py-5 ${selected ? 'border-[#ab96ff] bg-gradient-to-br from-white to-[#f0eaff] shadow-md shadow-violet-200/40 ring-1 ring-[#cabaff]' : 'border-[#ece7f7] bg-white/90 hover:border-[#cabaff] hover:bg-[#faf8ff] hover:shadow-sm'}`}>
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl sm:h-12 sm:w-12 ${selected ? 'bg-[#eae0ff] text-[#7755eb]' : 'bg-[#f3effe] text-[#9176e9]'}`}><Icon className="h-5 w-5 sm:h-6 sm:w-6" /></span>
                <span className="min-w-0"><span className={`block text-xs font-bold sm:text-sm ${selected ? 'text-[#7352db]' : 'text-[#35315d]'}`}>{item.title}</span><span className="mt-1.5 hidden text-[11px] leading-5 text-[#9187ac] sm:block">{item.eyebrow}</span></span>
                {selected && <span aria-hidden="true" className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-[#8c6cf5] text-white"><IconCheck className="h-2.5 w-2.5" /></span>}
              </Link>
            })}
          </nav>
        </div>}
        {!tool && <ToolLanding />}
        {tool === 'ecommerce' && <ProductImageEditor key={tool} tool={tool} />}
        {tool === 'product-suite' && <ProductImageEditor key={tool} tool={tool} />}
        {tool === 'live' && <LiveEditor />}
        {tool === 'try-on' && <TryOnEditor />}
      </div>
    </AppShell>
  )
}
