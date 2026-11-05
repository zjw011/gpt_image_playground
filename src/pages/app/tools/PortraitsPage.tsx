import { useCallback, useMemo, useState } from 'react'
import { assetUrl } from '../../../lib/toolsGallery/assets'
import { loadPortraits } from '../../../lib/toolsGallery/data'
import { useToolsRecipeStore } from '../../../lib/toolsGallery/recipeStore'
import type { PortraitItem } from '../../../lib/toolsGallery/types'
import {
  ErrorBlock, FilterChip, LoadingBlock, RecipeDock, SearchInput, useAsyncData,
} from './shared'
import GalleryShell from './shell'

const PAGE_SIZE = 48

export default function PortraitsPage() {
  const loader = useCallback(() => loadPortraits(), [])
  const { data, error, loading } = useAsyncData(loader)
  const recipe = useToolsRecipeStore((s) => s.recipe)
  const togglePortrait = useToolsRecipeStore((s) => s.togglePortrait)

  const [query, setQuery] = useState('')
  const [zone, setZone] = useState('')
  const [hair, setHair] = useState('')
  const [onlyHot, setOnlyHot] = useState(false)
  const [onlyFeatured, setOnlyFeatured] = useState(false)
  const [page, setPage] = useState(0)
  const [preview, setPreview] = useState<PortraitItem | null>(null)

  const zones = useMemo(() => (data ? [...new Set(data.map((p) => p.分区))] : []), [data])
  const hairs = useMemo(() => (data ? [...new Set(data.map((p) => p.发长))] : []), [data])

  const filtered = useMemo(() => {
    if (!data) return [] as PortraitItem[]
    const q = query.trim().toLowerCase()
    return data.filter((item) => {
      if (zone && item.分区 !== zone) return false
      if (hair && item.发长 !== hair) return false
      if (onlyHot && !item.热门) return false
      if (onlyFeatured && !item.精选) return false
      if (!q) return true
      return item.检索.toLowerCase().includes(q)
    })
  }, [data, query, zone, hair, onlyHot, onlyFeatured])

  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))

  if (loading) return <GalleryShell title="人像颜值库"><LoadingBlock /></GalleryShell>
  if (error || !data) return <GalleryShell title="人像颜值库"><ErrorBlock message={error || '加载失败'} /></GalleryShell>

  return (
    <GalleryShell title="人像颜值库">
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-[#37335c]">人像颜值库</h2>
        <p className="mt-1 text-sm text-[#8b86ab]">{filtered.length.toLocaleString('zh-CN')} 张可用</p>
      </div>

      <SearchInput value={query} onChange={(v) => { setQuery(v); setPage(0) }} placeholder="搜索发型 / 标题 / ID…" />

      <div className="flex flex-wrap gap-2">
        <FilterChip active={!zone} onClick={() => { setZone(''); setPage(0) }}>全部分区</FilterChip>
        {zones.map((z) => (
          <FilterChip key={z} active={zone === z} onClick={() => { setZone(z); setPage(0) }}>{z}</FilterChip>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip active={!hair} onClick={() => { setHair(''); setPage(0) }}>全部发长</FilterChip>
        {hairs.map((h) => (
          <FilterChip key={h} active={hair === h} onClick={() => { setHair(h); setPage(0) }}>{h}</FilterChip>
        ))}
        <FilterChip active={onlyHot} onClick={() => { setOnlyHot(!onlyHot); setPage(0) }}>热门</FilterChip>
        <FilterChip active={onlyFeatured} onClick={() => { setOnlyFeatured(!onlyFeatured); setPage(0) }}>精选</FilterChip>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
        {pageItems.map((item) => {
          const active = recipe.portrait?.id === item.id
          return (
            <article key={item.id} className={`overflow-hidden rounded-2xl border bg-white shadow-sm ${active ? 'border-[#7c6cf6] ring-2 ring-[#7c6cf6]/20' : 'border-[#eceaf6]'}`}>
              <button type="button" className="block w-full" onClick={() => setPreview(item)}>
                <img src={assetUrl(item.缩略图)} alt={item.标题} loading="lazy" className="aspect-[3/4] w-full bg-[#f5f4fb] object-cover" />
              </button>
              <div className="space-y-1.5 p-2.5">
                <div className="line-clamp-2 text-xs font-medium text-[#37335c]">{item.标题}</div>
                <div className="text-[10px] text-[#b3aed0]">
                  {item.分区} · {item.发长}
                  {item.热门 ? ' · 热门' : ''}
                  {item.精选 ? ' · 精选' : ''}
                </div>
                <button
                  type="button"
                  onClick={() => togglePortrait(item)}
                  className={`w-full rounded-lg py-1.5 text-xs font-semibold ${active ? 'bg-[#7c6cf6] text-white' : 'bg-[#f5f4fb] text-[#6b5ce7]'}`}
                >
                  {active ? '已加入配方' : '加入合成配方'}
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setPreview(null)}>
          <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <img src={assetUrl(preview.原图 || preview.缩略图)} alt={preview.标题} className="mx-auto max-h-[60vh] rounded-xl object-contain" />
            <div className="mt-3 text-sm font-semibold text-[#37335c]">{preview.标题}</div>
            <div className="mt-1 text-xs text-[#8b86ab]">{preview.分区} · {preview.发长} · {preview.发型名称}</div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => togglePortrait(preview)}
                className={`flex-1 rounded-xl py-2.5 text-sm font-semibold ${recipe.portrait?.id === preview.id ? 'bg-[#7c6cf6] text-white' : 'bg-[#efedfd] text-[#6b5ce7]'}`}
              >
                {recipe.portrait?.id === preview.id ? '移出配方' : '加入合成配方'}
              </button>
              <button type="button" onClick={() => setPreview(null)} className="rounded-xl border border-[#eceaf6] px-4 text-sm text-[#6f6a94]">关闭</button>
            </div>
          </div>
        </div>
      )}

      <RecipeDock />
    </div>
    </GalleryShell>
  )
}
