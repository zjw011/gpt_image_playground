import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../../store'
import {
  deleteAdminGalleryComment,
  getAdminGalleryComments,
  setAdminGalleryCommentHidden,
  type AdminGalleryComment,
} from '../../lib/adminApi'
import { IconRefresh, IconSearch, IconTrash } from '../icons'
import AdminShell from './AdminShell'

const FILTERS = [
  { key: 'reported', label: '被举报' },
  { key: 'visible', label: '已公开' },
  { key: 'hidden', label: '已隐藏' },
  { key: 'all', label: '全部' },
] as const

const formatTime = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })

export default function CommentsPage() {
  const setConfirmDialog = useStore((state) => state.setConfirmDialog)
  const showToast = useStore((state) => state.showToast)
  const [status, setStatus] = useState<(typeof FILTERS)[number]['key']>('reported')
  const [keyword, setKeyword] = useState('')
  const [rows, setRows] = useState<AdminGalleryComment[]>([])
  const [total, setTotal] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const result = await getAdminGalleryComments({ status, keyword: keyword.trim(), limit: 100 })
      setRows(result.comments)
      setTotal(result.total)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [keyword, status])

  useEffect(() => { void load() }, [load])

  const toggleHidden = async (row: AdminGalleryComment) => {
    try {
      await setAdminGalleryCommentHidden(row.id, !row.hidden)
      showToast(row.hidden ? '评论已恢复公开' : '评论已隐藏', 'success')
      await load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败', 'error')
    }
  }

  const remove = (row: AdminGalleryComment) => {
    setConfirmDialog({
      title: '删除评论',
      message: '确定永久删除这条评论吗？删除后无法恢复。',
      confirmText: '删除',
      tone: 'danger',
      action: async () => {
        await deleteAdminGalleryComment(row.id)
        showToast('评论已删除', 'success')
        await load()
      },
    })
  }

  return (
    <AdminShell>
      <div className="rounded-2xl border border-[#e6ebf2] bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#eef2f7] p-5">
          <div>
            <h2 className="text-base font-bold text-[#1e293b]">作品评论</h2>
            <p className="mt-1 text-xs text-[#94a3b8]">举报优先展示，隐藏后前台立即不可见</p>
          </div>
          <button type="button" onClick={() => void load()} className="flex items-center gap-1.5 rounded-lg border border-[#dbe3ee] px-3 py-2 text-sm text-[#64748b] hover:bg-[#f8fafc]">
            <IconRefresh className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>

        <div className="flex flex-wrap gap-3 border-b border-[#eef2f7] p-4">
          <div className="flex gap-1 rounded-lg bg-[#f1f5f9] p-1">
            {FILTERS.map((item) => (
              <button key={item.key} type="button" onClick={() => setStatus(item.key)} className={`rounded-md px-3 py-1.5 text-xs font-medium ${status === item.key ? 'bg-white text-[#2563eb] shadow-sm' : 'text-[#64748b]'}`}>
                {item.label}
              </button>
            ))}
          </div>
          <div className="relative min-w-[240px] flex-1">
            <IconSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94a3b8]" />
            <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索评论内容或用户" className="w-full rounded-lg border border-[#dbe3ee] py-2 pl-9 pr-3 text-sm outline-none focus:border-[#60a5fa]" />
          </div>
          <span className="self-center text-xs text-[#94a3b8]">共 {total} 条</span>
        </div>

        {error && <div className="m-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}
        {!busy && !rows.length ? (
          <div className="py-20 text-center text-sm text-[#94a3b8]">暂无符合条件的评论</div>
        ) : (
          <div className="divide-y divide-[#eef2f7]">
            {rows.map((row) => (
              <div key={row.id} className="grid gap-3 p-4 md:grid-cols-[150px_minmax(0,1fr)_130px_180px] md:items-center">
                <div>
                  <p className="text-sm font-medium text-[#334155]">{row.userName}</p>
                  <p className="mt-1 text-[11px] text-[#94a3b8]">{formatTime(row.createdAt)}</p>
                </div>
                <div className="min-w-0">
                  <p className={`whitespace-pre-wrap break-words text-sm leading-6 ${row.hidden ? 'text-[#94a3b8] line-through' : 'text-[#475569]'}`}>{row.text}</p>
                  <p className="mt-1 truncate text-[11px] text-[#94a3b8]">作品 {row.workId}</p>
                </div>
                <div className="text-sm">
                  {row.reports > 0 ? <span className="rounded-full bg-red-50 px-2.5 py-1 text-xs text-red-500">{row.reports} 次举报</span> : <span className="text-xs text-[#94a3b8]">无举报</span>}
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => void toggleHidden(row)} className="rounded-lg border border-[#dbe3ee] px-3 py-1.5 text-xs text-[#475569] hover:bg-[#f8fafc]">
                    {row.hidden ? '恢复' : '隐藏'}
                  </button>
                  <button type="button" onClick={() => remove(row)} className="flex items-center gap-1 rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-500 hover:bg-red-50">
                    <IconTrash className="h-3.5 w-3.5" />
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminShell>
  )
}
