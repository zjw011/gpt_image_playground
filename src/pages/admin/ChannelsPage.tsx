// 渠道链路：列表 + 新建/编辑 + 删除 + 排序 + 连通测试 + 深度自检 + 自定义服务商。
import { useCallback, useEffect, useMemo, useState } from 'react'
import AdminShell from './AdminShell'
import {
  getAdminState, createChannel, updateChannel, deleteChannel, reorderChannels,
  testChannel, testAllChannels, auditChannels, bulkDisableChannels, updateCustomProviders,
  type AdminChannel,
} from '../../lib/adminApi'
import { IconPlus, IconRefresh, IconTrash, IconEdit } from '../icons'

const HEALTH_TONE: Record<string, string> = {
  healthy: 'bg-emerald-50 text-emerald-600',
  flaky: 'bg-amber-50 text-amber-600',
  down: 'bg-red-50 text-red-500',
  unknown: 'bg-slate-100 text-slate-500',
}
const HEALTH_TEXT: Record<string, string> = { healthy: '正常', flaky: '不稳', down: '疑似故障', unknown: '未使用' }

const BUILT_IN_PROVIDERS = ['openai', 'sb2api-async', 'fal']

export default function ChannelsPage() {
  const [channels, setChannels] = useState<AdminChannel[]>([])
  const [customProviders, setCustomProviders] = useState<unknown[]>([])
  const [providerDraft, setProviderDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<AdminChannel | null>(null)
  const [creating, setCreating] = useState(false)

  // 表单态
  const [form, setForm] = useState({ name: '', provider: 'openai', baseUrl: '', model: '', apiKey: '', enabled: true })

  const load = useCallback(async () => {
    try {
      const state = await getAdminState()
      setChannels(state.channels)
      setCustomProviders(state.customProviders ?? [])
      setProviderDraft(JSON.stringify(state.customProviders ?? [], null, 2))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // 服务商下拉要带上自定义项，否则那些渠道建得出来却选不回去。
  const providers = useMemo(() => {
    const ids = customProviders
      .map((item) => (item && typeof item === 'object' ? String((item as { id?: unknown }).id ?? '') : ''))
      .filter(Boolean)
    return [...BUILT_IN_PROVIDERS, ...ids]
  }, [customProviders])

  const toast = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(null), 2600) }

  const saveProviders = async () => {
    setBusy(true); setError(null)
    try {
      const parsed = JSON.parse(providerDraft)
      if (!Array.isArray(parsed)) throw new Error('顶层必须是 JSON 数组')
      const result = await updateCustomProviders(parsed)
      setCustomProviders(result.customProviders ?? [])
      setProviderDraft(JSON.stringify(result.customProviders ?? [], null, 2))
      toast('自定义服务商已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  const openCreate = () => { setCreating(true); setEditing(null); setForm({ name: '', provider: 'openai', baseUrl: '', model: '', apiKey: '', enabled: true }) }
  const openEdit = (channel: AdminChannel) => {
    setEditing(channel); setCreating(false)
    setForm({ name: String(channel.name ?? ''), provider: String(channel.provider ?? 'openai'), baseUrl: String(channel.baseUrl ?? ''), model: String(channel.model ?? ''), apiKey: '', enabled: channel.enabled !== false })
  }
  const closeForm = () => { setEditing(null); setCreating(false) }

  const submit = async () => {
    setBusy(true); setError(null)
    try {
      if (editing) {
        await updateChannel(editing.id, { ...form, apiKey: form.apiKey || undefined })
        toast('渠道已更新')
      } else {
        await createChannel(form)
        toast('渠道已创建')
      }
      closeForm()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (channel: AdminChannel) => {
    if (!window.confirm(`确定删除渠道「${channel.name}」吗？`)) return
    await deleteChannel(channel.id)
    toast('渠道已删除')
    await load()
  }

  const doTest = async (id: string) => {
    setBusy(true)
    try {
      const result = await testChannel(id)
      toast(result.ok ? `「${result.message ?? '连通正常'}」` : `连通失败：${result.message ?? '未知原因'}`)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false); await load() }
  }

  const doTestAll = async () => {
    setBusy(true); setError(null)
    try {
      const { results } = await testAllChannels()
      const failed = results.filter((r) => !r.ok).length
      toast(`测试完成：${results.length - failed} 条正常，${failed} 条异常`)
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const doAudit = async () => {
    setBusy(true); setError(null)
    try {
      const { results } = await auditChannels()
      const down = results.filter((r) => (r as { verdict?: string }).verdict !== 'ok')
      if (down.length === 0) toast('自检完成：全部渠道都能出图')
      else {
        const ids = down.map((r) => r.id as string)
        if (window.confirm(`有 ${down.length} 条渠道疑似异常，是否一键停用？`)) {
          await bulkDisableChannels(ids)
          toast(`已停用 ${down.length} 条渠道`)
        } else {
          toast(`自检完成：${down.length} 条渠道异常`)
        }
      }
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const move = async (id: string, dir: -1 | 1) => {
    const idx = channels.findIndex((c) => c.id === id)
    const target = idx + dir
    if (target < 0 || target >= channels.length) return
    const order = channels.map((c) => c.id)
    const [item] = order.splice(idx, 1)
    order.splice(target, 0, item)
    setChannels((await reorderChannels(order)).channels)
  }

  return (
    <AdminShell>
      <div className="mb-5 flex items-center justify-between">
        <div className="flex gap-2">
          <button type="button" onClick={openCreate} className="flex items-center gap-1.5 rounded-lg bg-[#2563eb] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8]">
            <IconPlus className="h-4 w-4" />新建渠道
          </button>
          <button type="button" onClick={doTestAll} disabled={busy} className="flex items-center gap-1.5 rounded-lg border border-[#e2e8f0] bg-white px-4 py-2 text-sm font-medium text-[#475569] transition hover:bg-[#f8fafc]">
            <IconRefresh className="h-4 w-4" />测试全部
          </button>
          <button type="button" onClick={doAudit} disabled={busy} className="flex items-center gap-1.5 rounded-lg border border-[#e2e8f0] bg-white px-4 py-2 text-sm font-medium text-[#475569] transition hover:bg-[#f8fafc]">
            深度自检
          </button>
        </div>
        <span className="text-xs text-[#94a3b8]">顺序即故障转移顺序，可用右侧箭头调整</span>
      </div>

      {notice && <div className="mb-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      {error && <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}

      {/* 表单 */}
      {(creating || editing) && (
        <div className="mb-6 rounded-2xl border border-[#e6ebf2] bg-white p-5 shadow-sm">
          <h3 className="text-sm font-bold">{editing ? '编辑渠道' : '新建渠道'}</h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-[#475569]">渠道名称</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" placeholder="如：主力出图" />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-[#475569]">服务商</span>
              <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} className="w-full rounded-lg border border-[#e2e8f0] bg-white px-3 py-2 outline-none focus:border-[#3b82f6]">
                {providers.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            {form.provider !== 'fal' && (
              <label className="block text-sm">
                <span className="mb-1.5 block font-medium text-[#475569]">API 地址</span>
                <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" placeholder="https://…" />
              </label>
            )}
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-[#475569]">模型</span>
              <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" placeholder="模型 ID" />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-[#475569]">API Key {editing && '（留空表示不修改）'}</span>
              <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" placeholder="sk-…" />
            </label>
            <label className="flex items-center gap-2 pt-6 text-sm">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} className="h-4 w-4 rounded accent-[#2563eb]" />
              启用这条渠道
            </label>
          </div>
          <div className="mt-5 flex gap-2">
            <button type="button" onClick={submit} disabled={busy} className="rounded-lg bg-[#2563eb] px-5 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8] disabled:opacity-50">
              {busy ? '保存中…' : '保存'}
            </button>
            <button type="button" onClick={closeForm} className="rounded-lg border border-[#e2e8f0] px-5 py-2 text-sm font-medium text-[#475569] transition hover:bg-[#f8fafc]">取消</button>
          </div>
        </div>
      )}

      {/* 列表 */}
      <div className="overflow-hidden rounded-2xl border border-[#e6ebf2] bg-white shadow-sm">
        {channels.length === 0 ? (
          <p className="px-5 py-16 text-center text-sm text-[#94a3b8]">还没有渠道，点右上角「新建渠道」添加第一条</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#f1f5f9] text-left text-xs text-[#94a3b8]">
                <th className="px-5 py-3.5 font-medium">渠道</th>
                <th className="px-5 py-3.5 font-medium">服务商</th>
                <th className="px-5 py-3.5 font-medium">模型</th>
                <th className="px-5 py-3.5 font-medium">状态</th>
                <th className="px-5 py-3.5 font-medium">健康度</th>
                <th className="px-5 py-3.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((channel, idx) => {
                const health = (channel.health as { state?: string } | undefined)?.state ?? 'unknown'
                return (
                  <tr key={channel.id} className="border-b border-[#f8fafc] last:border-0">
                    <td className="px-5 py-3">
                      <p className="font-medium">{channel.name}</p>
                      <p className="text-xs text-[#94a3b8]">{channel.apiKeyMask || '（无密钥）'}</p>
                    </td>
                    <td className="px-5 py-3 text-[#64748b]">{channel.provider}</td>
                    <td className="max-w-[180px] truncate px-5 py-3 text-[#64748b]">{String(channel.model ?? '—')}</td>
                    <td className="px-5 py-3">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${channel.enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
                        {channel.enabled ? '启用' : '停用'}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${HEALTH_TONE[health] ?? HEALTH_TONE.unknown}`}>
                        {HEALTH_TEXT[health] ?? health}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button type="button" onClick={() => move(channel.id, -1)} disabled={idx === 0} className="rounded p-1 text-[#94a3b8] transition hover:bg-[#f1f5f9] disabled:opacity-30" title="上移">↑</button>
                        <button type="button" onClick={() => move(channel.id, 1)} disabled={idx === channels.length - 1} className="rounded p-1 text-[#94a3b8] transition hover:bg-[#f1f5f9] disabled:opacity-30" title="下移">↓</button>
                        <button type="button" onClick={() => doTest(channel.id)} className="rounded px-2 py-1 text-xs text-[#2563eb] transition hover:bg-[#eff6ff]" title="连通测试">测试</button>
                        <button type="button" onClick={() => openEdit(channel)} className="rounded p-1.5 text-[#64748b] transition hover:bg-[#f1f5f9] hover:text-[#2563eb]" title="编辑"><IconEdit className="h-4 w-4" /></button>
                        <button type="button" onClick={() => remove(channel)} className="rounded p-1.5 text-[#64748b] transition hover:bg-red-50 hover:text-red-500" title="删除"><IconTrash className="h-4 w-4" /></button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 自定义服务商：非 OpenAI 格式的接口靠 http-image 模板接进来。
          放在渠道页而不是单独一页——它就是"服务商类型的来源"，跟渠道列表是一件事。 */}
      <div className="mt-4 rounded-2xl border border-[#e6ebf2] bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold">自定义服务商</h3>
            <p className="mt-1 text-xs leading-5 text-[#94a3b8]">
              粘贴 <code className="rounded bg-[#f1f5f9] px-1 py-0.5">http-image</code> 模板 JSON 数组，
              用来对接非 OpenAI 格式的第三方接口。保存后，上面「服务商」下拉里就能选到这些 id。
              格式与前端「自定义服务商」完全一致，可参考 <code className="rounded bg-[#f1f5f9] px-1 py-0.5">docs/custom-provider-llm-prompt.md</code>。
            </p>
          </div>
          <span className="rounded-full bg-[#eff6ff] px-3 py-1 text-xs font-medium text-[#2563eb]">
            当前 {customProviders.length} 个
          </span>
        </div>
        <textarea
          value={providerDraft}
          onChange={(event) => setProviderDraft(event.target.value)}
          spellCheck={false}
          rows={8}
          placeholder="[]"
          className="mt-4 w-full rounded-lg border border-[#e2e8f0] px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15"
        />
        <div className="mt-3 flex items-center gap-2">
          <button type="button" onClick={saveProviders} disabled={busy} className="rounded-lg bg-[#2563eb] px-5 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8] disabled:opacity-50">
            保存
          </button>
          <button
            type="button"
            onClick={() => setProviderDraft(JSON.stringify(customProviders, null, 2))}
            className="rounded-lg border border-[#e2e8f0] px-4 py-2 text-sm font-medium text-[#475569] transition hover:bg-[#f8fafc]"
          >
            还原
          </button>
        </div>
      </div>
    </AdminShell>
  )
}
