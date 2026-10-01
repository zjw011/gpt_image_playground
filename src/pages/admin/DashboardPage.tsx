// 后台仪表盘：统计卡片 + 近 14 天出图/积分趋势 + 最近积分流水。
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AdminShell from './AdminShell'
import { getAdminDashboard, type AdminDashboard } from '../../lib/adminApi'
import {
  IconSparkle, IconCoin, IconUser, IconLayers, IconArrowRight,
  IconBolt, IconRefresh, IconWallet, IconCheck,
} from '../icons'

const STAT_TONES = {
  blue: { icon: 'bg-[#eff6ff] text-[#2563eb]', glow: 'bg-[#dbeafe]', accent: 'from-[#2563eb] to-[#60a5fa]' },
  green: { icon: 'bg-[#ecfdf5] text-[#059669]', glow: 'bg-[#d1fae5]', accent: 'from-[#10b981] to-[#6ee7b7]' },
  amber: { icon: 'bg-[#fffbeb] text-[#d97706]', glow: 'bg-[#fef3c7]', accent: 'from-[#f59e0b] to-[#fcd34d]' },
  violet: { icon: 'bg-[#f5f3ff] text-[#7c3aed]', glow: 'bg-[#ede9fe]', accent: 'from-[#7c3aed] to-[#a78bfa]' },
} as const

const LEDGER_LABELS: Record<string, string> = {
  signup: '注册赠送',
  redeem: '卡密兑换',
  spend: '生图消费',
  refund: '失败退款',
  admin: '人工调整',
  referral: '邀请奖励',
  lucky: '幸运免单',
}

const formatLedgerTime = (value: unknown) => {
  const at = Number(value)
  if (!Number.isFinite(at) || at <= 0) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(at))
}

function StatCard({ label, value, sub, icon: Icon, tone }: {
  label: string
  value: string
  sub?: string
  icon: (p: { className?: string }) => React.ReactNode
  tone: keyof typeof STAT_TONES
}) {
  const colors = STAT_TONES[tone]
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-white/80 bg-white p-5 shadow-[0_10px_28px_rgba(51,65,85,0.07)] ring-1 ring-[#e8eef6] transition duration-300 hover:-translate-y-0.5 hover:shadow-[0_14px_34px_rgba(51,65,85,0.1)]">
      <span className={`absolute -right-8 -top-8 h-24 w-24 rounded-full ${colors.glow} opacity-35 blur-2xl transition group-hover:opacity-60`} />
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold tracking-wide text-[#74839a]">{label}</span>
        <span className={`relative flex h-10 w-10 items-center justify-center rounded-xl ${colors.icon}`}>
          <Icon className="h-5 w-5" />
        </span>
      </div>
      <p className="mt-4 text-[27px] font-bold tracking-tight text-[#1e293b]">{value}</p>
      {sub && <p className="mt-1.5 text-xs text-[#94a3b8]">{sub}</p>}
      <span className={`absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r ${colors.accent} opacity-70`} />
    </div>
  )
}

/** 极简柱状趋势：近 14 天，高度按最大值归一 */
function TrendChart({ data }: { data: AdminDashboard['trend'] }) {
  const max = Math.max(1, ...data.map((item) => Math.max(item.images, item.spent)))
  const hasData = data.some((item) => item.images > 0 || item.spent > 0)
  return (
    <div className="rounded-2xl border border-white/80 bg-white p-5 shadow-[0_10px_28px_rgba(51,65,85,0.06)] ring-1 ring-[#e8eef6] sm:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[15px] font-bold text-[#1e293b]">近 14 天运营趋势</h3>
          <p className="mt-1 text-[11px] text-[#94a3b8]">出图数量与积分消耗变化</p>
        </div>
        <div className="flex items-center gap-4 text-xs text-[#64748b]">
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#3b82f6]" />出图</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#f59e0b]" />积分消耗</span>
        </div>
      </div>
      <div className="relative mt-5 h-[230px] overflow-hidden rounded-xl bg-[linear-gradient(to_bottom,#f8fafc_1px,transparent_1px)] bg-[length:100%_25%]">
        {!hasData ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#eff6ff] text-[#3b82f6]"><IconSparkle className="h-6 w-6" /></span>
            <p className="mt-3 text-sm font-semibold text-[#475569]">近 14 天还没有出图数据</p>
            <p className="mt-1 text-xs text-[#94a3b8]">用户开始创作后，趋势会自动出现在这里</p>
          </div>
        ) : (
          <div className="absolute inset-x-0 bottom-0 top-3 flex items-end gap-1.5 px-1">
            {data.map((item) => {
              const h1 = item.images / max
              const h2 = item.spent / max
              return (
                <div key={item.day} className="group flex h-full flex-1 flex-col items-center gap-2">
                  <div className="flex w-full flex-1 items-end justify-center gap-1">
                    <div className="w-[38%] rounded-t-md bg-gradient-to-t from-[#2563eb] to-[#60a5fa] transition-opacity group-hover:opacity-80" style={{ height: item.images ? `${Math.max(5, h1 * 100)}%` : 0 }} title={`${item.day} 出图 ${item.images}`} />
                    <div className="w-[38%] rounded-t-md bg-gradient-to-t from-[#f59e0b] to-[#fcd34d] transition-opacity group-hover:opacity-80" style={{ height: item.spent ? `${Math.max(5, h2 * 100)}%` : 0 }} title={`${item.day} 积分 ${item.spent}`} />
                  </div>
                  <span className="text-[10px] text-[#94a3b8]">{item.day.slice(5)}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function ProgressItem({ label, value, detail, color }: { label: string, value: number, detail: string, color: string }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-[#64748b]">{label}</span>
        <span className="font-semibold text-[#334155]">{detail}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#edf2f7]">
        <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  )
}

export default function AdminDashboardPage() {
  const [data, setData] = useState<AdminDashboard | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    getAdminDashboard(10000).then(setData).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(() => load(), [load])

  const stats = data?.stats
  const successRate = stats?.imagesToday ? Math.round((stats.imagesOk / stats.imagesToday) * 100) : 0
  const channelRate = stats?.channelCount ? Math.round((stats.channelUp / stats.channelCount) * 100) : 0

  return (
    <AdminShell>
      {error && (
        <div className="flex items-center justify-between rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-600">
          <span>{error}</span>
          <button type="button" onClick={load} className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 font-medium shadow-sm"><IconRefresh className="h-4 w-4" />重新加载</button>
        </div>
      )}
      {!data && !error && (
        <div className="space-y-5 animate-pulse">
          <div className="h-32 rounded-3xl bg-white/80" />
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, idx) => <div key={idx} className="h-36 rounded-2xl bg-white/80" />)}</div>
          <div className="h-80 rounded-2xl bg-white/80" />
        </div>
      )}

      {stats && (
        <div className="space-y-5">
          <section className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-[#1d4ed8] via-[#2563eb] to-[#60a5fa] px-6 py-6 text-white shadow-[0_16px_38px_rgba(37,99,235,0.2)] sm:px-8">
            <span className="absolute -right-12 -top-20 h-56 w-56 rounded-full border-[36px] border-white/10" />
            <span className="absolute right-40 top-12 h-20 w-20 rounded-full bg-white/10 blur-xl" />
            <div className="relative flex flex-col justify-between gap-5 md:flex-row md:items-center">
              <div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-[11px] font-medium ring-1 ring-white/20"><IconBolt className="h-3.5 w-3.5" />运营总览</span>
                <h2 className="mt-3 text-2xl font-bold tracking-tight">欢迎回来，今天也在稳定运行</h2>
                <p className="mt-2 text-sm text-blue-100">关键业务数据、渠道健康和积分变化都集中在这里。</p>
              </div>
              <div className="flex gap-2.5">
                <Link to="/admin?tab=usage" className="flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-xs font-semibold text-[#2563eb] shadow-lg shadow-blue-900/10 transition hover:-translate-y-0.5">查看用量<IconArrowRight className="h-3.5 w-3.5" /></Link>
                <Link to="/admin?tab=channels" className="flex items-center gap-2 rounded-xl bg-white/12 px-4 py-2.5 text-xs font-semibold text-white ring-1 ring-white/25 transition hover:bg-white/20">管理渠道</Link>
              </div>
            </div>
          </section>

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="今日出图" value={stats.imagesToday.toLocaleString()} sub={`成功 ${stats.imagesOk} · 失败 ${stats.imagesFail}`} icon={IconSparkle} tone="blue" />
            <StatCard label="注册用户" value={stats.userCount.toLocaleString()} sub="当前平台注册账号" icon={IconUser} tone="green" />
            <StatCard label="积分余额" value={stats.creditBalance.toLocaleString()} sub={`累计消耗 ${stats.creditSpent.toLocaleString()}`} icon={IconCoin} tone="amber" />
            <StatCard label="渠道健康" value={`${stats.channelUp}/${stats.channelCount}`} sub={`未用卡密 ${stats.cardUnused}`} icon={IconLayers} tone="violet" />
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
            <TrendChart data={data.trend} />
            <section className="rounded-2xl border border-white/80 bg-white p-6 shadow-[0_10px_28px_rgba(51,65,85,0.06)] ring-1 ring-[#e8eef6]">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-[15px] font-bold text-[#1e293b]">运行概览</h3>
                  <p className="mt-1 text-[11px] text-[#94a3b8]">核心服务实时状态</p>
                </div>
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-50 text-emerald-500"><IconCheck className="h-5 w-5" /></span>
              </div>
              <div className="mt-7 space-y-6">
                <ProgressItem label="渠道可用率" value={channelRate} detail={`${stats.channelUp}/${stats.channelCount}`} color="bg-gradient-to-r from-[#7c3aed] to-[#a78bfa]" />
                <ProgressItem label="今日成功率" value={successRate} detail={`${successRate}%`} color="bg-gradient-to-r from-[#2563eb] to-[#60a5fa]" />
              </div>
              <div className="mt-7 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-[#f8fafc] p-3.5">
                  <IconWallet className="h-4 w-4 text-[#f59e0b]" />
                  <p className="mt-2 text-lg font-bold text-[#334155]">{stats.cardUnused}</p>
                  <p className="text-[10px] text-[#94a3b8]">可用卡密</p>
                </div>
                <div className="rounded-xl bg-[#f8fafc] p-3.5">
                  <IconLayers className="h-4 w-4 text-[#7c3aed]" />
                  <p className="mt-2 text-lg font-bold text-[#334155]">{stats.channelCount}</p>
                  <p className="text-[10px] text-[#94a3b8]">全部渠道</p>
                </div>
              </div>
              <p className="mt-5 border-t border-[#f1f5f9] pt-4 text-[10px] text-[#a3afc0]">数据更新于 {new Date(data.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</p>
            </section>
          </div>

          {/* 最近积分流水 */}
          <div className="overflow-hidden rounded-2xl border border-white/80 bg-white shadow-[0_10px_28px_rgba(51,65,85,0.06)] ring-1 ring-[#e8eef6]">
            <div className="flex items-center justify-between border-b border-[#f1f5f9] px-5 py-4 sm:px-6">
              <div>
                <h3 className="text-[15px] font-bold text-[#1e293b]">最近积分流水</h3>
                <p className="mt-1 text-[11px] text-[#94a3b8]">展示最新的积分收入与支出</p>
              </div>
              <Link to="/admin?tab=credits" className="flex items-center gap-1 text-xs font-semibold text-[#3b82f6] transition hover:text-[#2563eb]">查看全部<IconArrowRight className="h-3.5 w-3.5" /></Link>
            </div>
            {data.recentLedger.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-[#94a3b8]">暂无记录</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-[13px]">
                  <thead className="bg-[#fafcff] text-left text-[10px] font-semibold tracking-wider text-[#a0aec0]">
                    <tr><th className="px-6 py-3">用户</th><th className="px-5 py-3">类型</th><th className="px-5 py-3">说明</th><th className="px-5 py-3">时间</th><th className="px-6 py-3 text-right">变动</th></tr>
                  </thead>
                  <tbody>
                    {data.recentLedger.map((entry, idx) => {
                      const type = String(entry.type ?? '')
                      const amount = Number(entry.amount) || 0
                      const name = String(entry.userName || '未知用户')
                      return (
                        <tr key={String(entry.id ?? idx)} className="border-t border-[#f1f5f9] transition hover:bg-[#fafcff]">
                          <td className="px-6 py-3.5">
                            <span className="flex items-center gap-2.5 font-medium text-[#475569]"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#eff6ff] text-[10px] font-bold text-[#3b82f6]">{name.slice(0, 1)}</span>{name}</span>
                          </td>
                          <td className="px-5 py-3.5"><span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${amount > 0 ? 'bg-emerald-50 text-emerald-600' : amount < 0 ? 'bg-rose-50 text-rose-500' : 'bg-blue-50 text-blue-500'}`}>{LEDGER_LABELS[type] ?? (type || '其他')}</span></td>
                          <td className="max-w-[22rem] truncate px-5 py-3.5 text-[#8492a6]">{String(entry.note || '—')}</td>
                          <td className="px-5 py-3.5 text-[#a0aec0]">{formatLedgerTime(entry.at ?? entry.createdAt)}</td>
                          <td className={`px-6 py-3.5 text-right font-bold ${amount > 0 ? 'text-emerald-500' : amount < 0 ? 'text-rose-500' : 'text-blue-500'}`}>
                            {amount > 0 ? `+${amount}` : amount}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </AdminShell>
  )
}
