import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { QuickMotionOptions } from '../types'
import { normalizeQuickMotionOptions } from '../lib/quickMotion'
import { getImage } from '../lib/db'
import { createInputImageFromFile, submitQuickMotionTask, useStore } from '../store'
import { IconSparkle, IconUpload } from '../pages/icons'
import QuickMotionPlayer from './QuickMotionPlayer'
import ProfessionalStep from './ProfessionalStep'

const EFFECTS: Array<{ key: QuickMotionOptions['effect'], label: string, description: string }> = [
  { key: 'zoom', label: '轻微缩放', description: '缓慢推近，再轻轻回到原位' },
  { key: 'pan-left', label: '向左轻移', description: '镜头向左移动后平滑返回' },
  { key: 'pan-right', label: '向右轻移', description: '镜头向右移动后平滑返回' },
]

export default function QuickMotionEditor() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const fileRef = useRef<HTMLInputElement>(null)
  const loadRef = useRef(0)
  const activeRef = useRef(true)
  const inputImages = useStore((s) => s.inputImages)
  const setInputImages = useStore((s) => s.setInputImages)
  const showToast = useStore((s) => s.showToast)
  const saved = useStore((s) => s.tasks.find((task) => task.id === searchParams.get('task')))
  const [options, setOptions] = useState<QuickMotionOptions>(() => normalizeQuickMotionOptions(saved?.quickMotion))
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const image = inputImages[0]

  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
      loadRef.current++
    }
  }, [])

  useEffect(() => {
    if (!saved?.quickMotion) return
    setOptions(normalizeQuickMotionOptions(saved.quickMotion))
    const revision = ++loadRef.current
    const id = saved.inputImageIds[0] ?? saved.outputImages[0]
    setInputImages([])
    void getImage(id).then((source) => {
      if (loadRef.current !== revision) return
      if (!source) throw new Error('原始图片已丢失，请重新上传')
      setInputImages([{ id: source.id, dataUrl: source.dataUrl }])
    }).catch((err) => {
      if (loadRef.current !== revision) return
      console.warn('快速运镜原图恢复失败', err)
      showToast(err instanceof Error ? err.message : '原图恢复失败，请重新上传', 'error')
    })
    return () => { loadRef.current++ }
  }, [saved?.id])

  const upload = async (file?: File) => {
    if (!file || uploading || saving) return
    loadRef.current++
    setUploading(true)
    try {
      const added = await createInputImageFromFile(file)
      if (!activeRef.current) return
      if (!added) throw new Error('请选择有效的图片文件')
      setInputImages([added])
    } catch (err) {
      console.warn('快速运镜图片上传失败', err)
      if (activeRef.current) showToast(err instanceof Error ? err.message : '图片上传失败，请换一张图片', 'error')
    } finally {
      if (activeRef.current) setUploading(false)
    }
  }

  const save = async () => {
    if (saving || uploading) return
    if (!image) {
      showToast('请先上传一张图片', 'info')
      return
    }
    setSaving(true)
    try {
      const id = await submitQuickMotionTask(options)
      if (id && activeRef.current) navigate(`/result?task=${id}`)
    } finally {
      if (activeRef.current) setSaving(false)
    }
  }

  return (
    <section className="professional-editor">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h2 className="text-2xl font-bold text-[#292650]">快速运镜</h2><p className="mt-2 text-sm leading-6 text-[#817b9f]">让原图轻轻动一下。无需 AI 重绘，人物、商品与细节保持原样。</p></div>
        <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-600">本地制作 · 0 积分</span>
      </div>
      <div className="mt-6 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="professional-panel min-w-0 p-4 lg:order-2 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3"><h3 className="text-base font-bold text-[#35315d]">实时预览</h3><span className="rounded-full bg-[#f2ecff] px-3 py-1.5 text-[11px] text-[#9278ca]">原图轻动</span></div>
          <div className="flex min-h-[260px] items-center justify-center overflow-hidden rounded-3xl border border-[#e5e1f3] bg-[#f7f6fd] p-3 sm:min-h-[420px] sm:p-5">
            {image ? <QuickMotionPlayer src={image.dataUrl} options={options} /> : (
              <button type="button" disabled={uploading} onClick={() => fileRef.current?.click()} className="flex min-h-[230px] w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-[#d9d4ef] text-[#8d86aa] transition hover:border-[#8c7cf7] hover:bg-white">
                <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white text-[#6b5ce7] shadow-sm"><IconUpload className="h-7 w-7" /></span>
                <span className="text-sm font-semibold">{uploading ? '正在读取图片…' : '上传一张图片开始制作'}</span>
                <span className="text-xs text-[#aaa5bf]">照片、插画和商品图都可以</span>
              </button>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-[#918cae]">实时预览 · {options.duration} 秒 · 30 fps 导出</p>
            {image && <button type="button" disabled={uploading || saving} onClick={() => fileRef.current?.click()} className="min-h-11 rounded-xl border border-[#e5e1f3] bg-white px-4 py-2.5 text-xs font-semibold text-[#6b5ce7] hover:bg-[#f7f5ff] disabled:opacity-50">{uploading ? '读取中…' : '更换图片'}</button>}
          </div>
          <input id="quick-motion-upload" aria-label="上传运镜图片" ref={fileRef} type="file" accept="image/*" hidden onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = '' }} />
        </div>
        <div className="professional-panel min-w-0 p-4 lg:order-1 sm:p-6">
          <ProfessionalStep step={1}>运镜效果</ProfessionalStep>
          <div className="mt-3 space-y-2">{EFFECTS.map((item) => (
            <button key={item.key} type="button" aria-pressed={options.effect === item.key} onClick={() => setOptions((current) => ({ ...current, effect: item.key }))} className={`w-full rounded-2xl border-2 p-4 text-left transition ${options.effect === item.key ? 'border-[#8c7cf7] bg-[#f3f1ff]' : 'border-[#ebe8f4] hover:border-[#c6bff5]'}`}>
              <span className={`text-sm font-bold ${options.effect === item.key ? 'text-[#6b5ce7]' : 'text-[#423d63]'}`}>{item.label}</span><span className="mt-1 block text-[11px] text-[#918cae]">{item.description}</span>
            </button>
          ))}</div>
          <div className="mt-6"><ProfessionalStep step={2}>播放时长</ProfessionalStep></div>
          <div className="mt-3 grid grid-cols-3 gap-2">{[1, 2, 3].map((duration) => <button key={duration} type="button" aria-pressed={options.duration === duration} onClick={() => setOptions((current) => ({ ...current, duration }))} className={`min-h-11 rounded-xl py-3 text-xs font-semibold transition ${options.duration === duration ? 'bg-[#7867f5] text-white' : 'bg-[#f5f3fb] text-[#77718f] hover:bg-[#ece9fc]'}`}>{duration} 秒</button>)}</div>
          <div className="mt-6"><ProfessionalStep step={3}>运动幅度</ProfessionalStep></div>
          <div className="mt-3 grid grid-cols-3 gap-2">{[{ value: 2, label: '轻柔' }, { value: 3, label: '自然' }, { value: 5, label: '明显' }].map((item) => <button key={item.value} type="button" aria-pressed={options.strength === item.value} onClick={() => setOptions((current) => ({ ...current, strength: item.value }))} className={`min-h-11 rounded-xl py-3 text-xs font-semibold transition ${options.strength === item.value ? 'bg-[#efedfd] text-[#6b5ce7] ring-1 ring-[#8c7cf7]' : 'bg-[#f5f3fb] text-[#77718f] hover:bg-[#ece9fc]'}`}>{item.label} · {item.value}%</button>)}</div>
          <p className="mt-4 text-[11px] leading-5 text-[#918cae]">仅模拟镜头运动，不会生成眨眼或新的画面。平移会轻微裁切边缘，避免露出黑边。</p>
          <button type="button" disabled={!image || uploading || saving} onClick={() => void save()} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#7462f3] to-[#9b76f6] px-5 py-3.5 text-sm font-semibold text-white shadow-lg shadow-[#7867f5]/25 transition disabled:cursor-not-allowed disabled:opacity-40"><IconSparkle className="h-4 w-4" />{saving ? '正在保存…' : '保存作品与预览'}</button>
          <p className="mt-2 text-center text-[11px] leading-5 text-[#aaa5bf]">保存到本浏览器的「我的作品」，随时重新播放和导出。</p>
          <details className="mt-4 rounded-xl border border-[#e9e4f4] bg-[#faf9ff] px-3 py-2.5 text-[11px] leading-5 text-[#918cae]"><summary className="cursor-pointer font-semibold text-[#746e91]">导出格式说明</summary><p className="mt-2">导出为普通短视频：浏览器支持时优先 MP4，否则 WebM。当前不提供苹果原生 Live Photo 配对导出，视频下载后不会自动成为 iPhone 相册中的实况照片。</p></details>
        </div>
      </div>
    </section>
  )
}
