export const STYLE_PRESETS = [
  { key: 'anime', label: '动漫风格', image: '/art/work-sakura.jpg', prompt: '日系动漫风格，清晰线稿，通透色彩，细腻光影，富有故事感的画面构图' },
  { key: 'realistic', label: '写实风格', image: '/art/work-seaside.jpg', prompt: '写实摄影风格，真实材质与自然光影，准确空间关系，丰富细节，高质量成像' },
  { key: 'portrait', label: '真实人物', image: '/art/auth-register.jpg', prompt: '真实人物摄影，自然皮肤质感，保留细微毛孔、浅淡雀斑与痘印、轻微肤色不均、眼下阴影和清晰唇纹，真实面部细节；手机原生摄影，轻微手持运动模糊、镜头色散、暗部噪点与自然曝光波动，避免过度磨皮、蜡像感、塑料皮肤和CG质感' },
  { key: '2d', label: '二次元', image: '/art/work-hanfu.jpg', prompt: '精致二次元插画，唯美人物设计，柔和光晕，干净线条，层次丰富的色彩' },
  { key: 'artistic', label: '艺术风格', image: '/art/work-train.jpg', prompt: '艺术插画风格，富有表现力的笔触，和谐配色，强烈氛围感，完整视觉叙事' },
  { key: 'cyberpunk', label: '赛博朋克', image: '/art/work-cyber.jpg', prompt: '赛博朋克美学，霓虹灯光，未来都市，潮湿反射，高对比电影感光影' },
  { key: 'watercolor', label: '水彩插画', image: '/art/hero.jpg', prompt: '透明水彩插画，轻盈晕染，自然纸张纹理，柔和留白，清新细腻' },
  { key: 'oil', label: '油画风格', image: '/art/work-seaside.jpg', prompt: '经典油画质感，厚涂笔触，丰富色层，画布肌理，博物馆级光影' },
  { key: 'chinese', label: '国风古典', image: '/art/work-hanfu.jpg', prompt: '东方国风美学，工笔与写意结合，雅致配色，含蓄留白，诗意氛围' },
  { key: 'pixel', label: '像素风格', image: '/art/work-cyber.jpg', prompt: '精致像素艺术，清晰像素边缘，复古游戏配色，细节丰富，画面层次分明' },
  { key: '3d', label: '3D 渲染', image: '/art/work-cat.jpg', prompt: '高品质三维渲染，精细材质，柔和全局光照，电影级构图，真实景深' },
] as const

export type StylePresetKey = (typeof STYLE_PRESETS)[number]['key']

export function appendStylePreset(prompt: string, key?: string): string {
  const base = prompt.trim()
  const preset = STYLE_PRESETS.find((item) => item.key === key)
  if (!preset) return base
  return base ? `${base}，${preset.prompt}` : preset.prompt
}
