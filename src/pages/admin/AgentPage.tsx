// Agent 模式：让会话式 Agent 直接调用渠道出图。
// 开启前必须先有一条「OpenAI 兼容 + Responses」的文本渠道，混合模式还要一条图像渠道，
// 否则服务端会拒绝保存（这里也提前给出提示，避免用户撞 400）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import AdminShell from './AdminShell'
import { getAdminState, updateSite, type AdminChannel } from '../../lib/adminApi'
import { IconBolt, IconRobot } from '../icons'

const MODES = [
  { key: 'off', label: '关闭', desc: '前台不显示 Agent 入口，只用普通出图。' },
  { key: 'native', label: '原生 Agent', desc: 'Agent 直接对话并按需调用出图渠道。' },
  { key: 'hybrid', label: '混合模式', desc: 'Agent 对话 + 指定图像渠道出图，两者分开配。' },
] as const

export default function AgentPage() {
  const [channels, setChannels] = useState<AdminChannel[]>([])
  const [form, setForm] = useState({
    agentMode: 'off',
    agentTextChannelId: '',
    agentImageChannelId: '',
    agentMaxToolRounds: 15,
    agentWebSearch: false,
  })
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (fresh = false) => {
    try {
      const state = await getAdminState(fresh ? 0 : 8000)
      const site = (state.site as Record<string, unknown>) ?? {}
      setChannels(state.channels ?? [])
      setForm({
        agentMode: String(site.agentMode ?? 'off'),
        agentTextChannelId: String(site.agentTextChannelId ?? ''),
        agentImageChannelId: String(site.agentImageChannelId ?? ''),
        agentMaxToolRounds: Number(site.agentMaxToolRounds ?? 15),
        agentWebSearch: site.agentWebSearch === true,
      })
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const toast = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(null), 3000) }

  // 只有「启用 + openai + responses」的渠道能当 Agent 文本渠道，跟服务端判定保持一致。
  const textChannels = useMemo(
    () => channels.filter((item) => item.enabled && item.provider === 'openai' && item.apiMode === 'responses'),
    [channels],
  )
  const imageChannels = useMemo(() => channels.filter((item) => item.enabled), [channels])

  const save = async () => {
    setBusy(true); setError(null)
    try {
      await updateSite({
        agentMode: form.agentMode,
        agentTextChannelId: form.agentTextChannelId,
        agentImageChannelId: form.agentImageChannelId,
        agentMaxToolRounds: form.agentMaxToolRounds,
        agentWebSearch: form.agentWebSearch,
      })
      toast('Agent 设置已保存')
      await load(true)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const input = 'w-full rounded-lg border border-[#e2e8f0] px-3 py-2 text-sm outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15'
  const label = 'mb-1.5 block text-sm font-medium text-[#475569]'

  return (
    <AdminShell>
      {notice && <div className="mb-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      {error && <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}

      <div className="rounded-2xl border border-[#e6ebf2] bg-white p-5 shadow-sm">
        <h3 className="flex items-center gap-2 text-sm font-bold">
          <IconRobot className="h-4 w-4 text-[#3b82f6]" />
          Agent 接入方式
        </h3>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {MODES.map((mode) => (
            <button
              key={mode.key}
              type="button"
              onClick={() => setForm((f) => ({ ...f, agentMode: mode.key }))}
              className={`rounded-xl border p-4 text-left transition ${
                form.agentMode === mode.key
                  ? 'border-[#93c5fd] bg-[#eff6ff] ring-1 ring-[#93c5fd]'
                  : 'border-[#e6ebf2] hover:border-[#cbd5e1]'
              }`}
            >
              <span className={`text-sm font-semibold ${form.agentMode === mode.key ? 'text-[#2563eb]' : 'text-[#334155]'}`}>{mode.label}</span>
              <span className="mt-1.5 block text-xs leading-5 text-[#64748b]">{mode.desc}</span>
            </button>
          ))}
        </div>

        {form.agentMode !== 'off' && (
          <div className="mt-6 grid gap-4 border-t border-[#f1f5f9] pt-5 sm:grid-cols-2">
            <label className="block">
              <span className={label}>文本渠道（OpenAI 兼容 · Responses）</span>
              <select value={form.agentTextChannelId} onChange={(e) => setForm({ ...form, agentTextChannelId: e.target.value })} className={input}>
                <option value="">自动挑选第一条可用渠道</option>
                {textChannels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              {textChannels.length === 0 && (
                <span className="mt-1.5 block text-xs text-[#ea580c]">
                  还没有可用的文本渠道。请到「渠道链路」加一条 OpenAI 兼容、API 模式为 Responses 的渠道。
                </span>
              )}
            </label>

            {form.agentMode === 'hybrid' && (
              <label className="block">
                <span className={label}>图像渠道（混合模式必选）</span>
                <select value={form.agentImageChannelId} onChange={(e) => setForm({ ...form, agentImageChannelId: e.target.value })} className={input}>
                  <option value="">请选择</option>
                  {imageChannels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
            )}

            <label className="block">
              <span className={label}>最大工具调用轮数</span>
              <input
                type="number"
                min={1}
                max={100}
                value={form.agentMaxToolRounds}
                onChange={(e) => setForm({ ...form, agentMaxToolRounds: Number(e.target.value) || 1 })}
                className={input}
              />
              <span className="mt-1.5 block text-xs text-[#94a3b8]">1–100，越大能连续做的事越多，也越费额度。</span>
            </label>

            <label className="flex items-center gap-2 pt-1 sm:pt-7">
              <input
                type="checkbox"
                checked={form.agentWebSearch}
                onChange={(e) => setForm({ ...form, agentWebSearch: e.target.checked })}
                className="h-4 w-4 rounded accent-[#2563eb]"
              />
              <span className="text-sm">允许 Agent 联网搜索</span>
            </label>
          </div>
        )}

        {form.agentMode === 'off' && (
          <p className="mt-5 flex items-start gap-2 rounded-xl bg-[#f8fafc] px-4 py-3 text-xs leading-5 text-[#64748b]">
            <IconBolt className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#94a3b8]" />
            关闭状态下前台只有普通出图，用户看不到 Agent 入口。
          </p>
        )}

        <button type="button" onClick={save} disabled={busy} className="mt-6 rounded-lg bg-[#2563eb] px-5 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8] disabled:opacity-50">
          保存设置
        </button>
      </div>
    </AdminShell>
  )
}
