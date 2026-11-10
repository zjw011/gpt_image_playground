import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DEFAULT_PARAMS, type InputImage, type TaskRecord } from '../types'
import { getImage } from '../lib/db'
import { pasteImages } from '../lib/imagePaste'
import { supportsNativeGif } from '../lib/nativeGif'
import { createInputImageFromFile, submitTask, useStore } from '../store'
import { IconArrowRight, IconSparkle, IconTrash, IconUpload } from '../pages/icons'
import ImagePasteButton from './ImagePasteButton'
import ProfessionalStep from './ProfessionalStep'

export default function NativeGifEditor({ saved }: { saved?: TaskRecord }) {
  const navigate = useNavigate()
  const settings = useStore((s) => s.settings)
  const showToast = useStore((s) => s.showToast)
  const profiles = settings.profiles.filter(supportsNativeGif)
  const [profileId, setProfileId] = useState(saved?.apiProfileId ?? settings.activeProfileId)
  const profile = profiles.find((item) => item.id === profileId) ?? profiles[0]
  const [prompt, setPrompt] = useState(saved?.prompt ?? '')
  const [image, setImage] = useState<InputImage | null>(null)
  const [size, setSize] = useState(saved?.params.size ?? 'auto')
  const [frames, setFrames] = useState(Math.max(2, Math.min(16, Math.trunc(saved?.params.frame_count ?? 9))))
  const [duration, setDuration] = useState(Math.max(20, Math.min(2000, Math.trunc(saved?.params.frame_duration_ms ?? 200))))
  const [busy, setBusy] = useState<'restore' | 'upload' | 'submit' | null>(saved?.inputImageIds.length ? 'restore' : null)
  const [missingReference, setMissingReference] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef(true)
  const busyRef = useRef(busy)

  useEffect(() => {
    activeRef.current = true
    let cancelled = false
    const referenceId = saved?.inputImageIds[0]
    if (referenceId) {
      busyRef.current = 'restore'
      setBusy('restore')
      void getImage(referenceId).then((stored) => {
        if (cancelled) return
        if (!stored) throw new Error('原参考图已丢失，请重新上传或移除参考图后继续')
        if (!/^data:image\/(?:png|jpe?g|webp);/i.test(stored.dataUrl)) throw new Error('请使用 PNG、JPG 或 WebP 静态参考图')
        setImage({ id: stored.id, dataUrl: stored.dataUrl })
      }).catch((err) => {
        if (cancelled) return
        console.warn('GIF 参考图恢复失败', err)
        setMissingReference(true)
        showToast('原参考图未能恢复，请重新上传或移除参考图后继续', 'error')
      }).finally(() => {
        if (cancelled) return
        busyRef.current = null
        setBusy(null)
      })
    }
    return () => {
      cancelled = true
      activeRef.current = false
    }
  }, [saved?.id])

  const upload = async (file?: File) => {
    if (!file || busyRef.current) return
    busyRef.current = 'upload'
    setBusy('upload')
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type.toLowerCase())) throw new Error('请使用 PNG、JPG 或 WebP 静态参考图')
      const added = await createInputImageFromFile(file)
      if (!activeRef.current) return
      if (!added) throw new Error('请选择有效的图片文件')
      setImage(added)
      setMissingReference(false)
    } catch (err) {
      console.warn('GIF 参考图上传失败', err)
      if (activeRef.current) showToast(err instanceof Error ? err.message : '图片上传失败，请重新选择', 'error')
    } finally {
      busyRef.current = null
      if (activeRef.current) setBusy(null)
    }
  }

  const generate = async () => {
    if (busyRef.current || !profile || !prompt.trim() || missingReference) return
    busyRef.current = 'submit'
    setBusy('submit')
    try {
      const submitted = await submitTask({
        apiProfileId: profile.id,
        professionalPreset: 'live-gif',
        inputSnapshot: {
          prompt: prompt.trim(),
          inputImages: image ? [image] : [],
          params: { ...DEFAULT_PARAMS, size, n: 1, output_format: 'gif', frame_count: frames, frame_duration_ms: duration },
        },
      })
      if (submitted && activeRef.current) navigate('/result')
    } catch (err) {
      console.warn('GIF 任务提交失败', err)
      if (activeRef.current) showToast(err instanceof Error ? err.message : '动图提交失败，请稍后重试', 'error')
    } finally {
      busyRef.current = null
      if (activeRef.current) setBusy(null)
    }
  }

  return <section className="professional-editor">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-2xl font-bold tracking-tight text-[#292650]">AI 原生 GIF</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-[#817b9f]">写下你想看见的动作，让画面自己动起来。也可以上传一张参考图，生成可直接保存的 GIF 动图。</p></div>
      <span className="rounded-full border border-[#e4ddf8] bg-white px-3 py-1.5 text-xs font-semibold text-[#746e91]">单次生成 · 连贯动图</span>
    </div>
    {!profile && <p role="status" className="mt-5 rounded-2xl border border-[#e4ddf8] bg-[#f8f5ff] p-4 text-sm leading-6 text-[#746e91]">暂无可用的原生 GIF 渠道。请管理员在渠道管理中添加支持 GIF 的模型并启用「原生 GIF 动图」能力，再来这里创作。</p>}
    <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
      <div className="professional-panel min-w-0 p-4 sm:p-6">
        <ProfessionalStep step={1}>参考图 <span className="font-normal text-[#918cae]">· 可选</span></ProfessionalStep>
        <div tabIndex={0} aria-label="GIF 参考图粘贴区域" className="mt-4 rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#8c7cf7]" onPaste={(event) => pasteImages(event, async (files) => { await upload(files[0]) })}>
          <button type="button" aria-label="选择 GIF 参考图" disabled={Boolean(busy)} onClick={() => inputRef.current?.click()} className="relative flex aspect-square w-full flex-col items-center justify-center gap-4 overflow-hidden rounded-2xl border-2 border-dashed border-[#d6cff0] bg-gradient-to-br from-white to-[#f2edff] transition hover:border-[#8c7cf7] disabled:opacity-60">
            {image ? <img src={image.dataUrl} alt="GIF 参考图" className="h-full w-full object-contain p-3" /> : <><span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-white text-[#8c6cf5] shadow-lg shadow-violet-100"><IconUpload className="h-6 w-6" /></span><span className="text-sm font-semibold text-[#746e91]">{busy === 'restore' ? '正在恢复参考图…' : busy === 'upload' ? '正在读取图片…' : '上传一张参考图'}</span><span className="px-5 text-center text-xs leading-5 text-[#918cae]">人物、产品、小场景<br />让熟悉的画面，生动一点</span></>}
          </button>
          <input ref={inputRef} aria-label="上传 GIF 参考图" type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = '' }} />
          <div className="mt-3 flex flex-wrap items-center gap-2"><ImagePasteButton disabled={Boolean(busy)} label="粘贴参考图" upload={async (files) => { await upload(files[0]) }} />{(image || missingReference) && <button type="button" disabled={Boolean(busy)} onClick={() => { setImage(null); setMissingReference(false) }} className="flex min-h-11 items-center gap-1.5 rounded-xl border border-[#dfd8f6] bg-white px-3 text-xs text-[#817695] disabled:opacity-50"><IconTrash className="h-3.5 w-3.5" />移除参考图</button>}</div>
          <p className="mt-3 text-xs leading-6 text-[#918cae]">支持 PNG、JPG、WebP 静态参考图。不上传图片也能创作，选中此区域后可 Ctrl+V / ⌘V 粘贴。</p>
          {missingReference && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-xs leading-5 text-red-500">原参考图未能恢复，请重新上传，或移除参考图后使用文字生成。</p>}
        </div>
      </div>
      <fieldset disabled={Boolean(busy)} className="professional-panel min-w-0 space-y-5 p-4 sm:p-6">
        <ProfessionalStep step={2}>描述画面的动作</ProfessionalStep>
        <label className="block text-sm font-semibold text-[#423d63]">动作描述<textarea aria-label="GIF 动作描述" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} placeholder="例如：一只淡紫色蝴蝶轻轻扇动翅膀，停在花朵上，背景柔和，动作自然循环。" className="mt-2 w-full resize-y rounded-2xl border border-[#dfd8f6] bg-white p-4 text-sm font-normal leading-6 outline-none focus:border-[#8c7cf7] focus:ring-2 focus:ring-[#8c7cf7]/15" /></label>
        <label className="block text-sm font-semibold text-[#423d63]">生成渠道<select aria-label="GIF 生成渠道" disabled={!profiles.length} value={profile?.id ?? ''} onChange={(event) => setProfileId(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-[#dfd8f6] bg-white px-3 text-sm font-normal outline-none focus:border-[#8c7cf7]">{!profiles.length && <option value="">暂无支持原生 GIF 的渠道</option>}{profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <div className="grid grid-cols-2 gap-4">
          <label className="block text-sm font-semibold text-[#423d63]">动画帧数<select aria-label="GIF 动画帧数" value={frames} onChange={(event) => setFrames(Number(event.target.value))} className="mt-2 min-h-11 w-full rounded-xl border border-[#dfd8f6] bg-white px-3 text-sm font-normal outline-none focus:border-[#8c7cf7]">{Array.from({ length: 15 }, (_, i) => i + 2).map((value) => <option key={value} value={value}>{value} 帧</option>)}</select></label>
          <label className="block text-sm font-semibold text-[#423d63]">每帧停留<select aria-label="GIF 每帧时长" value={duration} onChange={(event) => setDuration(Number(event.target.value))} className="mt-2 min-h-11 w-full rounded-xl border border-[#dfd8f6] bg-white px-3 text-sm font-normal outline-none focus:border-[#8c7cf7]">{Array.from(new Set([20, 50, 100, 150, 200, 300, 500, 1000, 2000, duration])).sort((a, b) => a - b).map((value) => <option key={value} value={value}>{value} 毫秒</option>)}</select></label>
        </div>
        <label className="block text-sm font-semibold text-[#423d63]">画面尺寸<select aria-label="GIF 画面尺寸" value={size} onChange={(event) => setSize(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-[#dfd8f6] bg-white px-3 text-sm font-normal outline-none focus:border-[#8c7cf7]">{[{ value: 'auto', label: '自动 · 由模型选择' }, { value: '1024x1024', label: '方形 · 1024 × 1024' }, { value: '1536x1024', label: '横向 · 1536 × 1024' }, { value: '1024x1536', label: '竖向 · 1024 × 1536' }].map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <div className="rounded-2xl border border-[#e7e0f7] bg-[#f6f2ff] px-4 py-3 text-xs leading-6 text-[#817695]"><span className="font-semibold text-[#7352db]">{frames} 帧 · 单轮约 {Number((frames * duration / 1000).toFixed(2))} 秒</span><p>直接生成 GIF，完成后可预览与下载原始动图。消耗积分以所选渠道和实际结算为准。</p></div>
        <button type="button" onClick={() => void generate()} disabled={!profile || !prompt.trim() || Boolean(busy) || missingReference} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#8e68f4] to-[#b581ee] px-5 py-3 text-sm font-bold text-white shadow-lg shadow-violet-200/60 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"><IconSparkle className="h-4 w-4" />{busy === 'submit' ? '正在提交…' : '生成 GIF 动图'}<IconArrowRight className="h-4 w-4" /></button>
      </fieldset>
    </div>
  </section>
}
