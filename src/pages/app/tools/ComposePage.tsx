import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { assetUrl, createInputImageFromAsset, costumeImagePath, poseImagePath, poseThumbPath } from '../../../lib/toolsGallery/assets'
import { loadCostumes, loadPortraits, loadPoses } from '../../../lib/toolsGallery/data'
import { STYLE_PRESETS, buildRecipePrompt } from '../../../lib/toolsGallery/prompt'
import { useToolsRecipeStore } from '../../../lib/toolsGallery/recipeStore'
import { getCreditsConfig } from '../../../lib/backend'
import { useCreditsStore } from '../../../lib/creditsStore'
import { useStore, submitTask } from '../../../store'
import type { InputImage } from '../../../types'
import { ErrorBlock, LoadingBlock, useAsyncData } from './shared'
import GalleryShell from './shell'
import { IconSparkle, IconTrash, IconUpload, IconRefresh } from '../../icons'

export default function ComposePage() {
  const navigate = useNavigate()
  const loader = useCallback(async () => {
    const [poses, costumes, portraits] = await Promise.all([loadPoses(), loadCostumes(), loadPortraits()])
    return { poses, costumes, portraits }
  }, [])
  const { data, error, loading } = useAsyncData(loader)

  const recipe = useToolsRecipeStore((s) => s.recipe)
  const stylePreset = useToolsRecipeStore((s) => s.stylePreset)
  const setStylePreset = useToolsRecipeStore((s) => s.setStylePreset)
  const clearSlot = useToolsRecipeStore((s) => s.clearSlot)
  const clearRecipe = useToolsRecipeStore((s) => s.clearRecipe)
  const randomFill = useToolsRecipeStore((s) => s.randomFill)
  const addExtraImage = useToolsRecipeStore((s) => s.addExtraImage)
  const removeExtraImage = useToolsRecipeStore((s) => s.removeExtraImage)
  const poseDepthMode = useToolsRecipeStore((s) => s.poseDepthMode)

  const showToast = useStore((s) => s.showToast)
  const setPrompt = useStore((s) => s.setPrompt)
  const setInputImages = useStore((s) => s.setInputImages)
  const clearMaskDraft = useStore((s) => s.clearMaskDraft)
  const setParams = useStore((s) => s.setParams)
  const params = useStore((s) => s.params)

  const credits = getCreditsConfig()
  const view = useCreditsStore((s) => s.view)
  const [customPrompt, setCustomPrompt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const autoPrompt = useMemo(
    () => buildRecipePrompt(recipe, stylePreset),
    [recipe, stylePreset],
  )
  const prompt = customPrompt ?? autoPrompt
  const slotCount = [recipe.portrait, recipe.costume, recipe.pose].filter(Boolean).length
  const refCount = slotCount + (recipe.extraImages?.length || 0)
  const cost = credits ? credits.costPerImage * Math.max(1, params.n || 1) : 0

  const onRandom = () => {
    if (!data) return
    setCustomPrompt(null)
    randomFill({
      portraits: data.portraits,
      costumes: data.costumes,
      poses: data.poses.items,
    })
    showToast('已随机抽取一套角色配方', 'success')
  }

  const onPickExtra = async (files: FileList | null) => {
    if (!files?.length) return
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('读取失败'))
        reader.readAsDataURL(file)
      })
      addExtraImage({ id: crypto.randomUUID(), name: file.name, url: dataUrl })
    }
  }

  const generate = async () => {
    if (refCount === 0) {
      showToast('先至少选一个人像 / 服装 / 姿势，或上传附加参考图', 'error')
      return
    }
    if (!prompt.trim() || prompt.includes('请先选择')) {
      showToast('提示词无效，请完善配方', 'error')
      return
    }
    if (credits && (view?.available ?? 0) < cost) {
      showToast(`积分不足，本次约需 ${cost} 积分`, 'error')
      navigate('/recharge')
      return
    }

    setBusy(true)
    try {
      const images: InputImage[] = []
      if (recipe.portrait) {
        images.push(await createInputImageFromAsset(recipe.portrait.原图 || recipe.portrait.缩略图))
      }
      if (recipe.costume) {
        images.push(await createInputImageFromAsset(costumeImagePath(recipe.costume, true)))
      }
      if (recipe.pose) {
        images.push(await createInputImageFromAsset(poseImagePath(recipe.pose, Boolean(recipe.pose.useDepth ?? poseDepthMode))))
      }
      for (const extra of recipe.extraImages || []) {
        images.push(await createInputImageFromAsset(extra.url))
      }

      clearMaskDraft()
      setInputImages(images)
      setPrompt(prompt)
      // 多参考图编辑：尺寸交给模型 / 渠道默认，用户可在下方改数量
      const ok = await submitTask()
      if (!ok) return
      showToast(credits ? `已提交生图，成功出图将扣 ${cost} 积分` : '已提交生图', 'success')
      navigate('/result')
    } catch (err) {
      console.error(err)
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <GalleryShell title="AI 角色合成台"><LoadingBlock label="加载合成台…" /></GalleryShell>
  if (error) return <GalleryShell title="AI 角色合成台"><ErrorBlock message={error} /></GalleryShell>

  return (
    <GalleryShell title="AI 角色合成台">
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-[#37335c]">
            AI 角色合成台
            <span className="rounded-md bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] px-1.5 py-0.5 text-[10px] font-bold text-white">PRO</span>
          </h2>
          <p className="mt-1 text-sm text-[#8b86ab]">
            选好人像 / 服装 / 姿势后，走绘想当前渠道生图{credits ? '，成功出图扣积分' : ''}。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onRandom} className="inline-flex items-center gap-1.5 rounded-full border border-[#eceaf6] bg-white px-3.5 py-2 text-xs font-medium text-[#6f6a94] hover:border-[#cdc7ee]">
            <IconRefresh className="h-3.5 w-3.5" />
            随机捏人
          </button>
          <button type="button" onClick={() => { clearRecipe(); setCustomPrompt(null) }} className="inline-flex items-center gap-1.5 rounded-full border border-[#eceaf6] bg-white px-3.5 py-2 text-xs font-medium text-[#6f6a94]">
            <IconTrash className="h-3.5 w-3.5" />
            清空配方
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <SlotCard
          title="人像"
          emptyHint="去人像库挑选"
          to="/portraits"
          thumb={recipe.portrait?.缩略图}
          caption={recipe.portrait?.标题}
          onClear={() => clearSlot('portrait')}
        />
        <SlotCard
          title="服装"
          emptyHint="去服装库挑选"
          to="/costumes"
          thumb={recipe.costume?.缩略图}
          caption={recipe.costume?.服装名称}
          onClear={() => clearSlot('costume')}
        />
        <SlotCard
          title="姿势"
          emptyHint="去姿势库挑选"
          to="/poses"
          thumb={recipe.pose ? poseThumbPath(recipe.pose, Boolean(recipe.pose.useDepth ?? poseDepthMode)) : undefined}
          caption={recipe.pose ? `${recipe.pose.姿势名称} · ${recipe.pose.角度}` : undefined}
          onClear={() => clearSlot('pose')}
        />
      </div>

      <section className="rounded-2xl border border-[#eceaf6] bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[#37335c]">附加参考图</h3>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-[#f5f4fb] px-3 py-1.5 text-xs font-medium text-[#6b5ce7]">
            <IconUpload className="h-3.5 w-3.5" />
            上传
            <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => void onPickExtra(e.target.files)} />
          </label>
        </div>
        {(recipe.extraImages?.length || 0) === 0 ? (
          <p className="text-xs text-[#b3aed0]">可选。支持拖入设定集、道具、背景等补充参考。</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {recipe.extraImages!.map((img) => (
              <div key={img.id} className="relative">
                <img src={img.url} alt={img.name} className="h-20 w-16 rounded-lg object-cover" />
                <button
                  type="button"
                  onClick={() => removeExtraImage(img.id)}
                  className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-[#37335c] text-[10px] text-white"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-[#eceaf6] bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold text-[#37335c]">画风预设</h3>
        <div className="flex flex-wrap gap-2">
          {Object.entries(STYLE_PRESETS).map(([key, info]) => (
            <button
              key={key}
              type="button"
              onClick={() => { setStylePreset(key); setCustomPrompt(null) }}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                stylePreset === key
                  ? 'bg-[#7c6cf6] text-white'
                  : 'border border-[#eceaf6] bg-white text-[#6f6a94] hover:border-[#cdc7ee]'
              }`}
            >
              {info.label}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-[#eceaf6] bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[#37335c]">结构化提示词</h3>
          {customPrompt !== null && (
            <button type="button" onClick={() => setCustomPrompt(null)} className="text-xs text-[#6b5ce7]">恢复自动组装</button>
          )}
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          rows={10}
          className="w-full resize-y rounded-xl border border-[#e4e1f2] bg-[#faf9fe] px-3.5 py-3 text-sm leading-6 text-[#37335c] outline-none focus:border-[#7c6cf6] focus:bg-white focus:ring-4 focus:ring-[#7c6cf6]/10"
        />
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#eceaf6] bg-white p-4">
        <div className="flex flex-wrap items-center gap-3 text-sm text-[#6f6a94]">
          <label className="flex items-center gap-2">
            数量
            <select
              value={params.n}
              onChange={(e) => setParams({ n: Number(e.target.value) })}
              className="rounded-lg border border-[#eceaf6] bg-[#faf9fe] px-2 py-1.5 text-sm"
            >
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <span>参考图 {refCount} 张</span>
          {credits && <span>预计扣积分 {cost}</span>}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void generate()}
          className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-[#7c6cf6]/25 disabled:opacity-60"
        >
          <IconSparkle className="h-4 w-4" />
          {busy ? '准备参考图…' : '用绘想生图'}
        </button>
      </section>
    </div>
    </GalleryShell>
  )
}

function SlotCard({
  title,
  emptyHint,
  to,
  thumb,
  caption,
  onClear,
}: {
  title: string
  emptyHint: string
  to: string
  thumb?: string
  caption?: string
  onClear: () => void
}) {
  const src = thumb ? assetUrl(thumb) : ''
  return (
    <div className="rounded-2xl border border-[#eceaf6] bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[#37335c]">{title}</h3>
        {src ? (
          <button type="button" onClick={onClear} className="text-xs text-[#a5a1c4] hover:text-[#6b5ce7]">移除</button>
        ) : (
          <Link to={to} className="text-xs font-medium text-[#6b5ce7]">{emptyHint}</Link>
        )}
      </div>
      {src ? (
        <div>
          <img src={src} alt={caption || title} className="aspect-[3/4] w-full rounded-xl object-cover" />
          <p className="mt-2 line-clamp-2 text-xs text-[#6f6a94]">{caption}</p>
        </div>
      ) : (
        <Link
          to={to}
          className="flex aspect-[3/4] items-center justify-center rounded-xl border border-dashed border-[#ddd8f0] bg-[#faf9fe] text-xs text-[#b3aed0]"
        >
          点击去挑选
        </Link>
      )}
    </div>
  )
}
