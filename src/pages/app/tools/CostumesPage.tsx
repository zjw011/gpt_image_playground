import { useCallback, useMemo, useState } from 'react'
import { assetUrl } from '../../../lib/toolsGallery/assets'
import {
  costumeSourceId,
  isNsfwCostume,
  isNsfwCostumeCategory,
  loadCostumes,
  selectCostumeView,
} from '../../../lib/toolsGallery/data'
import { useToolsRecipeStore } from '../../../lib/toolsGallery/recipeStore'
import type { CostumeItem } from '../../../lib/toolsGallery/types'
import {
  ErrorBlock, FilterChip, LoadingBlock, RecipeDock, SearchInput, useAsyncData,
} from './shared'
import GalleryShell from './shell'

const PAGE_SIZE = 48
const SOURCES = [
  { id: 'all', label: '全部来源' },
  { id: 'gia', label: '写实' },
  { id: 'gia-anime', label: '动漫' },
  { id: 'charadb', label: '二次元 CharaDB' },
  { id: 'shisei', label: '中国历代' },
] as const

export default function CostumesPage() {
  const loader = useCallback(() => loadCostumes(), [])
  const { data, error, loading } = useAsyncData(loader)
  const recipe = useToolsRecipeStore((s) => s.recipe)
  const toggleCostume = useToolsRecipeStore((s) => s.toggleCostume)
  const safeMode = useToolsRecipeStore((s) => s.safeMode)
  const requestUnlockNsfw = useToolsRecipeStore((s) => s.requestUnlockNsfw)

  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'全部' | '现实' | '二次元'>('全部')
  const [source, setSource] = useState('all')
  const [category, setCategory] = useState('')
  const [page, setPage] = useState(0)
  const [preview, setPreview] = useState<CostumeItem | null>(null)

  const filtered = useMemo(() => {
    if (!data) return [] as CostumeItem[]
    const q = query.trim().toLowerCase()
    return data.filter((item) => {
      if (safeMode && isNsfwCostume(item)) return false
      if (source !== 'all' && costumeSourceId(item) !== source) return false
      if (kind !== '全部' && (item.一级分类 || '现实') !== kind) return false
      if (category && item.分类 !== category) return false
      if (!q) return true
      return item.检索.toLowerCase().includes(q)
    })
  }, [data, query, kind, source, category, safeMode])

  const categories = useMemo(() => {
    if (!data) return [] as string[]
    const base = data.filter((item) => {
      if (source !== 'all' && costumeSourceId(item) !== source) return false
      if (kind !== '全部' && (item.一级分类 || '现实') !== kind) return false
      return true
    })
    return [...new Set(base.map((i) => i.分类))]
  }, [data, source, kind])

  const hiddenNsfw = data ? data.filter((i) => isNsfwCostume(i)).length : 0
  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))

  if (loading) return <GalleryShell title="服装穿搭库"><LoadingBlock /></GalleryShell>
  if (error || !data) return <GalleryShell title="服装穿搭库"><ErrorBlock message={error || '加载失败'} /></GalleryShell>

  return (
    <GalleryShell title="服装穿搭库">
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-[#37335c]">服装穿搭库</h2>
        <p className="mt-1 text-sm text-[#8b86ab]">{filtered.length.toLocaleString('zh-CN')} 套可用</p>
      </div>

      <SearchInput value={query} onChange={(v) => { setQuery(v); setPage(0) }} placeholder="搜索服装名 / 标签 / 关键词…" />

      <div className="flex flex-wrap gap-2">
        {SOURCES.map((s) => (
          <FilterChip key={s.id} active={source === s.id} onClick={() => { setSource(s.id); setCategory(''); setPage(0) }}>
            {s.label}
          </FilterChip>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {(['全部', '现实', '二次元'] as const).map((k) => (
          <FilterChip key={k} active={kind === k} onClick={() => { setKind(k); setCategory(''); setPage(0) }}>{k}</FilterChip>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip active={!category} onClick={() => { setCategory(''); setPage(0) }}>全部分类</FilterChip>
        {categories.map((c) => {
          const nsfw = isNsfwCostumeCategory(c)
          if (safeMode && nsfw) return null
          return (
            <FilterChip key={c} active={category === c} onClick={() => { setCategory(c); setPage(0) }}>
              {c}{nsfw ? ' · 18+' : ''}
            </FilterChip>
          )
        })}
        {safeMode && hiddenNsfw > 0 && (
          <button type="button" onClick={requestUnlockNsfw} className="text-xs font-medium text-[#6b5ce7]">
            显示被隐藏的 {hiddenNsfw} 套 18+
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
        {pageItems.map((raw) => {
          const item = selectCostumeView(raw)
          const active = recipe.costume?.id === item.id
          return (
            <article key={item.id} className={`overflow-hidden rounded-2xl border bg-white shadow-sm ${active ? 'border-[#7c6cf6] ring-2 ring-[#7c6cf6]/20' : 'border-[#eceaf6]'}`}>
              <button type="button" className="block w-full" onClick={() => setPreview(item)}>
                <img src={assetUrl(item.缩略图)} alt={item.服装名称} loading="lazy" className="aspect-[3/4] w-full bg-[#f5f4fb] object-cover" />
              </button>
              <div className="space-y-1.5 p-2.5">
                <div className="line-clamp-2 text-xs font-medium text-[#37335c]">{item.服装名称}</div>
                <div className="text-[10px] text-[#b3aed0]">{item.分类} · {item.一级分类 || '现实'}</div>
                {item.views && item.views.length > 1 && (
                  <div className="flex flex-wrap gap-1">
                    {item.views.map((view) => (
                      <button
                        key={view.id}
                        type="button"
                        onClick={() => setPreview(selectCostumeView(item, view.id))}
                        className="rounded border border-[#eceaf6] px-1.5 py-0.5 text-[10px] text-[#6f6a94]"
                      >
                        {view.label}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => toggleCostume(item)}
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
            <img src={assetUrl(preview.原图 || preview.预览图 || preview.缩略图)} alt={preview.服装名称} className="mx-auto max-h-[60vh] rounded-xl object-contain" />
            <div className="mt-3 text-sm font-semibold text-[#37335c]">{preview.服装名称}</div>
            <div className="mt-1 text-xs text-[#8b86ab]">{preview.分类} · {preview.来源 || costumeSourceId(preview)}</div>
            {preview.标签?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {preview.标签.slice(0, 12).map((tag) => (
                  <span key={tag} className="rounded-full bg-[#f5f4fb] px-2 py-0.5 text-[10px] text-[#6f6a94]">{tag}</span>
                ))}
              </div>
            )}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => toggleCostume(preview)}
                className={`flex-1 rounded-xl py-2.5 text-sm font-semibold ${recipe.costume?.id === preview.id ? 'bg-[#7c6cf6] text-white' : 'bg-[#efedfd] text-[#6b5ce7]'}`}
              >
                {recipe.costume?.id === preview.id ? '移出配方' : '加入合成配方'}
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
