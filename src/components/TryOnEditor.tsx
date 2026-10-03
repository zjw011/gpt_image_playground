import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { InputImage, TryOnOptions } from '../types'
import { getCreditsConfig } from '../lib/backend'
import { useCreditsStore } from '../lib/creditsStore'
import { getImage } from '../lib/db'
import { IMAGE_RATIO_PRESETS } from '../lib/size'
import { normalizeTryOnOptions, validateTryOnImageData } from '../lib/tryOn'
import { createInputImageFromFile, submitTryOnTask, useStore } from '../store'
import { IconArrowRight, IconMinus, IconPlus, IconSparkle, IconUpload } from '../pages/icons'

const CATEGORIES: Array<{ key: TryOnOptions['category'], label: string }> = [
  { key: 'clothing', label: '衣服' }, { key: 'shoes', label: '鞋履' }, { key: 'bag', label: '包袋' }, { key: 'accessory', label: '配饰' }, { key: 'other', label: '其他商品' },
]
const SCENES: Array<{ key: TryOnOptions['scene'], label: string, note: string }> = [
  { key: 'street', label: '街头日常', note: '城市街景 · 松弛穿搭' },
  { key: 'cafe', label: '咖啡小店', note: '窗边光线 · 日常分享' },
  { key: 'studio', label: '简洁棚拍', note: '干净背景 · 突出商品' },
  { key: 'outdoors', label: '户外生活', note: '自然光线 · 轻松氛围' },
]
const POSES: Array<{ key: TryOnOptions['pose'], label: string }> = [
  { key: 'natural', label: '自然站姿' }, { key: 'walking', label: '行走抓拍' }, { key: 'sitting', label: '轻松坐姿' }, { key: 'showcase', label: '商品展示' },
]

export default function TryOnEditor() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const taskId = searchParams.get('task')
  const saved = useStore((s) => s.tasks.find((task) => task.id === taskId))
  const showToast = useStore((s) => s.showToast)
  const credits = getCreditsConfig()
  const view = useCreditsStore((s) => s.view)
  const personRef = useRef<HTMLInputElement>(null)
  const productRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef(true)
  const loadingRef = useRef({ person: false, product: false, restore: false, submit: false })
  const revisionRef = useRef(0)
  const [images, setImages] = useState<{ person: InputImage | null, product: InputImage | null }>({ person: null, product: null })
  const [options, setOptions] = useState<TryOnOptions>(() => normalizeTryOnOptions(saved?.tryOn))
  const [description, setDescription] = useState(saved?.prompt ?? '')
  const [size, setSize] = useState(saved?.params.size ?? '768x1024')
  const [count, setCount] = useState(saved && Number.isFinite(saved.params.n) ? Math.max(1, Math.min(4, Math.trunc(saved.params.n))) : 1)
  const [uploading, setUploading] = useState({ person: false, product: false })
  const [restoring, setRestoring] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const cost = credits ? credits.costPerImage * count : 0
  const busy = restoring || submitting
  const ready = images.person && images.product && !uploading.person && !uploading.product && !busy

  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
      revisionRef.current++
    }
  }, [])

  useEffect(() => {
    const revision = ++revisionRef.current
    loadingRef.current = { person: false, product: false, restore: false, submit: false }
    setUploading({ person: false, product: false })
    setRestoring(false)
    setSubmitting(false)
    if (!saved?.tryOn) {
      setImages({ person: null, product: null })
      setOptions(normalizeTryOnOptions(undefined))
      setDescription('')
      setSize('768x1024')
      setCount(1)
      return
    }
    setOptions(normalizeTryOnOptions(saved.tryOn))
    setDescription(saved.prompt)
    setSize(saved.params.size)
    setCount(Number.isFinite(saved.params.n) ? Math.max(1, Math.min(4, Math.trunc(saved.params.n))) : 1)
    setImages({ person: null, product: null })
    setRestoring(true)
    loadingRef.current.restore = true
    void Promise.all(saved.inputImageIds.slice(0, 2).map((id) => getImage(id))).then(async (refs) => {
      if (!activeRef.current || revisionRef.current !== revision) return
      if (refs.length !== 2 || !refs[0] || !refs[1]) throw new Error('人物或商品原图已丢失，请重新上传')
      await validateTryOnImageData([refs[0].dataUrl, refs[1].dataUrl])
      if (!activeRef.current || revisionRef.current !== revision) return
      setImages({ person: { id: refs[0].id, dataUrl: refs[0].dataUrl }, product: { id: refs[1].id, dataUrl: refs[1].dataUrl } })
    }).catch((err) => {
      console.warn('换装参考图恢复失败', err)
      if (activeRef.current && revisionRef.current === revision) showToast(err instanceof Error ? err.message : '参考图恢复失败，请重新上传', 'error')
    }).finally(() => {
      if (activeRef.current && revisionRef.current === revision) {
        loadingRef.current.restore = false
        setRestoring(false)
      }
    })
    return () => { revisionRef.current++ }
  }, [saved?.id, taskId])

  const upload = async (role: 'person' | 'product', file?: File) => {
    if (!file || loadingRef.current[role] || loadingRef.current.restore || loadingRef.current.submit) return
    const revision = revisionRef.current
    loadingRef.current[role] = true
    setUploading((current) => ({ ...current, [role]: true }))
    try {
      const added = await createInputImageFromFile(file)
      if (!activeRef.current || revisionRef.current !== revision) return
      if (!added) throw new Error('请选择有效的图片文件')
      await validateTryOnImageData([added.dataUrl])
      if (!activeRef.current || revisionRef.current !== revision) return
      setImages((current) => ({ ...current, [role]: added }))
    } catch (err) {
      console.warn('换装参考图上传失败', err)
      if (activeRef.current && revisionRef.current === revision) showToast(err instanceof Error ? err.message : '图片上传失败，请换一张图片', 'error')
    } finally {
      if (activeRef.current && revisionRef.current === revision) {
        loadingRef.current[role] = false
        setUploading((current) => ({ ...current, [role]: false }))
      }
    }
  }

  const generate = async () => {
    if (loadingRef.current.submit || loadingRef.current.restore || loadingRef.current.person || loadingRef.current.product) return
    if (!images.person || !images.product) {
      showToast('请分别上传人物图和商品图', 'info')
      return
    }
    loadingRef.current.submit = true
    setSubmitting(true)
    const revision = revisionRef.current
    try {
      const submitted = await submitTryOnTask({ person: images.person, product: images.product, prompt: description, options, size, count })
      if (submitted && activeRef.current && revisionRef.current === revision) navigate('/result')
    } catch (err) {
      console.warn('换装任务提交失败', err)
      if (activeRef.current && revisionRef.current === revision) showToast(err instanceof Error ? err.message : '任务提交失败，请稍后重试', 'error')
    } finally {
      if (activeRef.current && revisionRef.current === revision) {
        loadingRef.current.submit = false
        setSubmitting(false)
      }
    }
  }

  return (
    <section className="overflow-hidden rounded-[28px] border border-[#e7e3f7] bg-gradient-to-br from-white via-[#fbfaff] to-[#efedff] p-4 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h2 className="text-2xl font-bold tracking-tight text-[#292650]">AI 换装与种草</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-[#817b9f]">把你的人物与商品放进同一张真实感照片。穿搭上身、自然手持，创作日常分享感的种草图。</p></div>
        <span className="rounded-full border border-[#e4ddf8] bg-white px-3 py-1.5 text-xs font-semibold text-[#746e91]">双图参考 · {credits ? `预计 ${cost} 积分` : '使用当前绘图服务'}</span>
      </div>
      <div className="mt-6 grid items-start gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="min-w-0">
          <div className="grid grid-cols-2 gap-3 sm:gap-4">
            {([{ role: 'person', label: '人物图', hint: '面部清晰，建议半身或全身照', ref: personRef }, { role: 'product', label: '商品图', hint: '单件商品，颜色与细节清晰', ref: productRef }] as const).map((item) => (
              <div key={item.role} className="min-w-0">
                <div className="mb-2.5 flex items-center gap-2"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#ebe6ff] text-xs font-bold text-[#6b5ce7]">{item.role === 'person' ? '1' : '2'}</span><h3 className="text-sm font-bold text-[#35315d]">{item.label}</h3></div>
                <button type="button" aria-label={`选择${item.label}`} disabled={busy || uploading[item.role]} onClick={() => item.ref.current?.click()} className="group relative flex aspect-[3/4] w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border-2 border-dashed border-[#d6cff0] bg-white transition hover:border-[#8c7cf7] hover:bg-[#faf8ff] disabled:opacity-60">
                  {images[item.role]
                    ? <><img src={images[item.role]!.dataUrl} alt={item.role === 'person' ? '人物参考图' : '商品参考图'} className="h-full w-full object-contain p-2" /><span className="absolute bottom-2 rounded-full bg-[#292650]/70 px-2.5 py-1.5 text-[11px] text-white backdrop-blur">{uploading[item.role] ? '正在读取…' : '点击更换'}</span></>
                    : <><span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#efedfd] text-[#6b5ce7]"><IconUpload className="h-5 w-5" /></span><span className="px-2 text-center text-xs font-semibold text-[#746e91]">{restoring ? '恢复参考图…' : uploading[item.role] ? '正在读取…' : `上传${item.label}`}</span></>}
                </button>
                <p className="mt-2 min-h-10 text-[11px] leading-5 text-[#918cae]">{item.hint}</p>
                <input ref={item.ref} id={`try-on-${item.role}`} aria-label={`上传${item.role === 'person' ? '人物' : '商品'}图片`} type="file" accept="image/*" hidden onChange={(event) => { void upload(item.role, event.target.files?.[0]); event.target.value = '' }} />
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-center gap-3 rounded-2xl border border-[#e7e0f7] bg-white/80 px-3 py-4 text-xs font-semibold text-[#817695]"><span>人物身份</span><span className="text-[#ae9bea]">＋</span><span>商品细节</span><IconArrowRight className="h-4 w-4 text-[#ae9bea]" /><span className="text-[#6b5ce7]">自然种草图</span></div>
          <details className="mt-4 rounded-2xl bg-[#f1edff]/80 p-4 text-xs leading-6 text-[#817695]">
            <summary className="cursor-pointer font-semibold text-[#655988]">拍得清楚，合成更自然</summary>
            <p className="mt-1">衣服尽量平铺或正面展示；鞋履建议搭配全身人物图；手持商品请保留人物手臂空间。补充要求可以指定搭配与动作。</p>
          </details>
          {taskId && !saved?.tryOn && <p role="status" className="mt-3 text-xs leading-5 text-[#918cae]">未找到可编辑的换装记录，请重新上传参考图。</p>}
        </div>
        <fieldset disabled={busy} className="min-w-0 space-y-5 rounded-3xl border border-[#e5def2] bg-white/90 p-4 sm:p-6">
          <div><h3 className="text-sm font-bold text-[#35315d]">生成方式</h3><div className="mt-3 grid grid-cols-2 gap-2">{([{ key: 'wear', label: '上身穿搭', note: '穿衣 · 穿鞋 · 搭配包饰' }, { key: 'hold', label: '手持商品', note: '自然拿着 · 清楚展示' }] as const).map((item) => <button key={item.key} type="button" aria-pressed={options.mode === item.key} onClick={() => setOptions((current) => ({ ...current, mode: item.key }))} className={`min-h-16 rounded-2xl border-2 px-3 py-3 text-left transition ${options.mode === item.key ? 'border-[#8c7cf7] bg-[#f3f1ff]' : 'border-[#e8e5f3] hover:border-[#c6bff5]'}`}><span className="block text-sm font-bold text-[#423d63]">{item.label}</span><span className="mt-1 block text-[11px] text-[#918cae]">{item.note}</span></button>)}</div></div>
          <div><h3 className="text-sm font-bold text-[#35315d]">商品类型</h3><div className="mt-2.5 flex flex-wrap gap-2">{CATEGORIES.map((item) => <button key={item.key} type="button" aria-pressed={options.category === item.key} onClick={() => setOptions((current) => ({ ...current, category: item.key }))} className={`min-h-11 rounded-xl border px-3 py-2 text-xs font-semibold transition ${options.category === item.key ? 'border-[#b8a9f7] bg-[#efedfd] text-[#6b5ce7]' : 'border-[#e8e5f3] bg-white text-[#817695] hover:bg-[#f7f4ff]'}`}>{item.label}</button>)}</div></div>
          <div><h3 className="text-sm font-bold text-[#35315d]">场景氛围</h3><div className="mt-3 grid grid-cols-2 gap-2">{SCENES.map((item) => <button key={item.key} type="button" aria-pressed={options.scene === item.key} onClick={() => setOptions((current) => ({ ...current, scene: item.key }))} className={`rounded-2xl border-2 px-3 py-3 text-left transition ${options.scene === item.key ? 'border-[#8c7cf7] bg-[#f3f1ff]' : 'border-[#e8e5f3] hover:border-[#c6bff5]'}`}><span className="block text-xs font-bold text-[#423d63]">{item.label}</span><span className="mt-1 block text-[11px] text-[#918cae]">{item.note}</span></button>)}</div></div>
          <div><h3 className="text-sm font-bold text-[#35315d]">人物姿势</h3><div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">{POSES.map((item) => <button key={item.key} type="button" aria-pressed={options.pose === item.key} onClick={() => setOptions((current) => ({ ...current, pose: item.key }))} className={`min-h-11 rounded-xl border px-2 py-2 text-xs font-semibold transition ${options.pose === item.key ? 'border-[#b8a9f7] bg-[#efedfd] text-[#6b5ce7]' : 'border-[#e8e5f3] text-[#817695] hover:bg-[#f7f4ff]'}`}>{item.label}</button>)}</div></div>
          <div><label htmlFor="try-on-description" className="text-sm font-bold text-[#35315d]">补充要求 <span className="font-normal text-[#aaa5bf]">（可选）</span></label><textarea id="try-on-description" aria-label="补充要求" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder={options.mode === 'wear' ? '例如：穿上这件外套，搭配简单牛仔裤，自然回头看镜头' : '例如：一只手拿着香水，瓶身朝向镜头，窗边自然光'} className="mt-3 w-full resize-y rounded-2xl border border-[#e4e0f2] bg-white p-3.5 text-sm leading-6 text-[#37335c] outline-none transition placeholder:text-[#aaa5bf] focus:border-[#9588f5] focus:ring-4 focus:ring-[#7867f5]/10" /></div>
          <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:gap-x-6">
            <div className="min-w-0 flex-1"><h3 className="text-sm font-bold text-[#35315d]">画面比例</h3><div className="mt-2.5 flex flex-wrap gap-2">{IMAGE_RATIO_PRESETS.map((ratio) => <button key={ratio.label} type="button" aria-pressed={size === ratio.size} onClick={() => setSize(ratio.size)} className={`min-h-11 rounded-lg border px-3 py-2 text-xs font-semibold transition ${size === ratio.size ? 'border-[#b8a9f7] bg-[#efedfd] text-[#6b5ce7]' : 'border-[#e8e5f3] text-[#77718f] hover:bg-[#f3f1ff]'}`}>{ratio.label}</button>)}</div></div>
            <div><h3 className="text-sm font-bold text-[#35315d]">生成数量</h3><div className="mt-2.5 flex items-center gap-2"><button type="button" aria-label="减少生成数量" disabled={count === 1} onClick={() => setCount((current) => Math.max(1, current - 1))} className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#f5f3fb] text-[#77718f] hover:bg-[#efedfd] disabled:opacity-40"><IconMinus className="h-4 w-4" /></button><span aria-label="生成数量" className="w-6 text-center text-sm font-bold text-[#423d63]">{count}</span><button type="button" aria-label="增加生成数量" disabled={count === 4} onClick={() => setCount((current) => Math.min(4, current + 1))} className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#f5f3fb] text-[#77718f] hover:bg-[#efedfd] disabled:opacity-40"><IconPlus className="h-4 w-4" /></button></div></div>
          </div>
          <button type="button" aria-label="生成种草图" disabled={!ready} onClick={() => void generate()} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#7462f3] to-[#9b76f6] px-4 py-3.5 text-sm font-semibold text-white shadow-lg shadow-[#7867f5]/25 transition hover:from-[#6653e8] hover:to-[#8f69ed] disabled:cursor-not-allowed disabled:opacity-50"><IconSparkle className="h-4 w-4" />{submitting ? '正在提交…' : `生成种草图${credits ? ` · ${cost} 积分` : ''}`}</button>
          <p className="text-center text-[11px] leading-5 text-[#918cae]">{credits ? `剩余 ${view?.available ?? 0} 积分 · 失败自动退分 · ` : ''}提交后可在「我的作品」查看进度</p>
          <p className="text-[11px] leading-5 text-[#918cae]">请使用有权使用的图片。结果为 AI 合成，人物与商品的还原效果取决于模型，请核对手部、衣料、文字等细节。</p>
        </fieldset>
      </div>
    </section>
  )
}
