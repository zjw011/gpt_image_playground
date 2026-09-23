// 后台仪表盘：统计卡片 + 近 14 天出图/积分趋势 + 最近积分流水。
import { useEffect, useState } from 'react'
import AdminShell from './AdminShell'
import { getAdminDashboard, type AdminDashboard } from '../../lib/adminApi'
import { IconSparkle, IconCoin, IconUser, IconLayers } from '../icons'

function StatCard({ label, value, sub, icon: Icon, tone }: {
  label: string, value: string, sub?: string, icon: (p: { className?: string }) => React.ReactNode, tone?: string
}) {
  return (
    <div className="rounded-2xl border border-[#e6ebf2] bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-[#64748b]">{label}</span>
        <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${tone ?? 'bg-[#eff6ff] text-[#2563eb]'}`}>
          <Icon className="h-5 w-5" />
        </span>
      </div>
      <p className="mt-3 text-2xl font-bold">{value}</p>
      {sub && <p className="mt-1 text-xs text-[#94a3b8]">{sub}</p>}
    </div>
  )
}

/** 极简柱状趋势：近 14 天，高度按最大值归一 */
function TrendChart({ data }: { data: AdminDashboard['trend'] }) {
  const max = Math.max(1, ...data.map((item) => Math.max(item.images, item.spent)))
  return (
    <div className="rounded-2xl border border-[#e6ebf2] bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold">近 14 天趋势</h3>
        <div className="flex items-center gap-4 text-xs text-[#64748b]">
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#3b82f6]" />出图</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#f59e0b]" />积分消耗</span>
        </div>
      </div>
      <div className="mt-5 flex h-40 items-end gap-1.5">
        {data.map((item) => {
          const h1 = item.images / max
          const h2 = item.spent / max
          return (
            <div key={item.day} className="group flex flex-1 flex-col items-center gap-1">
              <div className="flex w-full flex-1 items-end justify-center gap-1">
                <div className="w-1/2 rounded-t bg-[#3b82f6]" style={{ height: `${Math.max(2, h1 * 100)}%` }} title={`${item.day} 出图 ${item.images}`} />
                <div className="w-1/2 rounded-t bg-[#f59e0b]" style={{ height: `${Math.max(2, h2 * 100)}%` }} title={`${item.day} 积分 ${item.spent}`} />
              </div>
              <span className="text-[10px] text-[#94a3b8]">{item.day.slice(5)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function AdminDashboardPage() {
  const [data, setData] = useState<AdminDashboard | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getAdminDashboard(10000).then(setData).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const stats = data?.stats

  return (
    <AdminShell>
      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-600">{error}</div>
      )}
      {!data && !error && <p className="text-sm text-[#94a3b8]">加载中…</p>}

      {stats && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="今日出图" value={stats.imagesToday.toLocaleString()} sub={`成功 ${stats.imagesOk} · 失败 ${stats.imagesFail}`} icon={IconSparkle} />
            <StatCard label="注册用户" value={stats.userCount.toLocaleString()} icon={IconUser} tone="bg-[#f0fdf4] text-[#16a34a]" />
            <StatCard label="积分余额" value={stats.creditBalance.toLocaleString()} sub={`累计消耗 ${stats.creditSpent.toLocaleString()}`} icon={IconCoin} tone="bg-[#fffbeb] text-[#d97706]" />
            <StatCard label="渠道健康" value={`${stats.channelUp}/${stats.channelCount}`} sub={`未用卡密 ${stats.cardUnused}`} icon={IconLayers} tone="bg-[#f5f3ff] text-[#7c3aed]" />
          </div>

          <TrendChart data={data.trend} />

          {/* 最近积分流水 */}
          <div className="rounded-2xl border border-[#e6ebf2] bg-white shadow-sm">
            <h3 className="border-b border-[#f1f5f9] px-5 py-4 text-sm font-bold">最近积分流水</h3>
            {data.recentLedger.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-[#94a3b8]">暂无记录</p>
            ) : (
              <table className="w-full text-[13px]">
                <tbody>
                  {data.recentLedger.map((entry, idx) => (
                    <tr key={idx} className="border-b border-[#f8fafc] last:border-0">
                      <td className="px-5 py-3 text-[#64748b]">{(entry.userName as string) || '—'}</td>
                      <td className="px-5 py-3 text-[#94a3b8]">{(entry.type as string) ?? '—'}</td>
                      <td className="px-5 py-3 text-[#94a3b8]">{(entry.note as string) || '—'}</td>
                      <td className={`px-5 py-3 text-right font-semibold ${Number(entry.amount) >= 0 ? 'text-emerald-500' : 'text-[#f472b6]'}`}>
                        {Number(entry.amount) >= 0 ? `+${Number(entry.amount)}` : Number(entry.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </AdminShell>
  )
}
