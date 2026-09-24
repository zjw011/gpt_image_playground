// 生成页（核心功能）。对应设计稿 5：
// Tab 切换创作模式、提示词输入、风格预设横滑、比例/数量、立即生成。
// 底层完全复用现有 store 的 submitTask 生成管线。
import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useStore, submitTask, addImageFromFile } from '../../store'
import { getCreditsConfig } from '../../lib/backend'
import { useCreditsStore } from '../../lib/creditsStore'
import AppShell from './AppShell'
import { assetUrl } from '../../lib/assetUrl'
import { useThumbnail } from './useTaskImage'
import { IconImage, IconSparkle, IconUpload, IconBrush, IconArrowRight, IconPlus, IconMinus, IconEdit } from '../icons'

type TabKey = 'text' | 'image' | 'inpaint' | 'outpaint'

const TABS: Array<{ key: TabKey, label: string }> = [
  { key: 'text', label: '文生图' },
  { key: 'image', label: '图生图' },
  { key: 'inpaint', label: '局部重绘' },
  { key: 'outpaint', label: 'AI 扩图' },
]

/** 风格预设：选中后把风格词缀进提示词，用户能在输入框里看到实际提交的内容 */
const STYLES = [
  { key: 'anime', label: '动漫风格', img: '/art/work-sakura.jpg', suffix: '日系动漫风格，色彩明亮，线条细腻' },
  { key: 'real', label: '写实风格', img: '/art/work-cyber.jpg', suffix: '写实风格，真实光影，超高细节' },
  { key: '2d', label: '二次元', img: '/art/work-hanfu.jpg', suffix: '二次元插画风格，唯美梦幻，柔和光晕' },
  { key: 'art', label: '艺术风格', img: '/art/work-train.jpg', suffix: '艺术插画风格，氛围感强，笔触细腻' },
]

/**
 * 比例到 size 的映射。多数图像模型只有方/横/竖三档，
 * 3:4、9:16 归到竖版，4:3、16:9 归到横版，交给 normalize 按渠道能力收敛。
 */
const RATIOS = [
  { label: '1:1', size: '1024x1024' },
  { label: '3:4', size: '1024x1536' },
  { label: '4:3', size: '1536x1024' },
  { label: '9:16', size: '1024x1536' },
  { label: '16:9', size: '1536x1024' },
]

const OUTPAINT_SUFFIX = '保持原图内容与风格不变，画面自然向外扩展延伸'
const PROMPT_PLACEHOLDER = '描述你想要的画面……例如：樱花下的少女，夕阳，唯美，动漫风格'

/** 最近作品缩略图 */
function RecentThumb({ imageId, taskId }: { imageId: string, taskId: string }) {
  const src = useThumbnail(imageId)
  return (
    <Link
      to={`/result?task=${taskId}`}
      className="group relative aspect-square shrink-0 overflow-hidden rounded-xl border border-[#eceaf6] bg-white"
    >
      {src
        ? <img src={src} alt="" className="h-full w-full object-cover transition duration-300 group-hover:scale-105" />
        : <span className="flex h-full w-full items-center justify-center text-[#d8d4ec]"><IconImage className="h-6 w-6" /></span>}
    </Link>
  )
}

export default function StudioPage() {
  const navigate = useNavigate()
  const prompt = useStore((s) => s.prompt)
  const setPrompt = useStore((s) => s.setPrompt)
  const inputImages = useStore((s) => s.inputImages)
  const removeInputImage = useStore((s) => s.removeInputImage)
  const clearInputImages = useStore((s) => s.clearInputImages)
  const params = useStore((s) => s.params)
  const setParams = useStore((s) => s.setParams)
  const maskDraft = useStore((s) => s.maskDraft)
  const setMaskEditorImageId = useStore((s) => s.setMaskEditorImageId)
  const showToast = useStore((s) => s.showToast)
  const tasks = useStore((s) => s.tasks)

  const [tab, setTab] = useState<TabKey>('text')
  const [activeStyles, setActiveStyles] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const credits = getCreditsConfig()
  const view = useCreditsStore((s) => s.view)
  const needsUpload = tab !== 'text'
  const count = Math.max(1, Math.min(4, params.n || 1))
  const cost = credits ? credits.costPerImage * count : 0
  const currentRatio = RATIOS.find((ratio) => ratio.size === params.size)?.label ?? '1:1'
  const recentTasks = tasks.filter((task) => task.status === 'done' && task.outputImages.length > 0).slice(0, 6)

  const toggleStyle = (suffix: string) => {
    if (activeStyles.includes(suffix)) {
      setActiveStyles(activeStyles.filter((item) => item !== suffix))
      // 词缀是追加在末尾的，取消时原样移除，不动用户自己写的部分
      setPrompt(prompt.replace(`，${suffix}`, '').replace(suffix, ''))
      return
    }
    setActiveStyles([...activeStyles, suffix])
    setPrompt(prompt.trim() ? `${prompt.trim()}，${suffix}` : suffix)
  }

  const pickFiles = async (files: FileList | null) => {
    if (!files) return
    for (const file of Array.from(files)) {
      await addImageFromFile(file)
    }
  }

  const generate = async () => {
    if (!prompt.trim()) {
      showToast('先描述一下你想画的画面', 'error')
      return
    }
    if (needsUpload && inputImages.length === 0) {
      showToast('这个模式需要先上传一张参考图', 'error')
      return
    }
    if (tab === 'outpaint' && !prompt.includes(OUTPAINT_SUFFIX)) {
      setPrompt(prompt.trim() ? `${prompt.trim()}，${OUTPAINT_SUFFIX}` : OUTPAINT_SUFFIX)
    }
    // 提交没成功（缺渠道、缺提示词、遮罩待确认）就别跳结果页，
    // 否则用户会被扔到一个空结果页，以为按钮坏了。
    if (!await submitTask()) return
    navigate('/result')
  }

  return (
    <AppShell title="AI 绘画" wide>
      <div className="rounded-3xl border border-[#eceaf6] bg-white p-6 shadow-sm">
        {/* 创作模式 Tab */}
        <div className="flex gap-2">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={`rounded-full px-5 py-2 text-sm font-medium transition ${
                tab === item.key
                  ? 'bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] text-white shadow-md shadow-[#7c6cf6]/25'
                  : 'bg-[#f5f4fb] text-[#6f6a94] hover:bg-[#efedfd] hover:text-[#6b5ce7]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* 提示词 */}
        <div className="mt-5 rounded-2xl border border-[#e4e1f2] bg-[#faf9fe] transition focus-within:border-[#7c6cf6] focus-within:bg-white focus-within:ring-4 focus-within:ring-[#7c6cf6]/10">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            maxLength={2000}
            placeholder={PROMPT_PLACEHOLDER}
            className="w-full resize-none rounded-2xl bg-transparent px-4 py-3.5 text-sm leading-6 text-[#37335c] outline-none placeholder:text-[#a5a1c4]"
          />
          <div className="flex items-center justify-between px-4 pb-2.5 text-[11px] text-[#b3aed0]">
            <span>{tab === 'outpaint' ? 'AI 扩图会自动在提示词末尾追加扩展指令' : '描述越具体，画面越接近想象'}</span>
            <span>{prompt.length}/2000</span>
          </div>
        </div>

        {/* 文生图但带着参考图：说清楚实际会按图生图走 */}
        {tab === 'text' && inputImages.length > 0 && (
          <div className="mt-3 flex items-center justify-between rounded-xl bg-[#f4f2fe] px-4 py-2.5 text-[12.5px] text-[#6b5ce7]">
            <span>已上传 {inputImages.length} 张参考图，本次将按图生图处理</span>
            <button type="button" onClick={clearInputImages} className="font-medium underline underline-offset-2 hover:text-[#5a4cd6]">
              清除参考图
            </button>
          </div>
        )}

        {/* 参考图上传（图生图/局部重绘/AI 扩图） */}
        {needsUpload && (
          <div className="mt-4">
            <div className="flex flex-wrap items-center gap-3">
              {inputImages.map((img, idx) => (
                <div key={img.id} className="group relative h-20 w-20 overflow-hidden rounded-xl border border-[#e4e1f2]">
                  <img src={img.dataUrl} alt="" className="h-full w-full object-cover" />
                  <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-black/45 opacity-0 transition group-hover:opacity-100">
                    {tab === 'inpaint' && (
                      <button
                        type="button"
                        onClick={() => setMaskEditorImageId(img.id)}
                        title="涂抹遮罩"
                        className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/90 text-[#6b5ce7]"
                      >
                        <IconEdit className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => removeInputImage(idx)}
                      title="移除"
                      className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/90 text-red-500"
                    >
                      <IconMinus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-[#dcd8f0] text-[#a5a1c4] transition hover:border-[#7c6cf6] hover:text-[#7c6cf6]"
              >
                <IconUpload className="h-5 w-5" />
                <span className="text-[10px]">上传图片</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => {
                  void pickFiles(event.target.files)
                  event.target.value = ''
                }}
              />
              <span className="text-xs text-[#b3aed0]">
                {tab === 'inpaint'
                  ? maskDraft ? '遮罩已绘制，提交后将只重绘涂抹区域' : '上传后点图片上的编辑按钮涂抹要重绘的区域'
                  : tab === 'outpaint' ? '上传要扩展的原图' : '上传参考图，AI 会基于它再创作'}
              </span>
            </div>
          </div>
        )}

        {/* 风格预设 */}
        <div className="mt-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">选择风格</h3>
            <span className="text-[11px] text-[#b3aed0]">选中会把风格词加进提示词</span>
          </div>
          <div className="hide-scrollbar mt-3 flex gap-3 overflow-x-auto pb-1">
            {STYLES.map((style) => {
              const active = activeStyles.includes(style.suffix)
              return (
                <button
                  key={style.key}
                  type="button"
                  onClick={() => toggleStyle(style.suffix)}
                  className={`w-[104px] shrink-0 overflow-hidden rounded-xl border-2 text-left transition ${
                    active ? 'border-[#7c6cf6] shadow-md shadow-[#7c6cf6]/20' : 'border-transparent hover:border-[#dcd8f0]'
                  }`}
                >
                  <img src={assetUrl(style.img)} alt={style.label} loading="lazy" className="h-[68px] w-full object-cover" />
                  <span className={`block px-2 py-1.5 text-center text-[11px] font-medium ${active ? 'text-[#6b5ce7]' : 'text-[#6f6a94]'}`}>
                    {style.label}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* 比例 + 数量 */}
        <div className="mt-6 flex flex-wrap items-end gap-8">
          <div>
            <h3 className="text-sm font-semibold">画面比例</h3>
            <div className="mt-3 flex gap-2">
              {RATIOS.map((ratio) => (
                <button
                  key={ratio.label}
                  type="button"
                  onClick={() => setParams({ size: ratio.size })}
                  className={`rounded-lg px-3.5 py-2 text-[13px] font-medium transition ${
                    currentRatio === ratio.label
                      ? 'bg-[#efedfd] text-[#6b5ce7] ring-1 ring-[#7c6cf6]/40'
                      : 'bg-[#f5f4fb] text-[#6f6a94] hover:bg-[#efedfd]'
                  }`}
                >
                  {ratio.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold">生成数量</h3>
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setParams({ n: Math.max(1, count - 1) })}
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#f5f4fb] text-[#6f6a94] transition hover:bg-[#efedfd] hover:text-[#6b5ce7]"
              >
                <IconMinus className="h-4 w-4" />
              </button>
              <span className="w-6 text-center text-[15px] font-bold">{count}</span>
              <button
                type="button"
                onClick={() => setParams({ n: Math.min(4, count + 1) })}
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#f5f4fb] text-[#6f6a94] transition hover:bg-[#efedfd] hover:text-[#6b5ce7]"
              >
                <IconPlus className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        {/* 提交 */}
        <button
          type="button"
          onClick={() => void generate()}
          className="mt-7 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] py-4 text-[15px] font-semibold text-white shadow-xl shadow-[#7c6cf6]/30 transition hover:from-[#6b5ce7] hover:to-[#9678f5]"
        >
          <IconSparkle className="h-5 w-5" />
          立即生成{credits ? `（消耗 ${cost} 积分）` : ''}
        </button>
        {credits && (
          <p className="mt-2.5 text-center text-[11.5px] text-[#b3aed0]">
            剩余 {view?.available ?? 0} 积分 · 出图失败自动退分
          </p>
        )}
      </div>

      {/* 最近作品 */}
      {recentTasks.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <IconBrush className="h-4 w-4 text-[#7c6cf6]" />
              最近作品
            </h3>
            <Link to="/me?tab=works" className="flex items-center gap-1 text-xs font-medium text-[#6b5ce7] hover:text-[#5a4cd6]">
              全部作品
              <IconArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-6">
            {recentTasks.map((task) => (
              <RecentThumb key={task.id} imageId={task.outputImages[0]} taskId={task.id} />
            ))}
          </div>
        </div>
      )}
    </AppShell>
  )
}
