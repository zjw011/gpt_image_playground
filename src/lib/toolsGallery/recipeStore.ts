import { create } from 'zustand'
import { useStore } from '../../store'
import { isNsfwCostume, isNsfwPose } from './data'
import type { CostumeItem, ExtraReferenceImage, PortraitItem, PoseItem, RecipeState } from './types'

const RECIPE_KEY = 'huixiang_tools_recipe_v1'
const SAFE_MODE_KEY = 'huixiang_tools_safe_mode_v1'
const STYLE_KEY = 'huixiang_tools_style_v1'
const DEPTH_KEY = 'huixiang_tools_pose_depth_v1'

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

interface ToolsRecipeState {
  recipe: RecipeState
  safeMode: boolean
  poseDepthMode: boolean
  stylePreset: string
  setSafeMode: (v: boolean) => void
  requestUnlockNsfw: () => void
  setPoseDepthMode: (v: boolean) => void
  setStylePreset: (v: string) => void
  togglePortrait: (item: PortraitItem) => void
  toggleCostume: (item: CostumeItem) => void
  togglePose: (item: PoseItem) => void
  clearSlot: (slot: 'portrait' | 'costume' | 'pose') => void
  clearRecipe: () => void
  setExtraImages: (images: ExtraReferenceImage[]) => void
  addExtraImage: (image: ExtraReferenceImage) => void
  removeExtraImage: (id: string) => void
  randomFill: (pools: { portraits: PortraitItem[]; costumes: CostumeItem[]; poses: PoseItem[] }) => void
}

const emptyRecipe: RecipeState = { portrait: null, costume: null, pose: null, extraImages: [] }

export const useToolsRecipeStore = create<ToolsRecipeState>((set, get) => ({
  recipe: loadJson(RECIPE_KEY, emptyRecipe),
  safeMode: localStorage.getItem(SAFE_MODE_KEY) !== 'false',
  poseDepthMode: localStorage.getItem(DEPTH_KEY) === 'true',
  stylePreset: localStorage.getItem(STYLE_KEY) || 'realistic',

  setSafeMode: (safeMode) => {
    localStorage.setItem(SAFE_MODE_KEY, String(safeMode))
    if (safeMode) {
      const recipe = get().recipe
      const next = {
        ...recipe,
        portrait: recipe.portrait,
        costume: recipe.costume && isNsfwCostume(recipe.costume) ? null : recipe.costume,
        pose: recipe.pose && isNsfwPose(recipe.pose) ? null : recipe.pose,
      }
      localStorage.setItem(RECIPE_KEY, JSON.stringify(next))
      set({ safeMode, recipe: next })
      return
    }
    set({ safeMode })
  },

  requestUnlockNsfw: () => {
    if (!get().safeMode) return
    useStore.getState().setConfirmDialog({
      title: '年龄确认',
      message: '图库含部分 18+ 成人向姿势与穿搭参考，仅供合法艺术创作。确认你已年满 18 周岁并自行承担使用责任？',
      confirmText: '已满 18 岁，继续',
      cancelText: '取消',
      tone: 'warning',
      action: () => {
        get().setSafeMode(false)
      },
    })
  },

  setPoseDepthMode: (poseDepthMode) => {
    localStorage.setItem(DEPTH_KEY, String(poseDepthMode))
    const recipe = get().recipe
    if (recipe.pose) {
      const next = { ...recipe, pose: { ...recipe.pose, useDepth: poseDepthMode } }
      localStorage.setItem(RECIPE_KEY, JSON.stringify(next))
      set({ poseDepthMode, recipe: next })
      return
    }
    set({ poseDepthMode })
  },

  setStylePreset: (stylePreset) => {
    localStorage.setItem(STYLE_KEY, stylePreset)
    set({ stylePreset })
  },

  togglePortrait: (item) => {
    const recipe = get().recipe
    const next = {
      ...recipe,
      portrait: recipe.portrait?.id === item.id ? null : item,
    }
    localStorage.setItem(RECIPE_KEY, JSON.stringify(next))
    set({ recipe: next })
  },

  toggleCostume: (item) => {
    const { safeMode, recipe } = get()
    if (safeMode && isNsfwCostume(item)) {
      get().requestUnlockNsfw()
      return
    }
    const next = {
      ...recipe,
      costume: recipe.costume?.id === item.id ? null : item,
    }
    localStorage.setItem(RECIPE_KEY, JSON.stringify(next))
    set({ recipe: next })
  },

  togglePose: (item) => {
    const { safeMode, poseDepthMode, recipe } = get()
    if (safeMode && isNsfwPose(item)) {
      get().requestUnlockNsfw()
      return
    }
    const nextItem = { ...item, useDepth: poseDepthMode }
    const next = {
      ...recipe,
      pose: recipe.pose?.id === item.id ? null : nextItem,
    }
    localStorage.setItem(RECIPE_KEY, JSON.stringify(next))
    set({ recipe: next })
  },

  clearSlot: (slot) => {
    const recipe = { ...get().recipe, [slot]: null }
    localStorage.setItem(RECIPE_KEY, JSON.stringify(recipe))
    set({ recipe })
  },

  clearRecipe: () => {
    localStorage.setItem(RECIPE_KEY, JSON.stringify(emptyRecipe))
    set({ recipe: emptyRecipe })
  },

  setExtraImages: (extraImages) => {
    const recipe = { ...get().recipe, extraImages }
    localStorage.setItem(RECIPE_KEY, JSON.stringify(recipe))
    set({ recipe })
  },

  addExtraImage: (image) => {
    const recipe = { ...get().recipe, extraImages: [...(get().recipe.extraImages || []), image] }
    localStorage.setItem(RECIPE_KEY, JSON.stringify(recipe))
    set({ recipe })
  },

  removeExtraImage: (id) => {
    const recipe = {
      ...get().recipe,
      extraImages: (get().recipe.extraImages || []).filter((img) => img.id !== id),
    }
    localStorage.setItem(RECIPE_KEY, JSON.stringify(recipe))
    set({ recipe })
  },

  randomFill: (pools) => {
    const { safeMode, poseDepthMode } = get()
    const portraits = pools.portraits
    const costumes = pools.costumes.filter((c) => !safeMode || !isNsfwCostume(c))
    const poses = pools.poses.filter((p) => !safeMode || !isNsfwPose(p))
    const pick = <T,>(list: T[]) => (list.length ? list[Math.floor(Math.random() * list.length)] : null)
    const pose = pick(poses)
    const recipe: RecipeState = {
      portrait: pick(portraits),
      costume: pick(costumes),
      pose: pose ? { ...pose, useDepth: poseDepthMode } : null,
      extraImages: get().recipe.extraImages || [],
    }
    localStorage.setItem(RECIPE_KEY, JSON.stringify(recipe))
    set({ recipe })
  },
}))
