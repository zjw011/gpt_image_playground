// 积分与卡密：积分设置 + 卡密表格（搜索/筛选/一键复制/作废/删除/导出）。
//
// 卡密是这张页面的主角：参考发卡后台的惯例做成完整表格，
// 「被谁用了」由服务端按用户名册映射好直接回传（usedByName）。
// 复制必须带降级方案——管理后台经常跑在 http://IP 上，那是非安全上下文，
// navigator.clipboard 不存在，得退回 execCommand。
import { useCallback, useEffect, useMemo, useState } from 'react'
import AdminShell from './AdminShell'
import {
  getAdminCredits, updateCredits,
  getCardTable, generateCards, voidCards, restoreCards, deleteCards,
  type AdminCardRow, type CardBatch, type CardsOverview, type CardStatus,
} from '../../lib/adminApi'
import { IconPlus, IconRefresh, IconCopy, IconSearch, IconTrash, IconCheck } from '../icons'

const PAGE_SIZES = [20, 50, 100, 200]
const STATUS_LABELS: Record<CardStatus | 'all', string> = {
  all: '全部状态',
  unused: '未使用',
  used: '已使用',
  void: '已作废',
}
const STATUS_TONE: Record<CardStatus, string> = {
  unused: 'bg-blue-50 text-blue-600',
  used: 'bg-emerald-50 text-emerald-600',
  void: 'bg-slate-100 text-slate-500',
}

const fmtTime = (at?: number) => {
  if (!at) return '—'
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 剪贴板写入：安全上下文用 Clipboard API，其余（http://IP）退回 execCommand。
 *  两级都失败（老内核/特殊环境）时弹 prompt 让用户手动复制——保证"一键复制"永远有出路。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 走降级 */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    if (ok) return true
  } catch { /* 走最后一级 */ }
  // 最后一级：手动复制。取消（返回 null）才算失败。
  const manual = window.prompt('自动复制不可用，请全选后手动复制：', text)
  return manual !== null
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export default function CreditsPage() {
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 积分设置
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [costPerImage, setCostPerImage] = useState('1')
  const [signupBonus, setSignupBonus] = useState('50')
  const [purchaseUrl, setPurchaseUrl] = useState('')
  // 充值套餐草稿：名称/价格/积分三列，随积分设置一起保存
  const [packs, setPacks] = useState<Array<{ name: string, price: string, credits: string }>>([])

  // 列表状态
  const [rows, setRows] = useState<AdminCardRow[]>([])
  const [batches, setBatches] = useState<CardBatch[]>([])
  const [overview, setOverview] = useState<CardsOverview | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  // 筛选条件：改动先落在 draft，点「筛选」或回车才真正生效（和发卡后台的习惯一致）
  const [draftKeyword, setDraftKeyword] = useState('')
  const [draftStatus, setDraftStatus] = useState<CardStatus | 'all'>('all')
  const [draftBatch, setDraftBatch] = useState('')
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<CardStatus | 'all'>('all')
  const [batch, setBatch] = useState('')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(50)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [copiedCode, setCopiedCode] = useState<string | null>(null)

  // 生成弹层
  const [genOpen, setGenOpen] = useState(false)
  const [genCount, setGenCount] = useState('10')
  const [genCredits, setGenCredits] = useState('100')
  const [genNote, setGenNote] = useState('')

  const toast = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(null), 2800) }

  const loadCredits = useCallback(async (fresh = false) => {
    try {
      const result = await getAdminCredits(fresh ? 0 : 8000)
      const settings = (result as { settings?: Record<string, unknown> }).settings ?? {}
      setEnabled(settings.enabled !== false)
      setCostPerImage(String(settings.costPerImage ?? 1))
      setSignupBonus(String(settings.signupBonus ?? 0))
      setPurchaseUrl(String(settings.purchaseUrl ?? ''))
      const rawPacks = Array.isArray(settings.packs) ? settings.packs : []
      setPacks(rawPacks.map((pack) => ({
        name: String((pack as Record<string, unknown>).name ?? ''),
        price: String((pack as Record<string, unknown>).price ?? ''),
        credits: String((pack as Record<string, unknown>).credits ?? ''),
      })))
    } catch { /* 积分设置拉不到不拦住卡密列表 */ }
  }, [])

  const loadCards = useCallback(async (filter: { keyword: string, status: CardStatus | 'all', batch: string, page: number, pageSize: number }) => {
    setLoading(true)
    try {
      const result = await getCardTable({
        keyword: filter.keyword,
        status: filter.status === 'all' ? '' : filter.status,
        batch: filter.batch,
        limit: filter.pageSize,
        offset: filter.page * filter.pageSize,
      })
      setRows(result.cards)
      setBatches(result.batches)
      setOverview(result.overview)
      setTotal(result.total)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadCredits() }, [loadCredits])
  useEffect(() => { void loadCards({ keyword, status, batch, page, pageSize }) }, [keyword, status, batch, page, pageSize, loadCards])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const applyFilters = () => {
    setPage(0)
    setKeyword(draftKeyword.trim())
    setStatus(draftStatus)
    setBatch(draftBatch)
  }
  const resetFilters = () => {
    setDraftKeyword(''); setDraftStatus('all'); setDraftBatch('')
    setKeyword(''); setStatus('all'); setBatch('')
    setPage(0)
  }

  const doCopy = async (text: string, mark?: string) => {
    const ok = await copyText(text)
    if (ok) {
      toast(mark ? `已复制 ${mark}` : '已复制')
      if (mark) { setCopiedCode(mark); setTimeout(() => setCopiedCode(null), 1600) }
    } else {
      setError('复制失败：浏览器拒绝了剪贴板访问，请手动选中复制')
    }
  }

  const copyPageCodes = async () => {
    if (!rows.length) return
    const ok = await copyText(rows.map((row) => row.code).join('\n'))
    toast(ok ? `已复制本页 ${rows.length} 个卡密` : '复制失败，请手动复制')
  }

  const exportTxt = async () => {
    try {
      const query = new URLSearchParams()
      if (status !== 'all') query.set('status', status)
      if (batch) query.set('batch', batch)
      const response = await fetch(`/api/admin/cards/export?${query.toString()}`)
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error((payload as { error?: string }).error || `HTTP ${response.status}`)
      }
      const text = await response.text()
      const stamp = new Date().toISOString().slice(0, 10)
      downloadText(`卡密-${stamp}${batch ? `-${batch}` : ''}${status !== 'all' ? `-${status}` : ''}.txt`, text)
      toast('已导出 TXT')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const generate = async () => {
    setBusy(true); setError(null)
    try {
      const result = await generateCards({ count: Number(genCount) || 0, credits: Number(genCredits) || 0, note: genNote.trim() || undefined })
      setGenOpen(false)
      setGenNote('')
      // 生成完直接定位到这一批，管理员马上能复制/导出
      setDraftBatch(result.batchId); setBatch(result.batchId)
      setDraftStatus('all'); setStatus('all')
      setPage(0)
      toast(`已生成 ${result.count} 张卡密（面值 ${result.credits} 积分），已筛选出这一批`)
      await loadCards({ keyword: '', status: 'all', batch: result.batchId, page: 0, pageSize })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  const act = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(null)
    try {
      await action()
      toast(success)
      setSelected(new Set())
      await loadCards({ keyword, status, batch, page, pageSize })
      void loadCredits(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  const saveCredits = async () => {
    setBusy(true); setError(null)
    try {
      await updateCredits({
        credits: {
          enabled,
          costPerImage: Number(costPerImage) || 0,
          signupBonus: Number(signupBonus) || 0,
          purchaseUrl,
          packs: packs
            .map((pack) => ({ name: pack.name.trim(), price: pack.price.trim(), credits: Number(pack.credits) || 0 }))
            .filter((pack) => pack.name && pack.credits > 0),
        },
      })
      toast('积分设置已保存')
      await loadCredits(true)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const allPageSelected = rows.length > 0 && rows.every((row) => selected.has(row.code))
  const toggleAll = () => {
    const next = new Set(selected)
    if (allPageSelected) rows.forEach((row) => next.delete(row.code))
    else rows.forEach((row) => next.add(row.code))
    setSelected(next)
  }
  const toggleRow = (code: string) => {
    const next = new Set(selected)
    next.has(code) ? next.delete(code) : next.add(code)
    setSelected(next)
  }

  const selectedRows = useMemo(() => rows.filter((row) => selected.has(row.code)), [rows, selected])
  const selectedUnused = selectedRows.filter((row) => row.status === 'unused')
  const selectedVoid = selectedRows.filter((row) => row.status === 'void')
  const selectedRemovable = selectedRows.filter((row) => row.status !== 'used')

  const stats = useMemo(() => ([
    { label: '卡密总数', value: overview?.total ?? 0 },
    { label: '未使用', value: overview?.unused ?? 0, tone: 'text-blue-600' },
    { label: '已使用', value: overview?.used ?? 0, tone: 'text-emerald-600' },
    { label: '已作废', value: overview?.void ?? 0, tone: 'text-slate-400' },
    { label: '未兑积分', value: overview?.unusedCredits ?? 0 },
    { label: '已兑积分', value: overview?.redeemedCredits ?? 0 },
  ]), [overview])

  return (
    <AdminShell>
      {notice && <div className="mb-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      {error && <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}

      {/* 库存概览 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {stats.map((card) => (
          <div key={card.label} className="rounded-2xl border border-[#e6ebf2] bg-white px-4 py-3 shadow-sm">
            <p className="text-xs font-medium text-[#94a3b8]">{card.label}</p>
            <p className={`mt-1 text-xl font-bold ${card.tone ?? 'text-[#1e293b]'}`}>{card.value.toLocaleString()}</p>
          </div>
        ))}
      </div>

      {/* 工具栏 */}
      <div className="mt-4 rounded-2xl border border-[#e6ebf2] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[15rem] flex-1">
            <IconSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94a3b8]" />
            <input
              value={draftKeyword}
              onChange={(event) => setDraftKeyword(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') applyFilters() }}
              placeholder="搜索卡密 / 批次 / 备注"
              className="w-full rounded-lg border border-[#e2e8f0] py-2 pl-9 pr-3 text-sm outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15"
            />
          </div>
          <select
            value={draftStatus}
            onChange={(event) => setDraftStatus(event.target.value as CardStatus | 'all')}
            className="rounded-lg border border-[#e2e8f0] px-3 py-2 text-sm outline-none focus:border-[#3b82f6]"
          >
            {(Object.keys(STATUS_LABELS) as Array<CardStatus | 'all'>).map((key) => (
              <option key={key} value={key}>{STATUS_LABELS[key]}</option>
            ))}
          </select>
          <select
            value={draftBatch}
            onChange={(event) => setDraftBatch(event.target.value)}
            className="max-w-[14rem] rounded-lg border border-[#e2e8f0] px-3 py-2 text-sm outline-none focus:border-[#3b82f6]"
          >
            <option value="">全部批次</option>
            {batches.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id.slice(2, 12)}…（{item.count} 张 / {item.credits} 积分）
              </option>
            ))}
          </select>
          <button type="button" onClick={applyFilters} className="rounded-lg bg-[#2563eb] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8]">筛选</button>
          <button type="button" onClick={resetFilters} className="rounded-lg border border-[#e2e8f0] px-4 py-2 text-sm font-medium text-[#475569] transition hover:bg-[#f8fafc]">重置</button>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setSettingsOpen((value) => !value)} className="rounded-lg border border-[#e2e8f0] px-4 py-2 text-sm font-medium text-[#475569] transition hover:bg-[#f8fafc]">
              积分设置
            </button>
            <button type="button" onClick={copyPageCodes} disabled={!rows.length} className="rounded-lg border border-[#e2e8f0] px-4 py-2 text-sm font-medium text-[#475569] transition hover:bg-[#f8fafc] disabled:opacity-50">
              复制本页卡密
            </button>
            <button type="button" onClick={exportTxt} className="rounded-lg border border-[#e2e8f0] px-4 py-2 text-sm font-medium text-[#475569] transition hover:bg-[#f8fafc]">
              导出 TXT
            </button>
            <button type="button" onClick={() => void loadCards({ keyword, status, batch, page, pageSize })} className="flex items-center gap-1.5 rounded-lg border border-[#e2e8f0] px-3 py-2 text-sm font-medium text-[#475569] transition hover:bg-[#f8fafc]">
              <IconRefresh className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => setGenOpen(true)} className="flex items-center gap-1.5 rounded-lg bg-[#2563eb] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8]">
              <IconPlus className="h-4 w-4" />生成卡密
            </button>
          </div>
        </div>

        {/* 选中后的批量操作条 */}
        {selected.size > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-[#eff6ff] px-4 py-2.5 text-sm">
            <span className="font-medium text-[#1e293b]">已选 {selected.size} 张</span>
            {selectedUnused.length > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => { if (window.confirm(`确定作废选中的 ${selectedUnused.length} 张未使用卡密吗？作废后无法兑换，但可恢复。`)) void act(() => voidCards(selectedUnused.map((row) => row.code)), `已作废 ${selectedUnused.length} 张`) }}
                className="rounded-lg border border-amber-200 bg-white px-3 py-1.5 text-xs font-medium text-amber-600 transition hover:bg-amber-50 disabled:opacity-50"
              >
                作废所选（{selectedUnused.length}）
              </button>
            )}
            {selectedVoid.length > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => restoreCards(selectedVoid.map((row) => row.code)), `已恢复 ${selectedVoid.length} 张`)}
                className="rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-xs font-medium text-emerald-600 transition hover:bg-emerald-50 disabled:opacity-50"
              >
                恢复所选（{selectedVoid.length}）
              </button>
            )}
            {selectedRemovable.length > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => { if (window.confirm(`确定删除选中的 ${selectedRemovable.length} 张卡密吗？已兑换的会自动跳过并保留（财务凭证）。`)) void act(() => deleteCards(selectedRemovable.map((row) => row.code)), '删除完成') }}
                className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-500 transition hover:bg-red-50 disabled:opacity-50"
              >
                删除所选（{selectedRemovable.length}）
              </button>
            )}
            <button
              type="button"
              onClick={async () => { const ok = await copyText(selectedRows.map((row) => row.code).join('\n')); toast(ok ? `已复制 ${selectedRows.length} 个卡密` : '复制失败') }}
              className="rounded-lg border border-[#e2e8f0] bg-white px-3 py-1.5 text-xs font-medium text-[#475569] transition hover:bg-[#f8fafc]"
            >
              复制所选
            </button>
            <button type="button" onClick={() => setSelected(new Set())} className="ml-auto text-xs text-[#94a3b8] transition hover:text-[#64748b]">取消选择</button>
          </div>
        )}

        {/* 卡密表格 */}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[54rem] text-sm">
            <thead>
              <tr className="border-b border-[#f1f5f9] text-left text-xs text-[#94a3b8]">
                <th className="w-10 px-3 py-2.5">
                  <input type="checkbox" checked={allPageSelected} onChange={toggleAll} className="h-4 w-4 rounded accent-[#2563eb]" />
                </th>
                <th className="px-3 py-2.5 font-medium">卡密</th>
                <th className="px-3 py-2.5 text-right font-medium">面值</th>
                <th className="px-3 py-2.5 font-medium">状态</th>
                <th className="px-3 py-2.5 font-medium">使用者</th>
                <th className="px-3 py-2.5 font-medium">兑换时间</th>
                <th className="px-3 py-2.5 font-medium">创建时间</th>
                <th className="px-3 py-2.5 font-medium">备注</th>
                <th className="px-3 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr><td colSpan={9} className="py-12 text-center text-sm text-[#94a3b8]">加载中…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={9} className="py-12 text-center text-sm text-[#94a3b8]">没有符合条件的卡密，换个筛选条件或先生成一批</td></tr>
              )}
              {rows.map((row) => (
                <tr key={row.code} className={`border-b border-[#f8fafc] transition hover:bg-[#f8fafc] ${selected.has(row.code) ? 'bg-[#eff6ff]/60' : ''}`}>
                  <td className="px-3 py-2.5">
                    <input type="checkbox" checked={selected.has(row.code)} onChange={() => toggleRow(row.code)} className="h-4 w-4 rounded accent-[#2563eb]" />
                  </td>
                  <td className="px-3 py-2.5">
                    <button
                      type="button"
                      title="点击复制"
                      onClick={() => void doCopy(row.code, row.code)}
                      className="group flex items-center gap-1.5 font-mono text-[13px] text-[#334155] transition hover:text-[#2563eb]"
                    >
                      {row.code}
                      {copiedCode === row.code
                        ? <IconCheck className="h-3.5 w-3.5 text-emerald-500" />
                        : <IconCopy className="h-3.5 w-3.5 text-[#cbd5e1] opacity-0 transition group-hover:opacity-100" />}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-right font-medium text-[#334155]">{row.credits}</td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_TONE[row.status]}`}>
                      {STATUS_LABELS[row.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-[#475569]">
                    {row.status === 'used' ? (row.usedByName || '未知用户') : <span className="text-[#cbd5e1]">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-[#64748b]">{row.usedAt ? fmtTime(row.usedAt) : <span className="text-[#cbd5e1]">—</span>}</td>
                  <td className="px-3 py-2.5 text-xs text-[#94a3b8]">{fmtTime(row.createdAt)}</td>
                  <td className="max-w-[10rem] truncate px-3 py-2.5 text-xs text-[#94a3b8]" title={row.note}>{row.note || '—'}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1 text-xs">
                      <button type="button" onClick={() => void doCopy(row.code, row.code)} className="rounded px-2 py-1 text-[#2563eb] transition hover:bg-[#eff6ff]">复制</button>
                      {row.status === 'unused' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => { if (window.confirm('确定作废这张卡密吗？作废后无法兑换，但可以恢复。')) void act(() => voidCards([row.code]), '已作废') }}
                          className="rounded px-2 py-1 text-amber-600 transition hover:bg-amber-50 disabled:opacity-50"
                        >作废</button>
                      )}
                      {row.status === 'void' && (
                        <button type="button" disabled={busy} onClick={() => void act(() => restoreCards([row.code]), '已恢复为未使用')} className="rounded px-2 py-1 text-emerald-600 transition hover:bg-emerald-50 disabled:opacity-50">恢复</button>
                      )}
                      {row.status !== 'used' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => { if (window.confirm('确定删除这张卡密吗？已兑换的卡无法删除。')) void act(() => deleteCards([row.code]), '已删除') }}
                          className="rounded px-2 py-1 text-red-500 transition hover:bg-red-50 disabled:opacity-50"
                        >删除</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-[#64748b]">
          <span>共 <strong className="text-[#1e293b]">{total.toLocaleString()}</strong> 张{batch && ' · 已按批次筛选'}</span>
          <div className="flex items-center gap-2">
            <select
              value={pageSize}
              onChange={(event) => { setPageSize(Number(event.target.value)); setPage(0) }}
              className="rounded-lg border border-[#e2e8f0] px-2 py-1.5 text-xs outline-none focus:border-[#3b82f6]"
            >
              {PAGE_SIZES.map((size) => <option key={size} value={size}>{size} 条/页</option>)}
            </select>
            <button
              type="button"
              disabled={page <= 0}
              onClick={() => setPage((value) => Math.max(0, value - 1))}
              className="rounded-lg border border-[#e2e8f0] px-3 py-1.5 text-xs font-medium transition hover:bg-[#f8fafc] disabled:opacity-40"
            >上一页</button>
            <span className="text-xs">第 {page + 1} / {totalPages} 页</span>
            <button
              type="button"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((value) => Math.min(totalPages - 1, value + 1))}
              className="rounded-lg border border-[#e2e8f0] px-3 py-1.5 text-xs font-medium transition hover:bg-[#f8fafc] disabled:opacity-40"
            >下一页</button>
          </div>
        </div>
      </div>

      {/* 积分设置（折叠面板：卡密表是主角，设置收起来） */}
      {settingsOpen && (
        <div className="mt-4 rounded-2xl border border-[#e6ebf2] bg-white p-5 shadow-sm">
          <h3 className="text-sm font-bold">积分设置</h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <label className="flex items-center gap-2 pt-1 text-sm">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 rounded accent-[#2563eb]" />
              启用积分制
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-[#475569]">每张图消耗积分</span>
              <input type="number" min="0" value={costPerImage} onChange={(e) => setCostPerImage(e.target.value)} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-[#475569]">注册赠送积分</span>
              <input type="number" min="0" value={signupBonus} onChange={(e) => setSignupBonus(e.target.value)} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-[#475569]">卡密购买链接（可选）</span>
              <input value={purchaseUrl} onChange={(e) => setPurchaseUrl(e.target.value)} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" placeholder="https://…" />
            </label>
          </div>

          {/* 充值套餐：价格随你定，用户在「积分充值」页看到的就是这几行 */}
          <div className="mt-6 border-t border-[#f1f5f9] pt-5">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-bold">充值套餐</h4>
              <button
                type="button"
                onClick={() => setPacks((current) => [...current, { name: '', price: '', credits: '' }])}
                className="flex items-center gap-1 rounded-lg border border-[#e2e8f0] px-3 py-1.5 text-xs font-medium text-[#475569] transition hover:bg-[#f8fafc]"
              >
                <IconPlus className="h-3.5 w-3.5" />
                加一档
              </button>
            </div>
            <p className="mt-1 text-xs text-[#94a3b8]">最多 12 档。第 3 档会带「推荐」角标；留空或积分为 0 的行保存时会被忽略。</p>
            <div className="mt-3 space-y-2">
              {packs.length === 0 && <p className="rounded-lg bg-[#f8fafc] px-4 py-3 text-xs text-[#94a3b8]">还没有套餐，点「加一档」创建</p>}
              {packs.map((pack, idx) => (
                <div key={idx} className="flex flex-wrap items-center gap-2">
                  <input
                    value={pack.name}
                    onChange={(e) => setPacks((current) => current.map((item, i) => i === idx ? { ...item, name: e.target.value } : item))}
                    placeholder="档位名，如 100 积分"
                    className="w-40 rounded-lg border border-[#e2e8f0] px-3 py-2 text-sm outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15"
                  />
                  <input
                    value={pack.price}
                    onChange={(e) => setPacks((current) => current.map((item, i) => i === idx ? { ...item, price: e.target.value } : item))}
                    placeholder="价格，如 ¥0.5"
                    className="w-32 rounded-lg border border-[#e2e8f0] px-3 py-2 text-sm outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15"
                  />
                  <input
                    type="number"
                    min="1"
                    value={pack.credits}
                    onChange={(e) => setPacks((current) => current.map((item, i) => i === idx ? { ...item, credits: e.target.value } : item))}
                    placeholder="积分"
                    className="w-28 rounded-lg border border-[#e2e8f0] px-3 py-2 text-sm outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15"
                  />
                  <button
                    type="button"
                    onClick={() => setPacks((current) => current.filter((_, i) => i !== idx))}
                    className="rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-500 transition hover:bg-red-50"
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          </div>

          <button type="button" onClick={saveCredits} disabled={busy} className="mt-5 rounded-lg bg-[#2563eb] px-5 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8] disabled:opacity-50">保存设置</button>
        </div>
      )}

      {/* 生成弹层 */}
      {genOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setGenOpen(false)}>
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
          <div className="relative z-10 w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <h3 className="text-base font-bold">生成卡密</h3>
            <p className="mt-1 text-xs text-[#94a3b8]">生成后自动筛选出这一批，可直接复制或导出发给用户</p>
            <div className="mt-4 space-y-4">
              <label className="block text-sm">
                <span className="mb-1.5 block font-medium text-[#475569]">数量（单批最多 2000）</span>
                <input type="number" min="1" max="2000" value={genCount} onChange={(e) => setGenCount(e.target.value)} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" />
              </label>
              <label className="block text-sm">
                <span className="mb-1.5 block font-medium text-[#475569]">每张面值（积分）</span>
                <input type="number" min="1" value={genCredits} onChange={(e) => setGenCredits(e.target.value)} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" />
              </label>
              <label className="block text-sm">
                <span className="mb-1.5 block font-medium text-[#475569]">备注（可选，会标在每张卡上）</span>
                <input value={genNote} onChange={(e) => setGenNote(e.target.value)} maxLength={120} placeholder="例如：6 月活动" className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setGenOpen(false)} className="rounded-lg border border-[#e2e8f0] px-4 py-2 text-sm font-medium text-[#475569] transition hover:bg-[#f8fafc]">取消</button>
              <button type="button" onClick={generate} disabled={busy} className="rounded-lg bg-[#2563eb] px-5 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8] disabled:opacity-50">生成</button>
            </div>
          </div>
        </div>
      )}
    </AdminShell>
  )
}
