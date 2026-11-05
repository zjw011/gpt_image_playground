import { dataUrl } from './assets'
import type { CostumeItem, PortraitItem, PoseGroup, PoseItem } from './types'

export const ANGLES = ['正面', '俯视', '仰视', '侧面', '斜侧'] as const

export const PREFERRED_POSE_LINE_ORDER = [
  '全身单人・标准系',
  '上半身单人',
  '全身单人・性感系',
  '双人缠绵',
] as const

export const NSFW_POSE_SYSTEMS = new Set(['全身单人・性感系', '双人缠绵'])
export const NSFW_COSTUME_CATEGORIES = new Set(['内衣・睡衣', '性感穿搭'])

export function isNsfwPoseSystem(system: string) {
  return NSFW_POSE_SYSTEMS.has(system)
}

export function isNsfwPose(item: PoseItem | PoseGroup) {
  const sys = '体系' in item ? item.体系 : item.system
  return NSFW_POSE_SYSTEMS.has(sys)
}

export function isNsfwCostumeCategory(category: string) {
  return NSFW_COSTUME_CATEGORIES.has(category)
}

export function isNsfwCostume(item: CostumeItem) {
  return Boolean(item.敏感) || NSFW_COSTUME_CATEGORIES.has(item.分类)
}

export function costumeSourceId(item: CostumeItem) {
  return item.source || 'gia'
}

export function selectCostumeView(item: CostumeItem, id = item.selectedView || 'front'): CostumeItem {
  const view = item.views?.find((v) => v.id === id) || item.views?.find((v) => v.id === 'front') || item.views?.[0]
  return view ? { ...item, selectedView: view.id, 缩略图: view.缩略图, 预览图: view.预览图, 原图: view.原图 } : item
}

export function buildPoseGroups(items: PoseItem[]) {
  const rawLines = [...new Set(items.map((x) => x.体系))]
  const lines = rawLines.sort((a, b) => {
    const ia = PREFERRED_POSE_LINE_ORDER.indexOf(a as (typeof PREFERRED_POSE_LINE_ORDER)[number])
    const ib = PREFERRED_POSE_LINE_ORDER.indexOf(b as (typeof PREFERRED_POSE_LINE_ORDER)[number])
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })
  const groupMap = new Map<string, PoseGroup>()
  const groups: PoseGroup[] = []

  for (const item of items) {
    const key = `${item.体系}|${item.姿势编号 || item.id}`
    let group = groupMap.get(key)
    if (!group) {
      group = {
        key,
        system: item.体系,
        number: item.姿势编号,
        name: item.姿势名称,
        category: item.分类,
        items: [],
        angles: {},
        order: [],
      }
      groupMap.set(key, group)
      groups.push(group)
    }
    group.items.push(item)
    if (item.角度 && !group.angles[item.角度]) group.angles[item.角度] = item
  }

  groups.sort((a, b) => lines.indexOf(a.system) - lines.indexOf(b.system) || String(a.number).localeCompare(String(b.number)))
  for (const group of groups) {
    group.order = ANGLES.map((a) => group.angles[a]).filter(Boolean) as PoseItem[]
    for (const item of group.items) {
      if (!group.order.includes(item)) group.order.push(item)
    }
  }

  return { items, groups, lines }
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(dataUrl(path))
  if (!res.ok) throw new Error(`加载 ${path} 失败：HTTP ${res.status}`)
  return res.json() as Promise<T>
}

let posesCache: ReturnType<typeof buildPoseGroups> | null = null
let costumesCache: CostumeItem[] | null = null
let portraitsCache: PortraitItem[] | null = null

export async function loadPoses() {
  if (posesCache) return posesCache
  const items = await fetchJson<PoseItem[]>('pose-zh.json')
  posesCache = buildPoseGroups(items)
  return posesCache
}

export async function loadCostumes() {
  if (costumesCache) return costumesCache
  const lists = await Promise.all([
    fetchJson<CostumeItem[]>('costume-zh.json'),
    fetchJson<CostumeItem[]>('costume-anime-zh.json'),
    fetchJson<CostumeItem[]>('costume-gia-anime-zh.json'),
    fetchJson<CostumeItem[]>('costume-shisei-zh.json'),
  ])
  costumesCache = lists.flat()
  return costumesCache
}

export async function loadPortraits() {
  if (portraitsCache) return portraitsCache
  portraitsCache = await fetchJson<PortraitItem[]>('portrait-zh.json')
  return portraitsCache
}
