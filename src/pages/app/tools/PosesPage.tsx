import { useCallback, useMemo, useState } from 'react'
import { assetUrl, poseImagePath, poseThumbPath } from '../../../lib/toolsGallery/assets'
import {
  ANGLES,
  isNsfwPose,
  isNsfwPoseSystem,
  loadPoses,
} from '../../../lib/toolsGallery/data'
import { useToolsRecipeStore } from '../../../lib/toolsGallery/recipeStore'
import type { PoseGroup, PoseItem } from '../../../lib/toolsGallery/types'
import {
  ErrorBlock, FilterChip, LoadingBlock, RecipeDock, SearchInput, useAsyncData,
} from './shared'
import GalleryShell from './shell'

const PAGE_SIZE = 48

export default function PosesPage() {
  const loader = useCallback(() => loadPoses(), [])
  const { data, error, loading } = useAsyncData(loader)
  const recipe = useToolsRecipeStore((s) => s.recipe)
  const togglePose = useToolsRecipeStore((s) => s.togglePose)
  const safeMode = useToolsRecipeStore((s) => s.safeMode)
  const requestUnlockNsfw = useToolsRecipeStore((s) => s.requestUnlockNsfw)
  const poseDepthMode = useToolsRecipeStore((s) => s.poseDepthMode)
  const setPoseDepthMode = useToolsRecipeStore((s) => s.setPoseDepthMode)

  const [query, setQuery] = useState('')
  const [line, setLine] = useState('')
  const [category, setCategory] = useState('')
  const [angle, setAngle] = useState('')
  const [groupMode, setGroupMode] = useState(true)
  const [page, setPage] = useState(0)
  const [preview, setPreview] = useState<PoseItem | null>(null)

  const filteredGroups = useMemo(() => {
    if (!data) return [] as PoseGroup[]
    const q = query.trim().toLowerCase()
    return data.groups.filter((g) => {
      if (safeMode && isNsfwPose(g)) return false
      if (line && g.system !== line) return false
      if (category && g.category !== category) return false
      if (angle && !g.angles[angle]) return false
      if (!q) return true
      return `${g.name} ${g.number} ${g.category} ${g.system}`.toLowerCase().includes(q)
        || g.items.some((i) => i.检索.toLowerCase().includes(q))
    })
  }, [data, query, line, category, angle, safeMode])

  const filteredItems = useMemo(() => {
    if (!data) return [] as PoseItem[]
    const q = query.trim().toLowerCase()
    return data.items.filter((item) => {
      if (safeMode && isNsfwPose(item)) return false
      if (line && item.体系 !== line) return false
      if (category && item.分类 !== category) return false
      if (angle && item.角度 !== angle) return false
      if (!q) return true
      return item.检索.toLowerCase().includes(q)
    })
  }, [data, query, line, category, angle, safeMode])

  const categories = useMemo(() => {
    if (!data) return [] as string[]
    const source = line ? data.items.filter((i) => i.体系 === line) : data.items
    return [...new Set(source.map((i) => i.分类))]
  }, [data, line])

  const hiddenNsfw = data ? data.items.filter((i) => isNsfwPose(i)).length : 0
  const list = groupMode ? filteredGroups : filteredItems
  const pageItems = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE))

  if (loading) return <GalleryShell title="动作姿势库"><LoadingBlock /></GalleryShell>
  if (error || !data) return <GalleryShell title="动作姿势库"><ErrorBlock message={error || '加载失败'} /></GalleryShell>

  return (
    <GalleryShell title="动作姿势库">
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-[#37335c]">动作姿势库</h2>
          <p className="mt-1 text-sm text-[#8b86ab]">
            {list.length.toLocaleString('zh-CN')} 项 · {groupMode ? '按姿势分组' : '逐张浏览'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <FilterChip active={!poseDepthMode} onClick={() => setPoseDepthMode(false)}>素体白模</FilterChip>
          <FilterChip active={poseDepthMode} onClick={() => setPoseDepthMode(true)}>深度图 Depth</FilterChip>
          <FilterChip active={groupMode} onClick={() => { setGroupMode(true); setPage(0) }}>分组</FilterChip>
          <FilterChip active={!groupMode} onClick={() => { setGroupMode(false); setPage(0) }}>逐张</FilterChip>
        </div>
      </div>

      <SearchInput value={query} onChange={(v) => { setQuery(v); setPage(0) }} placeholder="搜索姿势名 / 编号 / 分类…" />

      <div className="flex flex-wrap gap-2">
        <FilterChip active={!line} onClick={() => { setLine(''); setCategory(''); setPage(0) }}>全部体系</FilterChip>
        {data.lines.map((l) => {
          const nsfw = isNsfwPoseSystem(l)
          if (safeMode && nsfw) return null
          return (
            <FilterChip key={l} active={line === l} onClick={() => { setLine(l); setCategory(''); setPage(0) }}>
              {l}{nsfw ? ' · 18+' : ''}
            </FilterChip>
          )
        })}
        {safeMode && hiddenNsfw > 0 && (
          <button type="button" onClick={requestUnlockNsfw} className="text-xs font-medium text-[#6b5ce7]">
            显示被隐藏的 {hiddenNsfw} 张 18+
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip active={!category} onClick={() => { setCategory(''); setPage(0) }}>全部分类</FilterChip>
        {categories.map((c) => (
          <FilterChip key={c} active={category === c} onClick={() => { setCategory(c); setPage(0) }}>{c}</FilterChip>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip active={!angle} onClick={() => { setAngle(''); setPage(0) }}>全部视角</FilterChip>
        {ANGLES.map((a) => (
          <FilterChip key={a} active={angle === a} onClick={() => { setAngle(a); setPage(0) }}>{a}</FilterChip>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
        {groupMode
          ? (pageItems as PoseGroup[]).map((group) => {
              const main = (angle && group.angles[angle]) || group.order[0] || group.items[0]
              if (!main) return null
              const active = recipe.pose?.id === main.id || group.items.some((i) => i.id === recipe.pose?.id)
              return (
                <article key={group.key} className={`overflow-hidden rounded-2xl border bg-white shadow-sm transition ${active ? 'border-[#7c6cf6] ring-2 ring-[#7c6cf6]/20' : 'border-[#eceaf6]'}`}>
                  <button type="button" className="block w-full" onClick={() => setPreview(main)}>
                    <img
                      src={assetUrl(poseThumbPath(main, poseDepthMode))}
                      alt={group.name}
                      loading="lazy"
                      className="aspect-[3/4] w-full bg-[#f5f4fb] object-cover"
                    />
                  </button>
                  <div className="space-y-2 p-2.5">
                    <div className="line-clamp-2 text-xs font-medium text-[#37335c]">{group.name}</div>
                    <div className="text-[10px] text-[#b3aed0]">{group.number} · {group.category}</div>
                    <div className="flex flex-wrap gap-1">
                      {group.order.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          title={item.角度}
                          onClick={() => setPreview(item)}
                          className="h-8 w-6 overflow-hidden rounded border border-[#eceaf6]"
                        >
                          <img src={assetUrl(poseThumbPath(item, poseDepthMode))} alt={item.角度} className="h-full w-full object-cover" />
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => togglePose({ ...main, useDepth: poseDepthMode })}
                      className={`w-full rounded-lg py-1.5 text-xs font-semibold ${
                        active ? 'bg-[#7c6cf6] text-white' : 'bg-[#f5f4fb] text-[#6b5ce7] hover:bg-[#efedfd]'
                      }`}
                    >
                      {active ? '已加入配方' : '加入合成配方'}
                    </button>
                  </div>
                </article>
              )
            })
          : (pageItems as PoseItem[]).map((item) => {
              const active = recipe.pose?.id === item.id
              return (
                <article key={item.id} className={`overflow-hidden rounded-2xl border bg-white shadow-sm ${active ? 'border-[#7c6cf6] ring-2 ring-[#7c6cf6]/20' : 'border-[#eceaf6]'}`}>
                  <button type="button" className="block w-full" onClick={() => setPreview(item)}>
                    <img
                      src={assetUrl(poseThumbPath(item, poseDepthMode))}
                      alt={item.姿势名称}
                      loading="lazy"
                      className="aspect-[3/4] w-full object-cover"
                    />
                  </button>
                  <div className="space-y-1.5 p-2.5">
                    <div className="line-clamp-2 text-xs font-medium text-[#37335c]">{item.姿势名称}</div>
                    <div className="text-[10px] text-[#b3aed0]">{item.角度} · {item.分类}</div>
                    <button
                      type="button"
                      onClick={() => togglePose({ ...item, useDepth: poseDepthMode })}
                      className={`w-full rounded-lg py-1.5 text-xs font-semibold ${
                        active ? 'bg-[#7c6cf6] text-white' : 'bg-[#f5f4fb] text-[#6b5ce7]'
                      }`}
                    >
                      {active ? '已加入' : '加入配方'}
                    </button>
                  </div>
                </article>
              )
            })}
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <button type="button" disabled={page <= 0} onClick={() => setPage((p) => p - 1)} className="rounded-lg border border-[#eceaf6] bg-white px-3 py-1.5 text-xs disabled:opacity-40">上一页</button>
          <span className="text-xs text-[#8b86ab]">{page + 1} / {pageCount}</span>
          <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-[#eceaf6] bg-white px-3 py-1.5 text-xs disabled:opacity-40">下一页</button>
        </div>
      )}

      {preview && (
        <PoseLightbox
          item={preview}
          useDepth={poseDepthMode}
          active={recipe.pose?.id === preview.id}
          onClose={() => setPreview(null)}
          onToggle={() => togglePose({ ...preview, useDepth: poseDepthMode })}
        />
      )}

      <RecipeDock />
    </div>
    </GalleryShell>
  )
}

function PoseLightbox({
  item,
  useDepth,
  active,
  onClose,
  onToggle,
}: {
  item: PoseItem
  useDepth: boolean
  active: boolean
  onClose: () => void
  onToggle: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
        <img
          src={assetUrl(poseImagePath(item, useDepth))}
          alt={item.姿势名称}
          className="mx-auto max-h-[60vh] rounded-xl object-contain"
        />
        <div className="mt-3 text-sm font-semibold text-[#37335c]">{item.姿势名称}</div>
        <div className="mt-1 text-xs text-[#8b86ab]">{item.体系} · {item.分类} · {item.角度} · {item.姿势编号}</div>
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onToggle} className={`flex-1 rounded-xl py-2.5 text-sm font-semibold ${active ? 'bg-[#7c6cf6] text-white' : 'bg-[#efedfd] text-[#6b5ce7]'}`}>
            {active ? '移出配方' : '加入合成配方'}
          </button>
          <button type="button" onClick={onClose} className="rounded-xl border border-[#eceaf6] px-4 text-sm text-[#6f6a94]">关闭</button>
        </div>
      </div>
    </div>
  )
}
