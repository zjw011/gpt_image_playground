// 生成结果页。对应设计稿 6：大图展示 + 底部缩略图条 + 右侧操作栏。
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useStore, submitTask, reuseConfig, removeTask } from '../../store'
import AppShell from './AppShell'
import GeneratingQuote from '../../components/GeneratingQuote'
import { useFullImage, useThumbnail } from './useTaskImage'
import { useCreditsStore } from '../../lib/creditsStore'
import { getImage } from '../../lib/db'
import { createLiveFrameSequence, exportLiveFrames } from '../../lib/livePhoto'
import { isLiveProfessionalPreset } from '../../lib/professionalTools'
import { isBackendMode, getBackendUser } from '../../lib/backend'
import { publishWork } from '../../lib/galleryApi'
import {
  IconArrowLeft, IconDownload, IconHeart, IconRefresh, IconCopy,
  IconTrash, IconImage, IconSparkle, IconUpload,
} from '../icons'

function Thumb({ imageId, active, onClick }: { imageId: string, active: boolean, onClick: () => void }) {
  const src = useThumbnail(imageId)
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-16 w-16 shrink-0 overflow-hidden rounded-xl border-2 transition ${active ? 'border-[#7c6cf6] shadow-md shadow-[#7c6cf6]/20' : 'border-transparent opacity-70 hover:opacity-100'}`}
    >
      {src
        ? <img src={src} alt="" className="h-full w-full object-cover" />
        : <span className="flex h-full w-full items-center justify-center bg-white text-[#d8d4ec]"><IconImage className="h-5 w-5" /></span>}
    </button>
  )
}

export default function ResultPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const tasks = useStore((s) => s.tasks)
  const showToast = useStore((s) => s.showToast)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const openFavoritePicker = useStore((s) => s.openFavoritePicker)

  // 没指定 task 就看最新的一张——刚点完"立即生成"跳过来就是这条路
  const task = useMemo(() => {
    const id = searchParams.get('task')
    if (id) return tasks.find((item) => item.id === id) ?? null
    return tasks[0] ?? null
  }, [tasks, searchParams])

  const [activeImageId, setActiveImageId] = useState<string | null>(null)
  // 本次会话里已上传广场的作品：上传成功后按钮变成"已在广场"，避免重复上传
  const [publishedIds, setPublishedIds] = useState<Set<string>>(new Set())
  const [publishing, setPublishing] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const [publishTitle, setPublishTitle] = useState('')
  const [publishCaption, setPublishCaption] = useState('')
  const [liveFrames, setLiveFrames] = useState<string[]>([])
  const [liveFrameIndex, setLiveFrameIndex] = useState(0)
  const [exportingLive, setExportingLive] = useState(false)
  const lastLuckyAt = useCreditsStore((s) => s.lastLuckyAt)
  const imageId = activeImageId && task?.outputImages.includes(activeImageId)
    ? activeImageId
    : task?.outputImages[0] ?? null
  const fullSrc = useFullImage(imageId)
  const liveTask = isLiveProfessionalPreset(task?.professionalPreset)
  const outputKey = task?.outputImages.join('|') ?? ''

  useEffect(() => {
    let alive = true
    setLiveFrames([])
    setLiveFrameIndex(0)
    if (!liveTask || task?.status !== 'done' || task.outputImages.length < 2) return
    void Promise.all(task.outputImages.map((id) => getImage(id))).then((images) => {
      if (!alive) return
      setLiveFrames(images.flatMap((image) => image?.dataUrl ? [image.dataUrl] : []))
    }).catch((err) => console.warn('读取 Live 连续帧失败', err))
    return () => { alive = false }
  }, [liveTask, task?.id, task?.status, outputKey])

  useEffect(() => {
    const sequence = createLiveFrameSequence(liveFrames.length)
    if (sequence.length < 2) return
    let idx = 0
    const timer = window.setInterval(() => {
      idx = (idx + 1) % sequence.length
      setLiveFrameIndex(sequence[idx])
    }, 210)
    return () => window.clearInterval(timer)
  }, [liveFrames.length])

  if (!task) {
    return (
      <AppShell title="生成结果">
        <div className="flex flex-col items-center rounded-3xl border border-[#eceaf6] bg-white py-24 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#efedfd] text-[#7c6cf6]">
            <IconSparkle className="h-7 w-7" />
          </span>
          <p className="mt-5 text-[15px] font-semibold">还没有作品</p>
          <p className="mt-1.5 text-sm text-[#8a86ac]">去创作你的第一张图吧</p>
          <Link to="/studio" className="mt-6 rounded-full bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] px-8 py-3 text-sm font-semibold text-white shadow-lg shadow-[#7c6cf6]/30 transition hover:from-[#6b5ce7] hover:to-[#9678f5]">
            立即创作
          </Link>
        </div>
      </AppShell>
    )
  }

  const running = task.status === 'running'
  const errorHint = task.error && /insufficient[_\s-]*(account[_\s-]*)?balance|余额不足|欠费/i.test(task.error)
    ? '部分绘图渠道余额不足，系统已尝试其他可用渠道。请稍后重试或联系管理员处理渠道余额。'
    : task.error && /尺寸|size|宽.?高|width.?height/i.test(task.error)
      ? '绘图渠道不接受当前尺寸参数。系统已自动改用标准 1:1 尺寸，重新生成即可。'
      : '系统已尝试可用渠道但仍未生成图片，本次失败不会扣除积分。'

  const download = async () => {
    if (liveTask && liveFrames.length > 1) {
      setExportingLive(true)
      try {
        const blob = await exportLiveFrames(liveFrames)
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = `绘想-Live-${task.id}.webm`
        link.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
        showToast('Live 实况视频已导出', 'success')
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Live 实况视频导出失败', 'error')
      } finally {
        setExportingLive(false)
      }
      return
    }
    if (!fullSrc) return
    const link = document.createElement('a')
    link.href = fullSrc
    link.download = `绘想-${task.id}.png`
    link.click()
  }

  const regenerate = async () => {
    await reuseConfig(task)
    // 提交失败（渠道没了之类）就留在当前这件作品上，别把 task 参数清掉
    if (!await submitTask({ stylePreset: task.stylePreset, professionalPreset: task.professionalPreset, liveFrameCount: task.liveFrameCount })) return
    // 清掉 task 参数：新任务进来后自动显示最新那张
    navigate('/result', { replace: true })
  }

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(task.prompt)
      showToast('提示词已复制', 'success')
    } catch {
      showToast('复制失败，请手动选择复制', 'error')
    }
  }

  const confirmDelete = () => {
    setConfirmDialog({
      title: '删除这个作品？',
      message: '删除后无法恢复，确定要删除吗？',
      confirmText: '删除',
      cancelText: '取消',
      action: () => {
        void removeTask(task)
        navigate('/studio', { replace: true })
      },
    })
  }

  // 上传到作品广场：需要登录账号（托管模式）+ 已完成的作品。
  // 未上传的作品只存在这台浏览器里，上传后才会进服务器、公开给所有人看。
  const canPublish = isBackendMode() && Boolean(getBackendUser()) && task.status === 'done'

  // 幸运免单：这张图完成的时间与最近一次免单命中相隔很近，就认定是这一单免的
  const luckyHit = task.status === 'done'
    && task.finishedAt != null
    && lastLuckyAt != null
    && Math.abs(task.finishedAt - lastLuckyAt) < 30_000
  const published = publishedIds.has(task.id)

  const publishToGallery = async () => {
    if (publishing || !imageId) return
    if (!publishTitle.trim()) {
      showToast('请先写一个帖子标题', 'info')
      return
    }
    setPublishing(true)
    try {
      const stored = await getImage(imageId)
      if (!stored?.dataUrl) throw new Error('图片读取失败，请稍后重试')
      await publishWork({
        image: stored.dataUrl,
        title: publishTitle.trim(),
        caption: publishCaption.trim(),
        prompt: task.prompt,
        model: task.apiModel ?? '',
      })
      publishedIds.add(task.id)
      setPublishedIds(new Set(publishedIds))
      setPublishOpen(false)
      showToast('帖子已发布到作品广场', 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '上传失败，请稍后重试', 'error')
    } finally {
      setPublishing(false)
    }
  }

  const ACTIONS: Array<{ icon: (props: { className?: string }) => React.ReactElement, label: string, onClick: () => void, disabled?: boolean, danger?: boolean }> = [
    { icon: IconDownload, label: liveTask ? exportingLive ? '导出中' : '下载 Live' : '下载', onClick: () => void download(), disabled: liveTask ? liveFrames.length < 2 || exportingLive : !fullSrc },
    { icon: IconHeart, label: '收藏', onClick: () => openFavoritePicker([task.id]) },
    ...(canPublish
      ? [{
          icon: IconUpload,
          label: published ? '已在广场' : '发布帖子',
          onClick: () => {
            setPublishTitle('')
            setPublishCaption('')
            setPublishOpen(true)
          },
          disabled: publishing || published,
        }]
      : []),
    { icon: IconRefresh, label: '再次生成', onClick: () => void regenerate() },
    { icon: IconCopy, label: '复制提示词', onClick: () => void copyPrompt() },
    { icon: IconTrash, label: '删除', onClick: confirmDelete, danger: true },
  ]

  return (
    <AppShell title="生成结果" wide>
      <Link to="/studio" className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-[#8a86ac] transition hover:text-[#6b5ce7]">
        <IconArrowLeft className="h-4 w-4" />
        继续创作
      </Link>

      <div className="flex gap-5">
        {/* 主图区 */}
        <div className="min-w-0 flex-1">
          <div className="overflow-hidden rounded-3xl border border-[#eceaf6] bg-white shadow-sm">
            <div className="flex items-center justify-between gap-3 border-b border-[#f1effa] px-5 py-3.5">
              <p className="truncate text-sm font-medium" title={task.prompt}>{task.prompt}</p>
              <div className="flex shrink-0 items-center gap-2">
                {task.isFavorite && <IconHeart className="h-4 w-4 text-[#f472b6]" filled />}
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                  running ? 'bg-[#e3f0ff] text-[#4f7ff0]' : task.status === 'done' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'
                }`}>
                  {running ? '生成中' : task.status === 'done' ? '已完成' : '失败'}
                </span>
              </div>
            </div>

            {luckyHit && (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-gradient-to-r from-amber-50 to-orange-50 px-5 py-3.5">
                <p className="text-sm font-semibold text-amber-700">
                  🎉 恭喜你太幸运了！本次生图触发幸运免单，<span className="font-bold">不扣积分</span>
                </p>
                <span className="shrink-0 text-xs text-amber-600/80">运气也是一种实力</span>
              </div>
            )}

            <div className="flex min-h-[420px] items-center justify-center bg-[#faf9fe] p-5">
              {running ? (
                <div className="flex flex-col items-center text-center">
                  <span className="relative flex h-16 w-16 items-center justify-center">
                    <span className="absolute inset-0 animate-ping rounded-full bg-[#7c6cf6]/20" />
                    <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#7c6cf6] to-[#a78bfa] text-white shadow-lg shadow-[#7c6cf6]/30">
                      <IconSparkle className="h-6 w-6 animate-pulse" />
                    </span>
                  </span>
                  <p className="mt-5 text-sm font-semibold">{liveTask ? `正在生成连续帧 ${task.liveFramesCompleted ?? 0}/${task.liveFrameCount ?? 1}` : '正在绘制你的想象…'}</p>
                  <p className="mt-1.5 max-w-sm truncate text-xs text-[#a5a1c4]">{task.prompt}</p>
                  {liveTask && <div className="mt-4 h-1.5 w-56 overflow-hidden rounded-full bg-[#e5e1f5]"><div className="h-full rounded-full bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] transition-all" style={{ width: `${((task.liveFramesCompleted ?? 0) / Math.max(1, task.liveFrameCount ?? 1)) * 100}%` }} /></div>}
                  <GeneratingQuote />
                </div>
              ) : task.status === 'error' ? (
                <div className="w-full max-w-xl px-4 text-center">
                  <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-red-50 text-2xl">!</span>
                  <p className="mt-4 text-sm font-semibold text-red-500">这次没有生成成功</p>
                  <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-[#8a86ac]">{errorHint}</p>
                  {task.error && (
                    <details className="mx-auto mt-4 max-w-lg rounded-2xl border border-red-100 bg-white px-4 py-3 text-left">
                      <summary className="cursor-pointer text-xs font-medium text-[#8a86ac]">查看渠道错误详情</summary>
                      <p className="mt-3 whitespace-pre-wrap break-words text-[11px] leading-5 text-red-400">{task.error}</p>
                    </details>
                  )}
                  <button
                    type="button"
                    onClick={() => void regenerate()}
                    className="mt-5 rounded-full bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-[#7c6cf6]/25"
                  >
                    重新生成
                  </button>
                </div>
              ) : liveTask && liveFrames.length > 1 ? (
                <div className="relative flex h-[62vh] max-h-[720px] w-full items-center justify-center overflow-hidden rounded-2xl bg-[#111] shadow-lg">
                  {liveFrames.map((src, idx) => (
                    <img key={idx} src={src} alt={`Live 连续帧 ${idx + 1}`} className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${idx === liveFrameIndex ? 'opacity-100' : 'opacity-0'}`} />
                  ))}
                  <span className="absolute left-4 top-4 rounded-full bg-black/55 px-3 py-1.5 text-[11px] font-semibold text-white backdrop-blur">LIVE · {liveFrames.length} AI 关键帧</span>
                </div>
              ) : fullSrc ? (
                <img src={fullSrc} alt={task.prompt} className="max-h-[62vh] rounded-2xl object-contain shadow-lg" />
              ) : (
                <span className="text-[#d8d4ec]"><IconImage className="h-12 w-12" /></span>
              )}
            </div>

            {/* 缩略图条 */}
            {task.outputImages.length > 1 && (
              <div className="flex gap-2.5 overflow-x-auto border-t border-[#f1effa] px-5 py-3.5">
                {task.outputImages.map((id) => (
                  <Thumb key={id} imageId={id} active={id === imageId} onClick={() => setActiveImageId(id)} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 右侧操作栏 */}
        <div className="flex w-[76px] shrink-0 flex-col gap-2">
          {ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              disabled={'disabled' in action && Boolean(action.disabled)}
              className={`flex flex-col items-center gap-1.5 rounded-2xl border border-[#eceaf6] bg-white py-3.5 text-[11px] font-medium shadow-sm transition hover:-translate-y-0.5 hover:shadow disabled:cursor-not-allowed disabled:opacity-40 ${
                'danger' in action && action.danger ? 'text-red-400 hover:border-red-200 hover:text-red-500' : 'text-[#6f6a94] hover:border-[#cdc7ee] hover:text-[#6b5ce7]'
              }`}
            >
              <action.icon className="h-5 w-5" />
              {action.label}
            </button>
          ))}
        </div>
      </div>

      {publishOpen && (
        <div className="animate-overlay-in fixed inset-0 z-50 flex items-center justify-center bg-[#33285f]/45 p-4 backdrop-blur-sm" onClick={() => !publishing && setPublishOpen(false)}>
          <div className="animate-modal-in w-full max-w-2xl overflow-hidden rounded-3xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-[#f0edf8] px-6 py-4">
              <div>
                <h2 className="text-base font-bold text-[#37335c]">发布到作品广场</h2>
                <p className="mt-1 text-xs text-[#a5a1c4]">写下你想分享的内容，提示词会收进帖子的「查看提示词」中</p>
              </div>
              <button type="button" disabled={publishing} onClick={() => setPublishOpen(false)} className="flex h-8 w-8 items-center justify-center rounded-full text-xl text-[#a5a1c4] hover:bg-[#f6f4fc] hover:text-[#5b5680]">×</button>
            </div>
            <div className="grid gap-5 p-6 sm:grid-cols-[180px_minmax(0,1fr)]">
              <div className="overflow-hidden rounded-2xl bg-[#f6f4fc]">
                {fullSrc && <img src={fullSrc} alt="待发布作品" className="aspect-[4/5] h-full w-full object-cover" />}
              </div>
              <div className="min-w-0">
                <label className="text-xs font-semibold text-[#5b5680]" htmlFor="gallery-post-title">帖子标题</label>
                <input
                  id="gallery-post-title"
                  value={publishTitle}
                  onChange={(event) => setPublishTitle(Array.from(event.target.value).slice(0, 60).join(''))}
                  autoFocus
                  placeholder="给这张作品起个吸引人的标题"
                  className="mt-2 w-full rounded-xl border border-[#e5e1f5] px-3.5 py-3 text-sm outline-none transition focus:border-[#8b7bf6] focus:ring-4 focus:ring-[#7c6cf6]/10"
                />
                <div className="mt-4 flex items-center justify-between">
                  <label className="text-xs font-semibold text-[#5b5680]" htmlFor="gallery-post-caption">正文 <span className="font-normal text-[#b3aed0]">· 可选</span></label>
                  <span className="text-[11px] text-[#b3aed0]">{Array.from(publishCaption).length}/500</span>
                </div>
                <textarea
                  id="gallery-post-caption"
                  value={publishCaption}
                  onChange={(event) => setPublishCaption(Array.from(event.target.value).slice(0, 500).join(''))}
                  rows={6}
                  placeholder="说说创作灵感、画面故事，或者你想记住的细节…"
                  className="mt-2 w-full resize-none rounded-xl border border-[#e5e1f5] px-3.5 py-3 text-sm leading-6 outline-none transition focus:border-[#8b7bf6] focus:ring-4 focus:ring-[#7c6cf6]/10"
                />
                <p className="mt-2 text-[11px] leading-5 text-[#a5a1c4]">公开帖子暂不支持网址链接，请保持友善交流。</p>
              </div>
            </div>
            <div className="flex justify-end gap-3 border-t border-[#f0edf8] px-6 py-4">
              <button type="button" disabled={publishing} onClick={() => setPublishOpen(false)} className="rounded-full border border-[#ded9ef] px-5 py-2.5 text-sm font-medium text-[#6f6a94] hover:border-[#bdb5e3]">取消</button>
              <button type="button" disabled={publishing || !publishTitle.trim()} onClick={() => void publishToGallery()} className="rounded-full bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-[#7c6cf6]/25 disabled:cursor-not-allowed disabled:opacity-40">
                {publishing ? '发布中…' : '发布帖子'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  )
}
