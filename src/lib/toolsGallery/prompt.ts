import type { ExtraReferenceImage, RecipeState } from './types'

export const STYLE_PRESETS: Record<string, { label: string; prompt: string }> = {
  none: { label: '无预设（跟随参考图）', prompt: '' },
  realistic: {
    label: '写实人像写真',
    prompt: '写实商业摄影级质感，85mm 人像镜头，自然柔和光影，真实肌肤纹理与织物细节，8k 高清画质。',
  },
  fashion: {
    label: '日韩杂志画报',
    prompt: '日韩时尚穿搭杂志画报风格，干净极简摄影棚背景，高级色调，突出人物颜值与服装剪裁。',
  },
  film: {
    label: '复古胶片写真',
    prompt: '35mm 富士胶片摄影质感，轻微胶片颗粒，柔和复古暖调，自然街拍光影与电影呼吸感。',
  },
  semi_real: {
    label: '2.5D 游戏原画立绘',
    prompt: '2.5D 半写实高精度游戏角色原画，唯美厚涂光影，精致五官与华丽布料金属质感。',
  },
  anime: {
    label: '日系二次元插画',
    prompt: '日系精致二次元插画风格，细腻赛璐璐与厚涂光影过渡，动漫角色立绘质感，色彩通透干净。',
  },
  cel_anime: {
    label: '新海诚感动画电影',
    prompt: '动画电影级画面质感，清澈高饱和光影，细腻体积光与发丝高光，干净唯美的动漫色彩。',
  },
  manga: {
    label: '日式黑白漫画网点',
    prompt: '日本黑白漫画原稿风格，利落精准的G笔线稿，细腻漫画网点纸阴影与层次对比。',
  },
  render3d: {
    label: '3D 次世代角色渲染',
    prompt: 'Unreal Engine 5 / Octane Render 次世代 3D 角色渲染，细腻次表面散射肌肤材质，电影级布光。',
  },
  chibi_box: {
    label: '3D 潮玩手办质感',
    prompt: '高品质 PVC 涂装完成品手办质感，柔和摄影棚柔光箱布光，精致材质高光与微距景深。',
  },
  cyberpunk: {
    label: '赛博朋克霓虹',
    prompt: '赛博朋克科幻视觉风格，雨夜霓虹冷暖双色轮廓光，未来感材质反光与电影级氛围。',
  },
  concept_sheet: {
    label: '角色设定集立绘（纯白底）',
    prompt: '标准角色设定集全身立绘，纯白干净无杂物背景，均匀漫反射布光，清晰展示全身服装结构与配饰细节。',
  },
}

const PHOTO_STYLES = new Set(['realistic', 'fashion', 'film'])

export function buildRecipePrompt(
  recipe: RecipeState,
  stylePreset = 'realistic',
  workflowImages: ExtraReferenceImage[] = [],
): string {
  const styleInfo = STYLE_PRESETS[stylePreset] ?? STYLE_PRESETS.realistic
  const isPhoto = PHOTO_STYLES.has(stylePreset)
  const faceless = !recipe.portrait && Boolean(recipe.costume && recipe.pose)
  const clauses: string[] = []
  let idx = 1
  let costumeIdx = 0

  if (recipe.portrait) {
    const hairDesc =
      recipe.portrait.发型名称 && recipe.portrait.发型名称 !== '标准基础款'
        ? recipe.portrait.标题
        : recipe.portrait.发长
    const skin = '人物的肤色必须与图一人物一致，所有裸露皮肤（包括服装镂空处露出的皮肤）必须与脸部肤色统一，统一后的肤色与质感按风格要求呈现。'
    const outfit = recipe.costume ? '' : '保留图1人物原有可见服装与配饰，不复制姿势参考图的服装或白模外观。'
    clauses.push(
      recipe.portrait.source === 'upload'
        ? `• 人物：图${idx}中的人物，保持其脸型、五官、发型和发色一致。${skin}${outfit}`
        : `• 人物：图${idx}中的人物，保持其脸型、五官、发型（${hairDesc}）和发色一致。${skin}${outfit}`,
    )
    idx++
  }
  if (recipe.costume) {
    costumeIdx = idx
    clauses.push(
      recipe.costume.source === 'upload'
        ? `• 服装：让人物穿上图${idx}中展示的整套服装和配饰，每件单品的颜色、款式、面料与配饰都以图${idx}为准。`
        : `• 服装：让人物穿上图${idx}中展示的整套服装和配饰（参考名称：${recipe.costume.服装名称}），每件单品的颜色、款式、面料与配饰都以图${idx}为准，名称仅作辅助说明。`,
    )
    idx++
  }
  if (recipe.pose) {
    const wear = costumeIdx ? `，穿着图${costumeIdx}的服装` : ''
    const body = isPhoto
      ? `最终画面中的人物是真人，皮肤真实自然${wear}`
      : `人物的肤色与质感按风格要求呈现${wear}`
    clauses.push(
      recipe.pose.source === 'upload'
        ? `• 姿势：按照图${idx}中的人物动作和镜头角度摆姿势；仅参考姿势与构图，不复制图${idx}人物的外观与服装，${body}。`
        : `• 姿势：按照图${idx}中人体模型的动作和镜头角度摆姿势（${recipe.pose.姿势名称}，${recipe.pose.角度}）；图${idx}只是动作示意，${body}。`,
    )
    idx++
  }
  if (faceless) {
    clauses.push('• 无脸展示：生成一位穿着参考服装的成年展示人物，脸部保持无五官的自然肤色表面，不添加眼睛、鼻子、嘴巴或具体人物身份；全身裸露皮肤的颜色统一，不照搬服装图或姿势图的灰白人台材质。')
  }
  for (const extra of [...workflowImages, ...(recipe.extraImages || [])]) {
    clauses.push(`• 附加参考：融合图${idx}（${extra.name || '补充元素'}）中的元素、配饰、背景或光影细节。`)
    idx++
  }

  if (clauses.length === 0) return '请先选择人像/服装/姿势或上传附加参考图。'

  const lines = [
    `请根据提供的 ${idx - 1} 张参考图，生成一张完整的${faceless ? '人物穿搭展示图' : isPhoto ? '真实人物照片' : '人物图像'}：`,
    ...clauses,
  ]
  if (styleInfo.prompt) {
    lines.push(`• 风格：${styleInfo.prompt} ${faceless ? '人物比例协调，手部自然，脸部无五官，光影统一。' : '人物比例协调，手部与五官自然，光影统一。'}`)
  }
  lines.push('画面中没有任何文字、标志或水印。')
  return lines.join('\n')
}
