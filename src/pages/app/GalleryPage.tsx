// 作品广场。两种数据来源：
// - 托管模式（连了后端）：读服务端 /api/gallery，展示真实用户上传的作品（含作者、点赞）。
// - 纯前端模式（没后端）：没有服务器可存，退回内置的示例作品，界面不空着。
// 未登录也能逛；点赞/发布需要登录账号。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../../store'
import { isBackendMode, getBackendUser } from '../../lib/backend'
import {
  createWorkComment,
  deleteWork,
  deleteWorkComment,
  listGalleryWorks,
  listWorkComments,
  reportWorkComment,
  toggleWorkLike,
  type GalleryComment,
  type GalleryItem,
} from '../../lib/galleryApi'
import AppShell from './AppShell'
import SafeImg from '../../components/SafeImg'
import { assetUrl } from '../../lib/assetUrl'
import { IconCopy, IconHeart, IconEye, IconMessage, IconSearch, IconSparkle, IconTrash } from '../icons'

interface DemoWork {
  id: string
  img: string
  title: string
  author: string
  likes: number
  views: string
  style: string
  prompt: string
  caption: string
  at: number
}

const DEMO_WORKS: DemoWork[] = [
  { id: 'demo-train', img: '/art/work-train.jpg', title: '银河列车今晚会经过哪里', author: '星野', likes: 1280, views: '3.2k', style: '动漫', prompt: '星空下的列车，璀璨银河，车窗暖光，新海诚风格', caption: '把一直想象的夜色画了出来，车窗里的暖光是我最喜欢的细节。', at: 6 },
  { id: 'demo-seaside', img: '/art/work-seaside.jpg', title: '海风刚好，她也刚好回头', author: '蓝调', likes: 986, views: '2.1k', style: '动漫', prompt: '海边少女回头微笑，粉蓝色天空，海鸥，唯美治愈', caption: '粉蓝色的天空和远处的海鸥，是我心里最治愈的夏天。', at: 5 },
  { id: 'demo-cyber', img: '/art/work-cyber.jpg', title: '下雨后的霓虹城', author: 'NightCity', likes: 2100, views: '5.6k', style: '赛博', prompt: '赛博朋克城市夜景，霓虹灯牌，雨后街道倒影', caption: '路面的反光比霓虹灯牌更有故事感，想做一组完整的未来城市系列。', at: 4 },
  { id: 'demo-cat', img: '/art/work-cat.jpg', title: '今天也是被猫咪治愈的一天', author: '喵星人', likes: 2800, views: '6.8k', style: '写实', prompt: '布偶猫特写肖像，蓝眼睛，淡紫蝴蝶结，花瓣光斑', caption: '蓝眼睛和淡紫色蝴蝶结太搭了，像一位安静的小公主。', at: 3 },
  { id: 'demo-hanfu', img: '/art/work-hanfu.jpg', title: '桃花深处见江南', author: '古风小筑', likes: 764, views: '1.8k', style: '古风', prompt: '汉服少女桃花树下，江南水乡，柔和晨光，国风插画', caption: '柔和的晨光落在汉服上，这就是我想象中的春日江南。', at: 2 },
  { id: 'demo-sakura', img: '/art/work-sakura.jpg', title: '樱花落下的时候，春天就有了形状', author: '春日部', likes: 1500, views: '4.1k', style: '动漫', prompt: '春日樱花街道，透明雨伞少女背影，花瓣纷飞', caption: '透明雨伞、少女背影和满街花瓣，保存一个很轻的春日瞬间。', at: 1 },
]

const SERVER_TABS = ['最新', '最热', '我的'] as const
const DEMO_TABS = ['推荐', '最新', '最热'] as const
const STYLE_FILTERS = ['全部风格', '动漫', '写实', '古风', '赛博'] as const
const isServerItem = (item: GalleryItem | DemoWork): item is GalleryItem => 'imageUrl' in item
const formatCommentTime = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })

export default function GalleryPage() {
  const navigate = useNavigate()
  const setPrompt = useStore((s) => s.setPrompt)
  const showToast = useStore((s) => s.showToast)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const backendMode = isBackendMode()
  const me = getBackendUser()

  const [tab, setTab] = useState<string>(backendMode ? '最新' : '推荐')
  const [style, setStyle] = useState<(typeof STYLE_FILTERS)[number]>('全部风格')
  const [keyword, setKeyword] = useState('')
  const [liked, setLiked] = useState<string[]>([])
  const [preview, setPreview] = useState<GalleryItem | DemoWork | null>(null)
  const [works, setWorks] = useState<GalleryItem[]>([])
  const [loading, setLoading] = useState(backendMode)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [comments, setComments] = useState<GalleryComment[]>([])
  const [commentTotal, setCommentTotal] = useState(0)
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const [promptVisible, setPromptVisible] = useState(false)

  const loadWorks = useCallback(async () => {
    if (!backendMode) return
    setLoading(true)
    try {
      const result = await listGalleryWorks()
      setWorks(result.items)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [backendMode])
  useEffect(() => { void loadWorks() }, [loadWorks])

  const myId = me?.id ?? null
  const previewWorkId = preview && isServerItem(preview) ? preview.id : null

  useEffect(() => { setPromptVisible(false) }, [preview?.id])

  useEffect(() => {
    setComments([])
    setCommentTotal(0)
    setCommentText('')
    if (!previewWorkId) return
    let active = true
    setCommentsLoading(true)
    void listWorkComments(previewWorkId).then((result) => {
      if (!active) return
      setComments(result.comments)
      setCommentTotal(result.total)
    }).catch((err) => {
      if (active) showToast(err instanceof Error ? err.message : '评论加载失败', 'error')
    }).finally(() => {
      if (active) setCommentsLoading(false)
    })
    return () => { active = false }
  }, [previewWorkId, showToast])

  const filteredWorks = useMemo(() => {
    const keywordTrim = keyword.trim()
    if (backendMode) {
      let list = [...works]
      if (tab === '最热') list.sort((a, b) => b.likes - a.likes)
      else list.sort((a, b) => b.createdAt - a.createdAt)
      if (tab === '我的') list = list.filter((item) => item.ownerId === myId)
      if (keywordTrim) list = list.filter((item) => item.title.includes(keywordTrim) || item.caption.includes(keywordTrim) || item.ownerName.includes(keywordTrim))
      return list
    }
    let list = DEMO_WORKS
    if (style !== '全部风格') list = list.filter((work) => work.style === style)
    if (keywordTrim) list = list.filter((work) => work.title.includes(keywordTrim) || work.caption.includes(keywordTrim) || work.author.includes(keywordTrim))
    if (tab === '最新') list = [...list].sort((a, b) => b.at - a.at)
    if (tab === '最热') list = [...list].sort((a, b) => b.likes - a.likes)
    return list
  }, [backendMode, works, tab, style, keyword, myId])

  const tabs: readonly string[] = backendMode ? SERVER_TABS : DEMO_TABS

  const toggleLike = async (item: GalleryItem | DemoWork) => {
    if (!backendMode) {
      // 示例作品没有服务端，本地记个状态意思一下
      setLiked((current) => current.includes(item.id) ? current.filter((value) => value !== item.id) : [...current, item.id])
      return
    }
    if (!me) {
      showToast('请先登录后再点赞', 'info')
      return
    }
    try {
      const result = await toggleWorkLike(item.id)
      setWorks((current) => (current).map((work) => (
        work.id === item.id ? { ...work, likedByMe: result.liked, likes: result.likes } : work
      )))
      setPreview((current) => current && isServerItem(current) && current.id === item.id
        ? { ...current, likedByMe: result.liked, likes: result.likes }
        : current)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败', 'error')
    }
  }

  const removeMine = (item: GalleryItem) => {
    setConfirmDialog({
      title: '删除作品',
      message: '确定从作品广场删除这件作品吗？删除后其他人就看不到了。',
      confirmText: '删除',
      tone: 'danger',
      action: async () => {
        try {
          await deleteWork(item.id)
          showToast('已从作品广场删除', 'success')
          setPreview(null)
          await loadWorks()
        } catch (err) {
          showToast(err instanceof Error ? err.message : '删除失败', 'error')
        }
      },
    })
  }

  const useSamePrompt = (item: GalleryItem | DemoWork) => {
    setPrompt(item.prompt)
    showToast('提示词已填入，去创作同款吧', 'success')
    navigate('/studio')
  }

  const copyPrompt = async (item: GalleryItem | DemoWork) => {
    try {
      await navigator.clipboard.writeText(item.prompt)
      showToast('提示词已复制', 'success')
    } catch {
      showToast('复制失败，请手动选择复制', 'error')
    }
  }

  const submitComment = async () => {
    if (!previewWorkId || commentBusy) return
    const text = commentText.trim()
    if (!text) return showToast('请先输入评论内容', 'info')
    setCommentBusy(true)
    try {
      const result = await createWorkComment(previewWorkId, text)
      setComments((current) => [result.comment, ...current])
      setCommentTotal(result.total)
      setCommentText('')
      setWorks((current) => current.map((work) => work.id === previewWorkId ? { ...work, comments: result.total } : work))
      setPreview((current) => current && isServerItem(current) && current.id === previewWorkId ? { ...current, comments: result.total } : current)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '评论发布失败', 'error')
    } finally {
      setCommentBusy(false)
    }
  }

  const loadMoreComments = async () => {
    if (!previewWorkId || commentsLoading) return
    setCommentsLoading(true)
    try {
      const result = await listWorkComments(previewWorkId, comments.length)
      setComments((current) => [...current, ...result.comments])
      setCommentTotal(result.total)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '评论加载失败', 'error')
    } finally {
      setCommentsLoading(false)
    }
  }

  const removeComment = (comment: GalleryComment) => {
    if (!previewWorkId) return
    setConfirmDialog({
      title: '删除评论',
      message: '确定删除这条评论吗？',
      confirmText: '删除',
      tone: 'danger',
      action: async () => {
        const result = await deleteWorkComment(previewWorkId, comment.id)
        setComments((current) => current.filter((item) => item.id !== comment.id))
        setCommentTotal(result.total)
        setWorks((current) => current.map((work) => work.id === previewWorkId ? { ...work, comments: result.total } : work))
        setPreview((current) => current && isServerItem(current) && current.id === previewWorkId ? { ...current, comments: result.total } : current)
        showToast('评论已删除', 'success')
      },
    })
  }

  const reportComment = async (comment: GalleryComment) => {
    if (!previewWorkId) return
    if (!me) return showToast('请先登录后再举报', 'info')
    try {
      const result = await reportWorkComment(previewWorkId, comment.id)
      setComments((current) => current.map((item) => item.id === comment.id ? { ...item, reportedByMe: true } : item))
      showToast(result.duplicated ? '你已举报过这条评论' : '举报已提交，管理员会尽快处理', 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '举报失败', 'error')
    }
  }

  return (
    <AppShell title="作品广场" wide>
      {/* 工具行：Tab + （示例模式的风格筛选）+ 搜索 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-full border border-[#eceaf6] bg-white p-1">
          {tabs.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={`rounded-full px-4 py-1.5 text-[13px] font-medium transition ${
                tab === item ? 'bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] text-white shadow-sm' : 'text-[#6f6a94] hover:text-[#37335c]'
              }`}
            >
              {item}
            </button>
          ))}
        </div>
        {!backendMode && (
          <div className="flex gap-1.5">
            {STYLE_FILTERS.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setStyle(item)}
                className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
                  style === item ? 'bg-[#efedfd] text-[#6b5ce7] ring-1 ring-[#7c6cf6]/40' : 'bg-white text-[#8a86ac] ring-1 ring-[#eceaf6] hover:text-[#6b5ce7]'
                }`}
              >
                {item}
              </button>
            ))}
          </div>
        )}
        <div className="relative ml-auto">
          <IconSearch className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#b3aed0]" />
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索帖子或作者"
            className="w-56 rounded-full border border-[#eceaf6] bg-white py-2 pl-10 pr-4 text-[13px] outline-none transition placeholder:text-[#b3aed0] focus:border-[#7c6cf6] focus:ring-4 focus:ring-[#7c6cf6]/10"
          />
        </div>
      </div>

      {backendMode && (
        <p className="mt-3 text-xs text-[#a5a1c4]">
          在「生成结果」页点「发布帖子」，分享你的作品和创作故事。
        </p>
      )}

      {loadError && (
        <div className="mt-6 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">{loadError}</div>
      )}

      {/* 卡片网格 */}
      {loading ? (
        <div className="mt-6 rounded-3xl border border-[#eceaf6] bg-white py-20 text-center text-sm text-[#a5a1c4]">加载中…</div>
      ) : filteredWorks.length === 0 ? (
        <div className="mt-6 rounded-3xl border border-[#eceaf6] bg-white py-20 text-center text-sm text-[#a5a1c4]">
          {backendMode && tab === '我的'
            ? '你还没有发布过帖子；去生成结果页分享第一张作品吧'
            : '没有找到相关帖子，换个关键词试试'}
        </div>
      ) : (
        <div className="mt-6 columns-2 gap-4 md:columns-3 lg:columns-4 2xl:columns-5">
          {filteredWorks.map((work, index) => {
            const serverItem = isServerItem(work)
            const isLiked = serverItem ? work.likedByMe : liked.includes(work.id)
            const likes = serverItem ? work.likes : work.likes + (isLiked ? 1 : 0)
            const author = serverItem ? work.ownerName : work.author
            const isMine = serverItem && myId !== null && work.ownerId === myId
            return (
              <article key={work.id} className="group mb-5 break-inside-avoid overflow-hidden rounded-2xl bg-white transition hover:-translate-y-0.5">
                <button type="button" onClick={() => setPreview(work)} className="relative block w-full overflow-hidden">
                  <SafeImg
                    src={serverItem ? work.imageUrl : assetUrl(work.img)}
                    alt={work.title}
                    className={`w-full rounded-2xl object-cover transition duration-300 group-hover:scale-[1.015] ${index % 3 === 0 ? 'aspect-[4/5]' : index % 3 === 1 ? 'aspect-square' : 'aspect-[3/4]'}`}
                    fallbackClassName={`${index % 3 === 1 ? 'aspect-square' : 'aspect-[4/5]'} w-full rounded-2xl`}
                  />
                  {isMine && (
                    <span className="absolute left-3 top-3 rounded-full bg-[#7c6cf6]/90 px-2 py-0.5 text-[10px] font-medium text-white">我的</span>
                  )}
                </button>
                <div className="px-1 py-2.5">
                  <button type="button" onClick={() => setPreview(work)} className="line-clamp-2 w-full text-left text-[14px] font-semibold leading-5 text-[#37335c] hover:text-[#6b5ce7]">
                    {work.title}
                  </button>
                  <div className="flex items-center justify-between">
                    <span className="mt-2 flex min-w-0 items-center gap-1.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#7c6cf6] to-[#a78bfa] text-[10px] font-bold text-white">
                        {author.slice(0, 1)}
                      </span>
                      <span className="truncate text-[11px] text-[#8a86ac]">{author}</span>
                    </span>
                    <span className="mt-2 flex shrink-0 items-center gap-2.5 text-[11px] text-[#a5a1c4]">
                      <button
                        type="button"
                        onClick={() => void toggleLike(work)}
                        className={`flex items-center gap-1 transition ${isLiked ? 'text-[#f472b6]' : 'hover:text-[#f472b6]'}`}
                      >
                        <IconHeart className="h-3.5 w-3.5" filled={isLiked} />
                        {likes.toLocaleString()}
                      </button>
                      {serverItem && (
                        <span className="flex items-center gap-1">
                          <IconMessage className="h-3.5 w-3.5" />
                          {work.comments.toLocaleString()}
                        </span>
                      )}
                      {!serverItem && (
                        <span className="flex items-center gap-1">
                          <IconEye className="h-3.5 w-3.5" />
                          {work.views}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {/* 作品预览弹层 */}
      {preview && (
        <div className="animate-overlay-in fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm" onClick={() => setPreview(null)}>
          <div className="animate-modal-in flex h-[min(820px,calc(100vh-32px))] w-full max-w-6xl overflow-hidden rounded-3xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="hidden w-[58%] items-center justify-center bg-[#f7f7f8] p-5 sm:flex">
              <SafeImg src={isServerItem(preview) ? preview.imageUrl : assetUrl(preview.img)} alt={preview.title} loading="eager" className="max-h-full max-w-full rounded-2xl object-contain" fallbackClassName="h-full w-full rounded-2xl" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
              <div className="flex items-center gap-3 border-b border-[#f1eff6] px-6 py-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#7c6cf6] to-[#a78bfa] text-sm font-bold text-white">
                  {(isServerItem(preview) ? preview.ownerName : preview.author).slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-[#37335c]">{isServerItem(preview) ? preview.ownerName : preview.author}</p>
                  <p className="mt-0.5 text-[11px] text-[#a5a1c4]">
                    {isServerItem(preview) ? formatCommentTime(preview.createdAt) : preview.style}
                    {isServerItem(preview) && preview.model ? ` · ${preview.model}` : ''}
                  </p>
                </div>
                <button type="button" onClick={() => setPreview(null)} className="flex h-8 w-8 items-center justify-center rounded-full text-xl text-[#a5a1c4] hover:bg-[#f6f4fc] hover:text-[#5b5680]">×</button>
              </div>

              <div className="p-6 pb-3">
                <SafeImg src={isServerItem(preview) ? preview.imageUrl : assetUrl(preview.img)} alt={preview.title} loading="eager" className="mb-5 w-full rounded-2xl object-cover sm:hidden" fallbackClassName="mb-5 aspect-[4/5] w-full rounded-2xl sm:hidden" />
                <h2 className="text-xl font-bold leading-8 text-[#2f2b4c]">{preview.title}</h2>
                {preview.caption && <p className="mt-3 whitespace-pre-wrap text-[14px] leading-7 text-[#575273]">{preview.caption}</p>}

                <button type="button" onClick={() => setPromptVisible((current) => !current)} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-[#ded9ef] bg-[#faf9fe] px-4 py-2.5 text-sm font-semibold text-[#6b5ce7] transition hover:border-[#9f94df] hover:bg-[#f5f2ff]">
                  <IconSparkle className="h-4 w-4" />
                  {promptVisible ? '收起提示词' : '查看提示词'}
                </button>
                {promptVisible && (
                  <div className="mt-3 rounded-2xl bg-[#f7f5fd] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[11px] font-semibold tracking-wider text-[#8a82b4]">创作提示词</p>
                      <button type="button" onClick={() => void copyPrompt(preview)} className="flex items-center gap-1 text-[11px] text-[#7c6cf6] hover:text-[#5f50dc]">
                        <IconCopy className="h-3.5 w-3.5" />
                        复制
                      </button>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-6 text-[#5b5680]">{preview.prompt}</p>
                    <button type="button" onClick={() => useSamePrompt(preview)} className="mt-3 rounded-full bg-[#7c6cf6] px-4 py-2 text-xs font-semibold text-white hover:bg-[#6b5ce7]">用这个提示词画同款</button>
                  </div>
                )}
              </div>
              {isServerItem(preview) && (
                <div className="mx-6 flex items-center gap-4 border-y border-[#f1eff6] py-3 text-xs text-[#a5a1c4]">
                  <button type="button" onClick={() => void toggleLike(preview)} className={`flex items-center gap-1.5 transition hover:text-[#f472b6] ${preview.likedByMe ? 'text-[#f472b6]' : ''}`}>
                    <IconHeart className="h-3.5 w-3.5" filled={preview.likedByMe} />
                    {preview.likes.toLocaleString()} 人喜欢
                  </button>
                  <span className="flex items-center gap-1.5">
                    <IconMessage className="h-3.5 w-3.5" />
                    {commentTotal} 条评论
                  </span>
                </div>
              )}

              {isServerItem(preview) && (
                <section className="px-6 py-5">
                  <h4 className="text-sm font-bold text-[#37335c]">评论 <span className="font-normal text-[#a5a1c4]">{commentTotal}</span></h4>
                  {me ? (
                    <div className="mt-3 rounded-2xl border border-[#e5e1f5] bg-[#faf9fe] p-3 focus-within:border-[#9b8cf8]">
                      <textarea
                        id="gallery-comment-box"
                        value={commentText}
                        onChange={(event) => setCommentText(event.target.value)}
                        maxLength={200}
                        rows={2}
                        placeholder="友善交流，说说你的看法…"
                        className="w-full resize-none bg-transparent text-[13px] leading-5 text-[#4f4a73] outline-none placeholder:text-[#b3aed0]"
                      />
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-[11px] text-[#b3aed0]">{Array.from(commentText).length}/200</span>
                        <button type="button" disabled={commentBusy || !commentText.trim()} onClick={() => void submitComment()} className="rounded-full bg-[#7c6cf6] px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-[#6b5ce7] disabled:cursor-not-allowed disabled:opacity-40">
                          {commentBusy ? '发布中…' : '发布评论'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" onClick={() => navigate('/login')} className="mt-3 w-full rounded-xl bg-[#faf9fe] px-4 py-3 text-left text-xs text-[#7c6cf6] hover:bg-[#f4f1ff]">
                      登录后可以参与评论
                    </button>
                  )}

                  <div className="mt-3 space-y-3">
                    {comments.map((comment) => (
                      <article key={comment.id} className="flex gap-2.5">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#7c6cf6] to-[#a78bfa] text-[11px] font-bold text-white">
                          {comment.userName.slice(0, 1)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-xs font-medium text-[#5b5680]">{comment.userName}</span>
                            <span className="shrink-0 text-[10px] text-[#b3aed0]">{formatCommentTime(comment.createdAt)}</span>
                          </div>
                          <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-5 text-[#575273]">{comment.text}</p>
                          <div className="mt-1 flex gap-3 text-[10px] text-[#a5a1c4]">
                            {comment.canDelete && <button type="button" onClick={() => removeComment(comment)} className="hover:text-red-500">删除</button>}
                            {!comment.canDelete && me && (
                              <button type="button" disabled={comment.reportedByMe} onClick={() => void reportComment(comment)} className="hover:text-red-500 disabled:cursor-default disabled:text-[#c9c6da]">
                                {comment.reportedByMe ? '已举报' : '举报'}
                              </button>
                            )}
                          </div>
                        </div>
                      </article>
                    ))}
                    {commentsLoading && <p className="py-3 text-center text-xs text-[#a5a1c4]">评论加载中…</p>}
                    {!commentsLoading && commentTotal === 0 && <p className="py-4 text-center text-xs text-[#a5a1c4]">还没有评论，来说第一句吧</p>}
                    {!commentsLoading && comments.length < commentTotal && (
                      <button type="button" onClick={() => void loadMoreComments()} className="w-full rounded-xl py-2 text-xs text-[#7c6cf6] hover:bg-[#faf9fe]">加载更多</button>
                    )}
                  </div>
                </section>
              )}

              <div className="mt-auto flex gap-2.5 border-t border-[#f1eff6] px-6 py-4">
                {isServerItem(preview) && (
                  <>
                    <button type="button" onClick={() => void toggleLike(preview)} className={`flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium transition ${preview.likedByMe ? 'border-pink-200 bg-pink-50 text-pink-500' : 'border-[#ded9ef] text-[#6f6a94] hover:border-pink-200 hover:text-pink-500'}`}>
                      <IconHeart className="h-4 w-4" filled={preview.likedByMe} />
                      {preview.likedByMe ? '已喜欢' : '喜欢'}
                    </button>
                    <button type="button" onClick={() => me ? document.getElementById('gallery-comment-box')?.focus() : navigate('/login')} className="flex items-center gap-1.5 rounded-full border border-[#ded9ef] px-4 py-2 text-sm font-medium text-[#6f6a94] hover:border-[#9f94df] hover:text-[#6b5ce7]">
                      <IconMessage className="h-4 w-4" />
                      评论
                    </button>
                  </>
                )}
                {isServerItem(preview) && myId !== null && preview.ownerId === myId && (
                  <button
                    type="button"
                    onClick={() => removeMine(preview)}
                    className="flex items-center justify-center gap-1.5 rounded-full border border-red-200 px-4 py-2.5 text-sm font-medium text-red-500 transition hover:bg-red-50"
                  >
                    <IconTrash className="h-4 w-4" />
                    删除
                  </button>
                )}
                {!isServerItem(preview) && <span className="self-center text-xs text-[#a5a1c4]">示例帖子 · 点击「查看提示词」可复制或画同款</span>}
              </div>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  )
}
