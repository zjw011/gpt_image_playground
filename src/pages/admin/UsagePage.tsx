// 用量与健康：渠道维度的成功率/时延、按天趋势、最近请求明细。
// 数据来自 usage 缓存（进程内累积、按 5 秒防抖落盘），所以这里也提供「清空统计」。
import { useCallback, useEffect, useState } from 'react'
import AdminShell from './AdminShell'
import { getAdminUsage, resetAdminUsage } from '../../lib/adminApi'
import { IconRefresh, IconTrash } from '../icons'

interface UsageChannel {
  id: string
  name: string
  exists: boolean
  total: number
  ok: number
  fail: number
  avgLatencyMs: number
  lastOkAt?: number
  lastFailAt?: number
  state?: string
  lastError?: string
}

interface UsageDay { day: string, total: number, ok: number, fail: number }
interface UsageEvent {
  channelId: string
  channelName: string
  userName?: string
  ok?: boolean
  status?: number | string
  latencyMs?: number
  at?: number
  error?: string
  [key: string]: unknown
}

interface UsageData {
  channels: UsageChannel[]
  users: Array<{ id: string, name: string, total: number, ok: number, fail: number }>
  days: UsageDay[]
  events: UsageEvent[]
  totals: { total: number, ok: number, fail: number }
  updatedAt: number
}

const fmtTime = (value?: number) => {
  if (!value) return '—'
  const d = new Date(value)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const rate = (ok: number, total: number) => (total ? Math.round((ok / total) * 1000) / 10 : 0)

export default function UsagePage() {
  const [data, setData] = useState<UsageData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [range, setRange] = useState<7 | 14 | 30>(14)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const result = await getAdminUsage()
      setData(result as unknown as UsageData)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const clear = async () => {
    if (!window.confirm('确定清空全部用量统计吗？这个操作不可撤销（只清统计，不影响账号与渠道）。')) return
    setBusy(true)
    try { await resetAdminUsage(); await load() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const totals = data?.totals ?? { total: 0, ok: 0, fail: 0 }
  const days = (data?.days ?? []).slice(-range)
  const peak = Math.max(1, ...days.map((item) => item.total))

  return (
    <AdminShell>
      {error && <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}

      {/* 汇总 */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: '累计请求', value: totals.total, tone: 'text-[#1e293b]' },
          { label: '成功', value: totals.ok, tone: 'text-emerald-500' },
          { label: '失败', value: totals.fail, tone: 'text-rose-500' },
          { label: '成功率', value: `${rate(totals.ok, totals.total)}%`, tone: 'text-[#2563eb]' },
        ].map((card) => (
          <div key={card.label} className="rounded-2xl border border-[#e6ebf2] bg-white p-5 shadow-sm">
            <p className="text-xs font-medium text-[#94a3b8]">{card.label}</p>
            <p className={`mt-2 text-2xl font-bold ${card.tone}`}>{card.value}</p>
          </div>
        ))}
      </div>

      {/* 趋势 */}
      <div className="mt-4 rounded-2xl border border-[#e6ebf2] bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold">出图趋势</h3>
            <p className="mt-1 text-xs text-[#94a3b8]">最近 {range} 天的请求量，绿色为成功、红色为失败</p>
          </div>
          <div className="flex gap-1 rounded-lg bg-[#f1f5f9] p-1">
            {([7, 14, 30] as const).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setRange(n)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  range === n ? 'bg-white text-[#2563eb] shadow-sm' : 'text-[#64748b] hover:text-[#1e293b]'
                }`}
              >
                {n} 天
              </button>
            ))}
          </div>
        </div>

        {days.length === 0 ? (
          <p className="py-12 text-center text-sm text-[#94a3b8]">还没有请求记录</p>
        ) : (
          <div className="mt-6 flex h-40 items-end gap-1.5">
            {days.map((item) => {
              const okH = Math.round((item.ok / peak) * 100)
              const failH = Math.round((item.fail / peak) * 100)
              return (
                <div key={item.day} className="group flex min-w-0 flex-1 flex-col items-center gap-1.5">
                  <span className="text-[10px] text-[#94a3b8] opacity-0 transition group-hover:opacity-100">{item.total}</span>
                  <div className="flex w-full flex-col justify-end overflow-hidden rounded-t" style={{ height: '120px' }}>
                    <div className="w-full bg-rose-400" style={{ height: `${failH}%` }} />
                    <div className="w-full bg-[#60a5fa]" style={{ height: `${okH}%` }} />
                  </div>
                  <span className="w-full truncate text-center text-[10px] text-[#94a3b8]">{item.day.slice(5)}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 渠道维度 */}
      <div className="mt-4 rounded-2xl border border-[#e6ebf2] bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-[#f1f5f9] px-5 py-4">
          <h3 className="text-sm font-bold">按渠道</h3>
          <div className="flex gap-2">
            <button type="button" onClick={() => void load()} disabled={busy} className="flex items-center gap-1.5 rounded-lg border border-[#e2e8f0] px-3 py-1.5 text-xs font-medium text-[#475569] transition hover:bg-[#f8fafc] disabled:opacity-50">
              <IconRefresh className="h-3.5 w-3.5" />
              刷新
            </button>
            <button type="button" onClick={clear} disabled={busy} className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-500 transition hover:bg-red-50 disabled:opacity-50">
              <IconTrash className="h-3.5 w-3.5" />
              清空统计
            </button>
          </div>
        </div>

        {(data?.channels ?? []).length === 0 ? (
          <p className="py-12 text-center text-sm text-[#94a3b8]">还没有渠道请求记录</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[#94a3b8]">
                  <th className="px-5 py-3 font-medium">渠道</th>
                  <th className="px-5 py-3 font-medium">状态</th>
                  <th className="px-5 py-3 text-right font-medium">请求</th>
                  <th className="px-5 py-3 text-right font-medium">成功率</th>
                  <th className="px-5 py-3 text-right font-medium">平均耗时</th>
                  <th className="px-5 py-3 text-right font-medium">最后成功</th>
                  <th className="px-5 py-3 font-medium">最近错误</th>
                </tr>
              </thead>
              <tbody>
                {data!.channels.map((item) => {
                  const down = item.state === 'down'
                  return (
                    <tr key={item.id} className="border-t border-[#f8fafc]">
                      <td className="px-5 py-3">
                        <span className="font-medium text-[#334155]">{item.name}</span>
                        {!item.exists && <span className="ml-2 text-xs text-[#f97316]">已删除</span>}
                      </td>
                      <td className="px-5 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          down ? 'bg-red-50 text-red-500' : 'bg-emerald-50 text-emerald-600'
                        }`}>
                          {down ? '异常' : '正常'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right text-[#64748b]">{item.total}</td>
                      <td className="px-5 py-3 text-right text-[#64748b]">{rate(item.ok, item.total)}%</td>
                      <td className="px-5 py-3 text-right text-[#64748b]">{item.avgLatencyMs ? `${(item.avgLatencyMs / 1000).toFixed(1)}s` : '—'}</td>
                      <td className="px-5 py-3 text-right text-[#94a3b8]">{fmtTime(item.lastOkAt)}</td>
                      <td className="max-w-[16rem] truncate px-5 py-3 text-xs text-[#f87171]" title={item.lastError ?? ''}>{item.lastError || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 最近请求 */}
      <div className="mt-4 rounded-2xl border border-[#e6ebf2] bg-white shadow-sm">
        <div className="border-b border-[#f1f5f9] px-5 py-4">
          <h3 className="text-sm font-bold">最近请求</h3>
        </div>
        {(data?.events ?? []).length === 0 ? (
          <p className="py-12 text-center text-sm text-[#94a3b8]">还没有请求明细</p>
        ) : (
          <div className="max-h-[26rem] overflow-y-auto">
            {data!.events.map((event, idx) => (
              <div key={idx} className="flex items-center justify-between gap-4 border-b border-[#f8fafc] px-5 py-3 last:border-0">
                <div className="min-w-0">
                  <p className="truncate text-sm text-[#334155]">
                    {event.channelName}
                    {event.userName ? <span className="ml-2 text-xs text-[#94a3b8]">{event.userName}</span> : null}
                  </p>
                  {event.error && <p className="mt-0.5 truncate text-xs text-[#f87171]">{event.error}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs">
                  <span className={event.ok ? 'text-emerald-500' : 'text-rose-500'}>{event.ok ? '成功' : '失败'}</span>
                  <span className="text-[#94a3b8]">{event.latencyMs ? `${(event.latencyMs / 1000).toFixed(1)}s` : '—'}</span>
                  <span className="text-[#94a3b8]">{fmtTime(event.at)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminShell>
  )
}
