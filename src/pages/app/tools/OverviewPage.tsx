import { useCallback } from 'react'
import { Link } from 'react-router-dom'
import { assetUrl } from '../../../lib/toolsGallery/assets'
import { loadCostumes, loadPortraits, loadPoses } from '../../../lib/toolsGallery/data'
import { useToolsRecipeStore } from '../../../lib/toolsGallery/recipeStore'
import { ErrorBlock, LoadingBlock, RecipeDock, useAsyncData } from './shared'
import GalleryShell from './shell'
import { IconArrowRight, IconLayers, IconSparkle, IconUser } from '../../icons'

export default function OverviewPage() {
  const loader = useCallback(async () => {
    const [poses, costumes, portraits] = await Promise.all([loadPoses(), loadCostumes(), loadPortraits()])
    return { poses, costumes, portraits }
  }, [])
  const { data, error, loading } = useAsyncData(loader)
  const togglePortrait = useToolsRecipeStore((s) => s.togglePortrait)
  const recipe = useToolsRecipeStore((s) => s.recipe)

  if (loading) return <GalleryShell title="图库总览"><LoadingBlock /></GalleryShell>
  if (error || !data) return <GalleryShell title="图库总览"><ErrorBlock message={error || '加载失败'} /></GalleryShell>

  const { poses, costumes, portraits } = data
  const total = poses.items.length + costumes.length + portraits.length
  const hotPortraits = portraits.filter((p) => p.热门).slice(0, 10)

  return (
    <GalleryShell title="图库总览">
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-[#37335c]">AI 角色参考库</h2>
        <p className="mt-1 text-sm text-[#8b86ab]">姿势 · 服装 · 人像三库合一，选好配方后用绘想渠道生图并扣积分。</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard title="总参考图" value={total.toLocaleString('zh-CN')} desc="索引本地，图片走 CDN" />
        <StatCard title="动作姿势" value={`${poses.groups.length} 组`} desc={`${poses.items.length} 张 · 白模/深度`} />
        <StatCard title="服装穿搭" value={costumes.length.toLocaleString('zh-CN')} desc="现实 + 二次元 + 历代" />
        <StatCard title="人像颜值" value={portraits.length.toLocaleString('zh-CN')} desc="正脸 / 造型氛围" />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <GalleryEntry
          to="/poses"
          title="动作姿势库"
          count={poses.items.length}
          thumbs={poses.groups.slice(0, 4).map((g) => g.order[0]?.缩略图).filter(Boolean)}
        />
        <GalleryEntry
          to="/costumes"
          title="服装穿搭库"
          count={costumes.length}
          thumbs={costumes.slice(0, 4).map((c) => c.缩略图)}
        />
        <GalleryEntry
          to="/portraits"
          title="人像颜值库"
          count={portraits.length}
          thumbs={portraits.slice(0, 4).map((p) => p.缩略图)}
        />
      </div>

      <Link
        to="/compose"
        className="flex items-center justify-between rounded-2xl border border-[#cdc7ee] bg-gradient-to-r from-[#efedfd] to-[#e3f0ff] px-5 py-4 transition hover:shadow-md"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#7c6cf6] to-[#a78bfa] text-white">
            <IconSparkle className="h-5 w-5" />
          </span>
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-[#37335c]">
              AI 角色合成台
              <span className="rounded-md bg-[#7c6cf6] px-1.5 py-0.5 text-[10px] font-bold text-white">PRO</span>
            </div>
            <p className="text-xs text-[#8b86ab]">人像 + 服装 + 姿势配方 → 走绘想 API 生图</p>
          </div>
        </div>
        <IconArrowRight className="h-5 w-5 text-[#7c6cf6]" />
      </Link>

      <section className="rounded-2xl border border-[#eceaf6] bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-[#37335c]">
            <IconUser className="h-4 w-4 text-orange-500" />
            热门人像 Top 10 · 点击加入配方
          </h3>
          <Link to="/portraits" className="text-xs font-medium text-[#6b5ce7]">全部</Link>
        </div>
        <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
          {hotPortraits.map((p) => {
            const active = recipe.portrait?.id === p.id
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => togglePortrait(p)}
                className={`overflow-hidden rounded-xl border-2 transition ${
                  active ? 'border-[#7c6cf6] ring-2 ring-[#7c6cf6]/20' : 'border-transparent hover:border-[#cdc7ee]'
                }`}
                title={p.标题}
              >
                <img src={assetUrl(p.缩略图)} alt={p.标题} loading="lazy" className="aspect-[3/4] w-full object-cover" />
              </button>
            )
          })}
        </div>
      </section>

      <RecipeDock />
    </div>
    </GalleryShell>
  )
}

function StatCard({ title, value, desc }: { title: string; value: string; desc: string }) {
  return (
    <div className="rounded-2xl border border-[#eceaf6] bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-xs font-medium text-[#8b86ab]">
        <IconLayers className="h-3.5 w-3.5" />
        {title}
      </div>
      <div className="mt-2 text-2xl font-bold text-[#37335c]">{value}</div>
      <div className="mt-1 text-[11px] text-[#b3aed0]">{desc}</div>
    </div>
  )
}

function GalleryEntry({
  to,
  title,
  count,
  thumbs,
}: {
  to: string
  title: string
  count: number
  thumbs: string[]
}) {
  return (
    <Link to={to} className="group rounded-2xl border border-[#eceaf6] bg-white p-4 shadow-sm transition hover:border-[#cdc7ee] hover:shadow-md">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[#37335c]">{title}</h3>
        <span className="rounded-full bg-[#f5f4fb] px-2 py-0.5 text-[11px] font-medium text-[#6f6a94]">
          {count.toLocaleString('zh-CN')}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-1.5">
        {thumbs.map((src, idx) => (
          <img
            key={`${src}-${idx}`}
            src={assetUrl(src)}
            alt=""
            loading="lazy"
            className="aspect-[3/4] w-full rounded-lg bg-[#f5f4fb] object-cover transition group-hover:scale-[1.02]"
          />
        ))}
      </div>
    </Link>
  )
}
