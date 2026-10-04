// 用户管理：列表 + 新建（可设站长角色）+ 编辑 + 删除 + 调整积分。
import { useCallback, useEffect, useRef, useState } from 'react'
import AdminShell from './AdminShell'
import { useStore } from '../../store'
import { getAdminState, createUser, updateUser, deleteUser, setUserBalance, grantAllUserCredits, type AdminUser } from '../../lib/adminApi'
import { IconPlus, IconTrash, IconEdit, IconCoin, IconSearch } from '../icons'

export default function UsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ username: '', displayName: '', password: '', note: '', enabled: true, role: 'user' as 'user' | 'admin' })
  const [createdPw, setCreatedPw] = useState<string | null>(null)
  // 余额调整弹层（替代原生 prompt，风格与全站一致）
  const [balanceEdit, setBalanceEdit] = useState<{ user: AdminUser, value: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [role, setRole] = useState('all')
  const [status, setStatus] = useState('all')
  const [sort, setSort] = useState('newest')
  const [page, setPage] = useState(1)
  const [grant, setGrant] = useState<{ amount: string, note: string, requestId: string, userIds: string[] | null } | null>(null)
  const submitting = useRef(false)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)

  const load = useCallback(async (fresh = false) => {
    try {
      const state = await getAdminState(fresh ? 0 : 8000)
      setUsers(state.users)
      setError(null)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const toast = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(null), 3000) }

  const openCreate = () => { setCreating(true); setEditing(null); setCreatedPw(null); setForm({ username: '', displayName: '', password: '', note: '', enabled: true, role: 'user' }) }
  const openEdit = (u: AdminUser) => {
    setEditing(u); setCreating(false); setCreatedPw(null)
    setForm({ username: u.username, displayName: u.displayName || '', password: '', note: u.note || '', enabled: u.enabled, role: (u.role === 'admin' ? 'admin' : 'user') })
  }
  const closeForm = () => { setEditing(null); setCreating(false); setCreatedPw(null) }

  const submit = async () => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true); setError(null); setCreatedPw(null)
    try {
      if (editing) {
        await updateUser(editing.id, { ...form, password: form.password || undefined })
        toast('用户已更新')
      } else {
        const result = await createUser({ ...form, password: form.password || undefined })
        closeForm()
        if (result.generated) setCreatedPw(result.password)
        toast('用户已创建')
      }
      if (editing) closeForm()
      await load(true)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false); submitting.current = false }
  }

  const remove = (u: AdminUser) => {
    if (u.role === 'admin') { setError('不能删除站长账号，请先在编辑里取消站长角色'); return }
    setConfirmDialog({
      title: '删除用户',
      message: `确定删除用户「${u.username}」吗？删除后该账号将无法登录。`,
      confirmText: '删除',
      tone: 'danger',
      action: async () => {
        await deleteUser(u.id)
        toast('用户已删除')
        await load(true)
      },
    })
  }

  const openBalanceEdit = (u: AdminUser) => setBalanceEdit({ user: u, value: String(u.balance) })

  const saveBalance = async () => {
    if (!balanceEdit || submitting.current) return
    const amount = Number(balanceEdit.value)
    if (!balanceEdit.value.trim() || !Number.isSafeInteger(amount) || amount < 0 || amount > 100000000) { setError('积分必须为 0–100000000 的整数'); return }
    submitting.current = true
    setBusy(true)
    try {
      await setUserBalance(balanceEdit.user.id, Math.trunc(amount))
      toast('积分已调整')
      setBalanceEdit(null)
      await load(true)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false); submitting.current = false }
  }

  const sendGrant = async () => {
    if (!grant || submitting.current) return
    const amount = Number(grant.amount)
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100000000) { setError('每人积分必须为 1–100000000 的整数'); return }
    if (!grant.note.trim() || grant.note.trim().length > 100) { setError('请填写 1–100 字的活动说明'); return }
    submitting.current = true
    setBusy(true); setError(null)
    try {
      if (!grant.userIds) {
        const state = await getAdminState(0)
        setUsers(state.users)
        if (!state.users.length) throw new Error('暂无可发放用户')
        setGrant({ ...grant, note: grant.note.trim(), userIds: state.users.map((user) => user.id) })
        return
      }
      const result = await grantAllUserCredits({ requestId: grant.requestId, userIds: grant.userIds, amount, note: grant.note })
      toast(`活动积分已发放：${result.count} 个账号，每人 ${amount.toLocaleString()} 积分，共 ${result.total.toLocaleString()} 积分${result.duplicated ? '（已核对原发放，无重复入账）' : ''}`)
      setGrant(null)
      await load(true)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false); submitting.current = false }
  }

  useEffect(() => { setPage(1) }, [keyword, role, status, sort])
  const query = keyword.trim().toLowerCase()
  const filtered = users.filter((user) => (!query || [user.username, user.displayName, user.email, user.note, user.registerIp].some((value) => value?.toLowerCase().includes(query))) && (role === 'all' || (user.role === 'admin' ? 'admin' : 'user') === role) && (status === 'all' || user.enabled === (status === 'enabled'))).sort((a, b) => sort === 'balance' ? b.balance - a.balance : sort === 'spent' ? b.totalOut - a.totalOut : b.createdAt - a.createdAt)
  const pages = Math.max(1, Math.ceil(filtered.length / 20))
  const currentPage = Math.min(page, pages)
  const visible = filtered.slice((currentPage - 1) * 20, currentPage * 20)

  return (
    <AdminShell>
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {[['注册账号', users.length], ['正常账号', users.filter((user) => user.enabled).length], ['账号积分总额', users.reduce((sum, user) => sum + user.balance, 0)]].map(([label, value]) => <div key={label} className="rounded-2xl border border-[#e6ebf2] bg-white p-5 shadow-sm"><p className="text-xs text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold tabular-nums text-slate-800">{loading ? '—' : value.toLocaleString()}</p></div>)}
      </div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={openCreate} className="flex min-h-11 items-center gap-1.5 rounded-xl bg-[#2563eb] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8] disabled:opacity-50">
          <IconPlus className="h-4 w-4" />新建用户
        </button><button type="button" disabled={busy || loading || users.length === 0} onClick={() => { setError(null); setGrant({ amount: '100', note: '', requestId: Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join(''), userIds: null }) }} className="flex min-h-11 items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 disabled:opacity-50"><IconCoin className="h-4 w-4" />批量赠送积分</button></div>
        <button type="button" disabled={busy || loading} onClick={() => { setLoading(true); void load(true) }} className="min-h-11 rounded-xl border border-slate-200 bg-white px-4 text-xs text-slate-600 disabled:opacity-50">刷新列表</button>
      </div>

      {notice && <div role="status" className="mb-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      {error && <div role="alert" className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}
      {createdPw && <div role="status" className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700">已自动生成登录口令：<span className="font-mono font-bold">{createdPw}</span>（仅显示这一次，请立即记录）<button type="button" className="ml-3 min-h-11 underline" onClick={() => setCreatedPw(null)}>已记录</button></div>}
      {grant && <section aria-label="批量赠送积分" className="mb-6 rounded-2xl border border-blue-200 bg-white p-5 shadow-sm">
        <h3 className="text-base font-bold text-slate-800">活动积分赠送</h3>
        <p className="mt-2 text-xs leading-6 text-slate-500">发给所有已注册账号，包含站长和停用账号，不受搜索、筛选或分页影响。在原余额上增加，不覆盖余额；每个账号都会留下活动流水。</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="text-sm text-slate-600">每人增加积分<input aria-label="每人增加积分" type="number" min="1" max="100000000" step="1" disabled={busy || Boolean(grant.userIds)} value={grant.amount} onChange={(event) => setGrant({ ...grant, amount: event.target.value })} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 p-3 disabled:bg-slate-50" /></label><label className="text-sm text-slate-600">活动说明<input aria-label="活动说明" maxLength={100} disabled={busy || Boolean(grant.userIds)} value={grant.note} placeholder="例如：国庆活动赠送" onChange={(event) => setGrant({ ...grant, note: event.target.value })} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 p-3 disabled:bg-slate-50" /></label></div>
        {grant.userIds && <div role="status" className="mt-4 rounded-xl bg-blue-50 p-4 text-sm leading-7 text-blue-800">将为 <strong>{grant.userIds.length}</strong> 个账号，每人增加 <strong>{Number(grant.amount).toLocaleString()}</strong> 积分，总计 <strong>{(grant.userIds.length * Number(grant.amount)).toLocaleString()}</strong> 积分。说明：{grant.note}<p className="text-xs">确认后直接入账。网络异常时可再次确认，同一笔活动不会重复发放。</p></div>}
        <div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => void sendGrant()} className="min-h-11 rounded-xl bg-blue-600 px-5 text-sm font-semibold text-white disabled:opacity-50">{busy ? '处理中…' : grant.userIds ? '确认发放' : '预览发放范围'}</button><button type="button" disabled={busy} onClick={() => setGrant(null)} className="min-h-11 rounded-xl border border-slate-200 px-4 text-sm text-slate-600 disabled:opacity-50">取消</button>{grant.userIds && <button type="button" disabled={busy} onClick={() => setGrant({ ...grant, userIds: null })} className="min-h-11 px-3 text-xs text-blue-600 disabled:opacity-50">重新确认名单</button>}</div>
      </section>}

      {(creating || editing) && (
        <div className="mb-6 rounded-2xl border border-[#e6ebf2] bg-white p-5 shadow-sm">
          <h3 className="text-sm font-bold">{editing ? '编辑用户' : '新建用户'}</h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-[#475569]">用户名</span>
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" placeholder="2-32 位字母数字" />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-[#475569]">昵称</span>
              <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" placeholder="可选" />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-[#475569]">登录口令 {editing ? '（留空表示不修改）' : '（留空自动生成）'}</span>
              <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" placeholder="至少 6 位" />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-[#475569]">角色</span>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'user' | 'admin' })} className="w-full rounded-lg border border-[#e2e8f0] bg-white px-3 py-2 outline-none focus:border-[#3b82f6]">
                <option value="user">普通用户</option>
                <option value="admin">站长（管理员）</option>
              </select>
            </label>
            <label className="block text-sm sm:col-span-2">
              <span className="mb-1.5 block font-medium text-[#475569]">备注</span>
              <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" placeholder="可选" />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} className="h-4 w-4 rounded accent-[#2563eb]" />
              启用此账号
            </label>
          </div>
          {createdPw && (
            <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
              已自动生成登录口令：<span className="font-mono font-bold">{createdPw}</span>（仅显示这一次，请立即记录）
            </div>
          )}
          <div className="mt-5 flex gap-2">
            <button type="button" onClick={submit} disabled={busy} className="rounded-lg bg-[#2563eb] px-5 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8] disabled:opacity-50">{busy ? '保存中…' : '保存'}</button>
            <button type="button" onClick={closeForm} className="rounded-lg border border-[#e2e8f0] px-5 py-2 text-sm font-medium text-[#475569] transition hover:bg-[#f8fafc]">取消</button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-[#e6ebf2] bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <label className="relative min-w-0 flex-1 basis-60"><IconSearch className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" /><input aria-label="搜索用户" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索昵称、账号、邮箱、备注或 IP" className="min-h-11 w-full rounded-xl border border-slate-200 py-2 pl-9 pr-3 text-sm outline-none focus:border-blue-400" /></label>
          <select aria-label="筛选角色" value={role} onChange={(event) => setRole(event.target.value)} className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs"><option value="all">全部角色</option><option value="user">普通用户</option><option value="admin">站长</option></select>
          <select aria-label="筛选状态" value={status} onChange={(event) => setStatus(event.target.value)} className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs"><option value="all">全部状态</option><option value="enabled">正常账号</option><option value="disabled">停用账号</option></select>
          <select aria-label="用户排序" value={sort} onChange={(event) => setSort(event.target.value)} className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs"><option value="newest">最新注册</option><option value="balance">积分从高到低</option><option value="spent">消耗从高到低</option></select>
        </div>
        {loading || filtered.length === 0 ? (
          <p className="px-5 py-16 text-center text-sm text-[#94a3b8]">{loading ? '正在加载用户…' : users.length ? '没有符合条件的用户，请调整搜索或筛选' : '还没有用户'}</p>
        ) : (
          <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-sm">
            <thead>
              <tr className="border-b border-[#f1f5f9] text-left text-xs text-[#94a3b8]">
                <th className="px-5 py-3.5 font-medium">用户</th>
                <th className="px-5 py-3.5 font-medium">角色</th>
                <th className="px-5 py-3.5 font-medium">积分</th>
                <th className="px-5 py-3.5 font-medium">来源</th>
                <th className="px-5 py-3.5 font-medium">注册 IP</th>
                <th className="px-5 py-3.5 font-medium">状态</th>
                <th className="px-5 py-3.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((u) => (
                <tr key={u.id} className="border-b border-[#f1f5f9] transition hover:bg-blue-50/40 last:border-0">
                  <td className="px-5 py-3">
                    <p className="font-medium">{u.displayName || u.username}</p>
                    <p className="text-xs text-[#94a3b8]">@{u.username}</p>
                    {u.email && <p className="mt-1 max-w-52 truncate text-xs text-slate-400" title={u.email}>{u.email}</p>}
                    {u.note && <p className="mt-1 max-w-52 truncate text-xs text-slate-400" title={u.note}>备注：{u.note}</p>}
                  </td>
                  <td className="px-5 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${u.role === 'admin' ? 'bg-[#f5f3ff] text-[#7c3aed]' : 'bg-slate-100 text-slate-500'}`}>
                      {u.role === 'admin' ? '站长' : '用户'}
                    </span>
                  </td>
                  <td className="px-5 py-3 font-semibold text-[#2563eb]">{u.balance.toLocaleString()}</td>
                  <td className="px-5 py-3 text-[#64748b]">{{ admin: '后台创建', email: '邮箱注册', wechat: '微信登录' }[u.createdVia] || u.createdVia || '—'}<p className="mt-1 whitespace-nowrap text-[11px] text-slate-400">{u.createdAt ? new Date(u.createdAt).toLocaleDateString('zh-CN') : '—'}</p></td>
                  <td className="px-5 py-3">
                    {u.registerIp ? (
                      <span className="flex items-center gap-1.5 font-mono text-xs text-[#64748b]">
                        {u.registerIp}
                        {(u.sameIpCount ?? 0) > 1 && (
                          <span className="rounded-full bg-amber-50 px-1.5 py-0.5 font-sans text-[10px] font-medium text-amber-600" title={`同一 IP 下有 ${u.sameIpCount} 个账号`}>
                            {u.sameIpCount} 个号
                          </span>
                        )}
                      </span>
                    ) : <span className="text-xs text-[#cbd5e1]">—</span>}
                  </td>
                  <td className="px-5 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${u.enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
                      {u.enabled ? '正常' : '停用'}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button type="button" disabled={busy} onClick={() => openBalanceEdit(u)} className="min-h-11 whitespace-nowrap rounded-xl px-2 text-xs text-[#2563eb] transition hover:bg-[#eff6ff] disabled:opacity-50">调积分</button>
                      <button type="button" disabled={busy} aria-label={`编辑用户 ${u.username}`} onClick={() => openEdit(u)} className="flex h-11 w-11 items-center justify-center rounded-xl text-[#64748b] transition hover:bg-[#f1f5f9] hover:text-[#2563eb] disabled:opacity-50" title="编辑"><IconEdit className="h-4 w-4" /></button>
                      <button type="button" disabled={busy || u.role === 'admin'} aria-label={`删除用户 ${u.username}`} onClick={() => remove(u)} className="flex h-11 w-11 items-center justify-center rounded-xl text-[#64748b] transition hover:bg-red-50 hover:text-red-500 disabled:opacity-30" title={u.role === 'admin' ? '不能直接删除站长账号' : '删除'}><IconTrash className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-xs text-slate-500"><span>符合条件 {filtered.length} 个 · 全部 {users.length} 个</span><div className="flex items-center gap-3"><button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} className="min-h-11 rounded-xl border border-slate-200 px-3 disabled:opacity-40">上一页</button><span>{currentPage} / {pages}</span><button type="button" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)} className="min-h-11 rounded-xl border border-slate-200 px-3 disabled:opacity-40">下一页</button></div></div>
      </div>
      {/* 余额调整弹层：替代原生 prompt，风格与全站一致 */}
      {balanceEdit && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4" onClick={() => setBalanceEdit(null)}>
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
          <div className="relative z-10 w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <h3 className="flex items-center gap-2 text-base font-bold text-[#1e293b]">
              <IconCoin className="h-5 w-5 text-[#f5b83d]" />
              调整积分余额
            </h3>
            <p className="mt-2 text-sm text-[#64748b]">
              设置「{balanceEdit.user.displayName || balanceEdit.user.username}」的积分余额（当前 {balanceEdit.user.balance}）
            </p>
            <input
              autoFocus
              type="number"
              min="0"
              value={balanceEdit.value}
              onChange={(event) => setBalanceEdit({ ...balanceEdit, value: event.target.value })}
              onKeyDown={(event) => { if (event.key === 'Enter') void saveBalance() }}
              className="mt-4 w-full rounded-lg border border-[#e2e8f0] px-3 py-2.5 text-sm outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setBalanceEdit(null)} className="rounded-lg border border-[#e2e8f0] px-4 py-2 text-sm font-medium text-[#475569] transition hover:bg-[#f8fafc]">取消</button>
              <button type="button" onClick={() => void saveBalance()} disabled={busy} className="rounded-lg bg-[#2563eb] px-5 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8] disabled:opacity-50">保存</button>
            </div>
          </div>
        </div>
      )}

    </AdminShell>
  )
}
