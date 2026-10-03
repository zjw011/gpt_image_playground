import type { CustomProviderDefinition, InputImage, TaskRecord, TryOnOptions } from '../types'
import { preloadLiveFrames } from './livePhoto'

export function normalizeTryOnOptions(value: unknown): TryOnOptions {
  const opts = value && typeof value === 'object' ? value as Partial<TryOnOptions> : {}
  return {
    mode: opts.mode === 'hold' ? 'hold' : 'wear',
    category: opts.category === 'shoes' || opts.category === 'bag' || opts.category === 'accessory' || opts.category === 'other' ? opts.category : 'clothing',
    scene: opts.scene === 'cafe' || opts.scene === 'studio' || opts.scene === 'outdoors' ? opts.scene : 'street',
    pose: opts.pose === 'walking' || opts.pose === 'sitting' || opts.pose === 'showcase' ? opts.pose : 'natural',
  }
}

export function isTryOnTask(task: TaskRecord) {
  return task.tryOn !== undefined || task.professionalPreset === 'try-on'
}

export function normalizeTryOnTask(task: TaskRecord): TaskRecord {
  if (!isTryOnTask(task)) return task
  const opts = normalizeTryOnOptions(task.tryOn)
  if (task.professionalPreset === 'try-on' && task.tryOn?.mode === opts.mode && task.tryOn.category === opts.category && task.tryOn.scene === opts.scene && task.tryOn.pose === opts.pose && Object.keys(task.tryOn).length === 4) return task
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

/** 按人物/商品两个独立角色验证，损坏图不进入生成与扣分流程。 */
export async function validateTryOnImages(person: InputImage, product: InputImage): Promise<void> {
  if (!person.id || !product.id || !/^data:image\//i.test(person.dataUrl) || !/^data:image\//i.test(product.dataUrl)) throw new Error('请分别上传有效的人物图和商品图')
  if (person.id === product.id || person.dataUrl === product.dataUrl) throw new Error('人物图和商品图不能使用同一张图片')
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
  throw new Error('当前绘图配置没有双图参考映射，无法同时使用人物和商品，请联系管理员配置支持双图的服务')
}

/** 辅助描述只进入绘图请求；作品和输入框仍保存用户自己的文案。 */
export function appendTryOnPrompt(prompt: string, options: TryOnOptions): string {
  const opts = normalizeTryOnOptions(options)
  const category = { clothing: '服装', shoes: '鞋履', bag: '包袋', accessory: '配饰', other: '商品' }[opts.category]
  const scene = { street: '自然街景', cafe: '真实咖啡店', studio: '干净摄影棚', outdoors: '自然户外环境' }[opts.scene]
  const pose = { natural: '自然放松的姿态', walking: '轻松行走的动态姿态', sitting: '自然坐姿', showcase: '克制且清楚展示商品的姿态' }[opts.pose]
  const action = opts.mode === 'hold'
    ? `让人物自然拿着或使用第二张参考图中的${category}，手掌尺寸与商品大小匹配，抓握有真实接触和受力，保持手指、关节和左右手解剖合理`
    : `让人物自然穿戴第二张参考图中的${category}，只替换对应类别的原有穿搭，保留其他服饰；服装贴合身体但不改变体型，具有合理垂坠、褶皱、遮挡和接触阴影，鞋履和配饰位置符合真实穿戴方式`
  return [
    prompt.trim(),
    '生成真实摄影风格的人物试衣或生活方式商品种草图。第一张参考图是人物，只用于人物身份与外观；第二张参考图是商品，只用于目标商品，不要混淆或交换两图角色',
    '严格保留人物原有年龄、身份、脸型、五官、发型、肤色和身体比例，不改变人物年龄，不更换人物，不美化成另一张脸；保留自然皮肤纹理，避免塑料磨皮和过度修饰',
    `严格保留目标${category}的颜色、版型、结构、尺寸比例、材质、图案、品牌标识与可见包装细节，不设计新款、不虚构配件或标识，不随意改色`,
    action,
    `场景采用${scene}，人物采用${pose}；光线、透视、景深、色温与阴影统一，画面真实自然，像日常照片，不像生硬拼贴`,
    '不要增加多余肢体、手指或变形身体，不添加虚构评价、广告文案、价格、文字或水印，不声称真实使用体验',
  ].filter(Boolean).join('。')
}
