import type { CustomProviderDefinition, InputImage, TaskRecord, TryOnOptions } from '../types'
import { preloadLiveFrames } from './livePhoto'

const REFERENCE_ELEMENTS = ['outfit', 'scene', 'style'] as const
const RANDOM_POSES = [
  '正面自然站立，重心放松',
  '身体轻轻侧向，头部自然回望镜头',
  '轻松向前行走，采用小幅自然步态',
  '侧身缓步行走，肩颈放松',
  '微微转身，形成自然三分之二侧身姿态',
  '重心轻移到一侧，保持舒适自然的站姿',
  '轻微前倾互动，保持身体与镜头的合理距离',
  '自然倚靠或坐姿，必须使用场景中已有的合理支撑，没有支撑则采用放松站姿',
]

export function normalizeTryOnOptions(value: unknown): TryOnOptions {
  const opts = value && typeof value === 'object' ? value as Partial<TryOnOptions> : {}
  const mode = opts.mode === 'reference' || opts.mode === 'hold' ? opts.mode : 'wear'
  const pose = opts.pose === 'random' || opts.pose === 'walking' || opts.pose === 'sitting' || opts.pose === 'showcase' || (mode === 'reference' && opts.pose === 'reference') ? opts.pose : 'natural'
  const referenceElements = REFERENCE_ELEMENTS.filter((key) => Array.isArray(opts.referenceElements) && opts.referenceElements.includes(key))
  return {
    mode,
    category: opts.category === 'shoes' || opts.category === 'bag' || opts.category === 'accessory' || opts.category === 'other' ? opts.category : 'clothing',
    scene: opts.scene === 'cafe' || opts.scene === 'studio' || opts.scene === 'outdoors' ? opts.scene : 'street',
    pose,
    ...(mode === 'reference' ? { referenceElements: referenceElements.length ? referenceElements : [...REFERENCE_ELEMENTS] } : {}),
    ...(pose === 'random' && typeof opts.poseVariant === 'number' && Number.isInteger(opts.poseVariant) && opts.poseVariant >= 0 && opts.poseVariant < RANDOM_POSES.length ? { poseVariant: opts.poseVariant } : {}),
  }
}

/** 新生成不带抽样号，重试带历史号；不能在读库或每次构造请求时重抽。 */
export function prepareTryOnSubmissionOptions(value: unknown): TryOnOptions {
  const opts = normalizeTryOnOptions(value)
  return opts.pose === 'random' && opts.poseVariant === undefined
    ? { ...opts, poseVariant: Math.floor(Math.random() * RANDOM_POSES.length) }
    : opts
}

export function isTryOnTask(task: TaskRecord) {
  return task.tryOn !== undefined || task.professionalPreset === 'try-on'
}

export function normalizeTryOnTask(task: TaskRecord): TaskRecord {
  if (!isTryOnTask(task)) return task
  const normalized = normalizeTryOnOptions(task.tryOn)
  // 异常历史任务曾按默认姿势构造请求；恢复时补固定号，不能在重试时重抽。
  const opts = normalized.pose === 'random' && normalized.poseVariant === undefined ? { ...normalized, poseVariant: 0 } : normalized
  const sameElements = opts.referenceElements
    ? Array.isArray(task.tryOn?.referenceElements) && task.tryOn.referenceElements.length === opts.referenceElements.length && task.tryOn.referenceElements.every((key, index) => key === opts.referenceElements![index])
    : task.tryOn?.referenceElements === undefined
  if (task.professionalPreset === 'try-on' && task.tryOn?.mode === opts.mode && task.tryOn.category === opts.category && task.tryOn.scene === opts.scene && task.tryOn.pose === opts.pose && task.tryOn.poseVariant === opts.poseVariant && sameElements && Object.keys(task.tryOn).length === Object.keys(opts).length) return task
  return { ...task, professionalPreset: 'try-on', tryOn: opts }
}

/** 上传即校验解码，坏文件不能替换编辑器中的有效参考图。 */
export async function validateTryOnImageData(dataUrls: string[]): Promise<void> {
  if (!dataUrls.length || dataUrls.some((dataUrl) => !/^data:image\//i.test(dataUrl))) throw new Error('请上传有效的参考图')
  let timer: ReturnType<typeof setTimeout> | undefined
  const images = await Promise.race([
    preloadLiveFrames(dataUrls).catch((err) => {
      if (err instanceof Error && err.message === '实况帧读取失败，请重新生成') throw new Error('参考图读取失败，请上传有效的图片')
      throw err
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('参考图读取超时，请重新上传后再试')), 15000)
    }),
  ]).finally(() => clearTimeout(timer))
  if (images.length !== dataUrls.length || images.some((image) => !Number.isFinite(image.naturalWidth) || !Number.isFinite(image.naturalHeight) || image.naturalWidth <= 0 || image.naturalHeight <= 0)) throw new Error('参考图尺寸无效，请重新上传后再试')
}

/** 按人物/第二参考图两个独立角色验证，损坏图不进入生成与扣分流程。 */
export async function validateTryOnImages(person: InputImage, product: InputImage): Promise<void> {
  if (!person.id || !product.id || !/^data:image\//i.test(person.dataUrl) || !/^data:image\//i.test(product.dataUrl)) throw new Error('请分别上传有效的人物图和第二张参考图')
  if (person.id === product.id || person.dataUrl === product.dataUrl) throw new Error('人物图和第二张参考图不能使用同一张图片')
  await validateTryOnImageData([person.dataUrl, product.dataUrl])
}

/** 自定义模板必须实际发送两个参考；不能把缺商品图的请求伪装成双图试衣。 */
export function assertTryOnProviderSupportsReferences(provider: CustomProviderDefinition | null | undefined) {
  if (!provider) return
  const mapping = provider.editSubmit ?? provider.submit
  if (mapping.method !== 'GET' && mapping.contentType === 'multipart' && mapping.files?.some((file) => file.source === 'inputImages')) return
  const tokens = new Set<string>()
  const collect = (value: unknown) => {
    if (typeof value === 'string') tokens.add(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') Object.values(value).forEach(collect)
  }
  if (mapping.method !== 'GET') collect(mapping.body)
  collect(mapping.query)
  if (tokens.has('$inputImages.dataUrls') || (tokens.has('$inputImages.dataUrls.0') && tokens.has('$inputImages.dataUrls.1'))) return
  throw new Error('当前绘图配置没有双图参考映射，无法同时使用两张参考图，请联系管理员配置支持双图的服务')
}

/** 辅助描述只进入绘图请求；作品和输入框仍保存用户自己的文案。 */
export function appendTryOnPrompt(prompt: string, options: TryOnOptions, count = 1): string {
  const opts = normalizeTryOnOptions(options)
  const category = { clothing: '服装', shoes: '鞋履', bag: '包袋', accessory: '配饰', other: '商品' }[opts.category]
  const scene = { street: '自然街景', cafe: '真实咖啡店', studio: '干净摄影棚', outdoors: '自然户外环境' }[opts.scene]
  const pose = opts.pose === 'reference'
    ? '仅参考第二张图人物的肢体姿势、朝向和手脚相对位置，不复制第二个人的身份、脸或发型；按第一图人物体型合理适配'
    : opts.pose === 'random'
      ? `本次随机姿势采用${RANDOM_POSES[opts.poseVariant ?? 0]}${count > 1 ? `；各输出按顺序采用不同自然姿势：${Array.from({ length: Math.min(4, Math.max(1, Math.trunc(count))) }, (_, index) => `第${index + 1}张${RANDOM_POSES[((opts.poseVariant ?? 0) + index) % RANDOM_POSES.length]}`).join('，')}，保持人物身份与所选参考元素一致，不要把所有输出画成同一姿势` : ''}`
      : { natural: '自然放松的姿态', walking: '轻松行走的动态姿态', sitting: '自然坐姿', showcase: '克制且清楚展示商品的姿态' }[opts.pose]
  const identity = '严格保留人物原有年龄、身份、脸型、五官、发型、肤色和身体比例，不改变人物年龄，不更换人物，不美化成另一张脸；保留自然皮肤纹理，避免塑料磨皮和过度修饰'
  const anatomy = '不要增加多余肢体、手指或变形身体，不添加虚构评价、广告文案、价格、文字或水印，不声称真实使用体验'
  if (opts.mode === 'reference') {
    const elements = opts.referenceElements!
    return [
      prompt.trim(),
      '生成真实摄影风格的人物参考创作图。第一张参考图是人物身份图，仅用于人物身份、五官、原有年龄、肤色与体型；第二张参考图是穿搭、场景和拍摄风格参考图，仅提取选中的参考元素，不要混淆或交换两图角色',
      identity,
      '第二张图即使有人物，也不得复制其脸型、五官、年龄、肤色、体型或发型；不得复制第二张图的水印、文字、广告或平台界面',
      elements.includes('outfit')
        ? '参考第二张图的整套穿搭，包括可见的上衣、下装、鞋履、包袋与配饰，保留颜色、搭配、版型、材质与可见细节；按第一图人物体型自然穿戴，保留合理垂坠、褶皱和接触阴影，不改变身体比例'
        : '不参考第二张图的穿搭，沿用第一张人物图的原有衣服、鞋履、包袋与配饰，不擅自替换',
      elements.includes('scene')
        ? '参考第二张图的场景、背景和环境布局，让第一图人物自然融入该场景，空间关系与透视合理'
        : '不参考第二张图的场景，沿用第一张人物图的背景与环境，不擅自更换场景',
      elements.includes('style')
        ? '参考第二张图的拍摄风格，包括光线、色调、构图与镜头视角；仅参考摄影表现，不复制第二个人的外貌'
        : '不参考第二张图的拍摄风格，沿用第一张人物图的光线、色调、构图与镜头视角',
      `人物姿势采用${pose}；只调整所选元素与姿势，光线、透视、景深与阴影合理统一，不像生硬拼贴`,
      anatomy,
    ].filter(Boolean).join('。')
  }
  const action = opts.mode === 'hold'
    ? `让人物自然拿着或使用第二张参考图中的${category}，手掌尺寸与商品大小匹配，抓握有真实接触和受力，保持手指、关节和左右手解剖合理`
    : `让人物自然穿戴第二张参考图中的${category}，只替换对应类别的原有穿搭，保留其他服饰；服装贴合身体但不改变体型，具有合理垂坠、褶皱、遮挡和接触阴影，鞋履和配饰位置符合真实穿戴方式`
  return [
    prompt.trim(),
    '生成真实摄影风格的人物试衣或生活方式商品种草图。第一张参考图是人物，只用于人物身份与外观；第二张参考图是商品，只用于目标商品，不要混淆或交换两图角色',
    identity,
    `严格保留目标${category}的颜色、版型、结构、尺寸比例、材质、图案、品牌标识与可见包装细节，不设计新款、不虚构配件或标识，不随意改色`,
    action,
    `场景采用${scene}，人物采用${pose}；光线、透视、景深、色温与阴影统一，画面真实自然，像日常照片，不像生硬拼贴`,
    anatomy,
  ].filter(Boolean).join('。')
}
