import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { assetUrl, poseThumbPath } from '../../../lib/toolsGallery/assets'
import { loadCostumes, loadPortraits, loadPoses } from '../../../lib/toolsGallery/data'
import { buildRecipePrompt } from '../../../lib/toolsGallery/prompt'
import { useToolsRecipeStore } from '../../../lib/toolsGallery/recipeStore'
import { useStore } from '../../../store'
import { IconCopy, IconDice, IconPose, IconShirt, IconSparkle, IconTrash, IconUser } from '../../icons'

export function useAsyncData<T>(loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loader()
      .then((value) => {
        if (!cancelled) {
          setData(value)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loader])

  return { data, error, loading }
}

export function LoadingBlock({ label = '加载图库数据…' }: { label?: string }) {
  return (
    <div className="flex min-h-[320px] items-center justify-center rounded-2xl border border-dashed border-[#ddd8f0] bg-white text-sm text-[#a5a1c4]">
      {label}
    </div>
  )
}

export function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-700">
      {message}
    </div>
  )
}

/** 图库页底部配方条：三卡槽（空槽跳转对应图库）+ 随机 / 复制词 / 清空 / 合成 */
export function RecipeDock() {
  const recipe = useToolsRecipeStore((s) => s.recipe)
  const stylePreset = useToolsRecipeStore((s) => s.stylePreset)
  const poseDepthMode = useToolsRecipeStore((s) => s.poseDepthMode)
  const clearSlot = useToolsRecipeStore((s) => s.clearSlot)
  const clearRecipe = useToolsRecipeStore((s) => s.clearRecipe)
  const randomFill = useToolsRecipeStore((s) => s.randomFill)
  const showToast = useStore((s) => s.showToast)
  const [randomBusy, setRandomBusy] = useState(false)

  const count = [recipe.portrait, recipe.costume, recipe.pose].filter(Boolean).length
  const loadPools = useCallback(async () => {
    const [portraits, costumes, poses] = await Promise.all([loadPortraits(), loadCostumes(), loadPoses()])
    return { portraits, costumes, poses: poses.items }
  }, [])

  const onRandom = async () => {
    setRandomBusy(true)
    try {
      const pools = await loadPools()
      randomFill(pools)
      showToast('已随机抽取一套角色配方', 'success')
    } catch (err) {
      console.error(err)
      showToast(err instanceof Error ? err.message : '随机失败', 'error')
    } finally {
      setRandomBusy(false)
    }
  }

  const onCopyPrompt = async () => {
    if (count === 0) {
      showToast('先选人像 / 服装 / 姿势，或点随机', 'error')
      return
    }
    const text = buildRecipePrompt(recipe, stylePreset)
    try {
      await navigator.clipboard.writeText(text)
      showToast('已复制结构化提示词', 'success')
    } catch {
      showToast('复制失败，请检查浏览器剪贴板权限', 'error')
    }
  }

  return (
    <div className="sticky bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-20 mx-auto mt-6 flex max-w-4xl flex-wrap items-center gap-2 rounded-2xl border border-[#d9d4ef] bg-white/95 px-3 py-2.5 shadow-[0_12px_40px_rgba(55,51,92,0.12)] backdrop-blur md:bottom-4 md:gap-3 md:px-4 md:py-3">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 overflow-x-auto">
        {recipe.portrait ? (
          <DockChip
            src={recipe.portrait.缩略图}
            title={recipe.portrait.标题 || recipe.portrait.发型名称}
            onClear={() => clearSlot('portrait')}
          />
        ) : (
          <EmptySlot to="/portraits" label="人像" icon={IconUser} />
        )}
        {recipe.costume ? (
          <DockChip
            src={recipe.costume.缩略图}
            title={[recipe.costume.服装名称, recipe.costume.标签?.[0]].filter(Boolean).join(' · ')}
            onClear={() => clearSlot('costume')}
          />
        ) : (
          <EmptySlot to="/costumes" label="服装" icon={IconShirt} />
        )}
        {recipe.pose ? (
          <DockChip
            src={poseThumbPath(recipe.pose, Boolean(recipe.pose.useDepth ?? poseDepthMode))}
            title={recipe.pose.姿势名称}
            hint={recipe.pose.useDepth ?? poseDepthMode ? '白模 / 深度' : '白模'}
            onClear={() => clearSlot('pose')}
          />
        ) : (
          <EmptySlot to="/poses" label="姿势" icon={IconPose} />
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
        <button
          type="button"
          disabled={randomBusy}
          onClick={() => void onRandom()}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-[#eceaf6] bg-white px-2.5 text-xs font-medium text-[#5b5680] transition hover:border-[#cdc7ee] hover:text-[#37335c] disabled:opacity-60 sm:px-3"
        >
          <IconDice className="h-3.5 w-3.5" />
          随机
        </button>
        {count > 0 && (
          <>
            <button
              type="button"
              onClick={() => void onCopyPrompt()}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-[#eceaf6] bg-white px-2.5 text-xs font-medium text-[#5b5680] transition hover:border-[#cdc7ee] hover:text-[#37335c] sm:px-3"
            >
              <IconCopy className="h-3.5 w-3.5" />
              复制词
            </button>
            <button
              type="button"
              onClick={() => {
                clearRecipe()
                showToast('已清空配方', 'success')
              }}
              aria-label="清空配方"
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[#eceaf6] bg-white text-[#8b86ab] transition hover:border-[#cdc7ee] hover:text-[#37335c]"
            >
              <IconTrash className="h-3.5 w-3.5" />
            </button>
          </>
        )}
        <Link
          to="/compose"
          className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[#1f1b2e] px-3 text-xs font-semibold text-white transition hover:bg-[#2d2740] sm:px-3.5"
        >
          <IconSparkle className="h-3.5 w-3.5" />
          合成 ({count})
        </Link>
      </div>
    </div>
  )
}

function EmptySlot({
  to,
  label,
  icon: Icon,
}: {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
}) {
  return (
    <Link
      to={to}
      className="inline-flex h-11 items-center gap-2 rounded-xl border border-dashed border-[#ddd8f0] bg-[#f7f6fc] px-2.5 text-[#8b86ab] transition hover:border-[#cdc7ee] hover:bg-[#f0eefb] hover:text-[#6b5ce7]"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-[#a5a1c4] shadow-sm">
        <Icon className="h-4 w-4" />
      </span>
      <span className="pr-1 text-xs font-medium">{label}</span>
    </Link>
  )
}

function DockChip({
  src,
  title,
  hint,
  onClear,
}: {
  src: string
  title: string
  hint?: string
  onClear: () => void
}) {
  return (
    <div className="flex max-w-[11.5rem] items-center gap-2 rounded-xl border border-[#eceaf6] bg-[#faf9fe] py-1.5 pl-1.5 pr-2 sm:max-w-[14rem]">
      <img src={assetUrl(src)} alt="" className="h-10 w-8 shrink-0 rounded-lg object-cover" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-medium leading-4 text-[#37335c]">{title}</p>
        {hint && <p className="truncate text-[10px] leading-3.5 text-[#a5a1c4]">{hint}</p>}
      </div>
      <button
        type="button"
        onClick={onClear}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[#a5a1c4] transition hover:bg-[#eceaf6] hover:text-[#37335c]"
        aria-label={`移除 ${title}`}
      >
        ×
      </button>
    </div>
  )
}

export function FilterChip({
  active,
  children,
  onClick,
}: {
  active?: boolean
  children: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
        active
          ? 'bg-[#7c6cf6] text-white shadow-sm shadow-[#7c6cf6]/25'
          : 'bg-white text-[#6f6a94] border border-[#eceaf6] hover:border-[#cdc7ee] hover:text-[#6b5ce7]'
      }`}
    >
      {children}
    </button>
  )
}

export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-xl border border-[#e4e1f2] bg-[#faf9fe] px-3.5 py-2.5 text-sm text-[#37335c] outline-none transition placeholder:text-[#a5a1c4] focus:border-[#7c6cf6] focus:bg-white focus:ring-4 focus:ring-[#7c6cf6]/10"
    />
  )
}
