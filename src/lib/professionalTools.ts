export const PROFESSIONAL_PRESETS = [
  {
    key: 'ecommerce-clean',
    prompt: '专业电商主图设计，严格保留参考商品的外形、材质、颜色、品牌标识和包装文字，纯净高级棚拍背景，主体居中，商业布光，边缘清晰，适合商品首页展示，不添加不存在的配件',
  },
  {
    key: 'ecommerce-lifestyle',
    prompt: '专业电商场景图，严格保留参考商品的外形、材质、颜色、品牌标识和包装文字，把商品自然放入真实生活使用场景，商业摄影布光，空间关系准确，突出商品卖点，不添加不存在的配件',
  },
  {
    key: 'ecommerce-luxury',
    prompt: '高端品牌电商视觉，严格保留参考商品的外形、材质、颜色、品牌标识和包装文字，精致材质台面，克制奢华配色，柔和轮廓光，杂志广告级构图，不添加不存在的配件',
  },
  {
    key: 'ecommerce-poster',
    prompt: '电商营销海报视觉，严格保留参考商品的外形、材质、颜色、品牌标识和包装文字，预留清晰文案区域，层次分明，促销氛围但不过度拥挤，不生成难以辨认的乱码文字',
  },
  {
    key: 'product-suite-store',
    prompt: '围绕参考商品生成一组统一品牌调性的电商套图，每张图保持商品外形、材质、颜色、品牌标识和包装文字一致，画面在纯色主图、使用场景、材质细节和卖点氛围之间自然变化，商业摄影品质，不添加不存在的配件',
  },
  {
    key: 'product-suite-social',
    prompt: '围绕参考商品生成一组统一调性的社交媒体种草套图，每张图保持商品外形、材质、颜色、品牌标识和包装文字一致，包含自然生活方式、近景细节和轻松分享感，真实摄影质感，不添加不存在的配件',
  },
  {
    key: 'product-suite-premium',
    prompt: '围绕参考商品生成一组高端品牌套图，每张图保持商品外形、材质、颜色、品牌标识和包装文字一致，统一高级配色与灯光，包含主视觉、氛围场景和材质特写，杂志广告级品质，不添加不存在的配件',
  },
  {
    key: 'live-blink',
    prompt: '基于参考图生成实况照片连续帧中的一帧。人物身份、脸型、五官、发型、服装、姿势、构图、镜头、背景、光线和色彩必须与参考图高度一致，曝光、白平衡、亮度、色温、对比度与画面颗粒必须逐帧锁定，只允许自然眨眼和极轻微的眼神变化，动作幅度极小，不改变人物身份，不改变画面内容，不新增或删除任何物体，不切换视角，不重构背景，禁止闪烁和忽明忽暗',
  },
  {
    key: 'live-breeze',
    prompt: '基于参考图生成实况照片连续帧中的一帧。人物身份、脸型、五官、发型、服装、姿势、构图、镜头、背景、光线和色彩必须与参考图高度一致，曝光、白平衡、亮度、色温、对比度与画面颗粒必须逐帧锁定，只允许发梢、衣角或周围细小植物被微风轻轻带动，动作幅度极小，不改变人物身份，不改变画面内容，不新增或删除任何物体，不切换视角，不重构背景，禁止闪烁和忽明忽暗',
  },
  {
    key: 'live-breath',
    prompt: '基于参考图生成实况照片连续帧中的一帧。人物身份、脸型、五官、发型、服装、姿势、构图、镜头、背景、光线和色彩必须与参考图高度一致，曝光、白平衡、亮度、色温、对比度与画面颗粒必须逐帧锁定，只允许肩颈和胸口出现几乎不可察觉的自然呼吸变化，动作幅度极小，不改变人物身份，不改变画面内容，不新增或删除任何物体，不切换视角，不重构背景，禁止闪烁和忽明忽暗',
  },
] as const

export type ProfessionalPresetKey = (typeof PROFESSIONAL_PRESETS)[number]['key']

export function appendProfessionalPreset(prompt: string, key?: string): string {
  const base = prompt.trim()
  const preset = PROFESSIONAL_PRESETS.find((item) => item.key === key)
  if (!preset) return base
  return base ? `${base}，${preset.prompt}` : preset.prompt
}

export function isLiveProfessionalPreset(key?: string): boolean {
  return key === 'live-blink' || key === 'live-breeze' || key === 'live-breath'
}
