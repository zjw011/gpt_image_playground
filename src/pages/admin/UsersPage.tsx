// 用户管理：列表 + 新建（可设站长角色）+ 编辑 + 删除 + 调整积分。
import { useCallback, useEffect, useState } from 'react'
import AdminShell from './AdminShell'
import { useStore } from '../../store'
import { getAdminState, createUser, updateUser, deleteUser, setUserBalance, type AdminUser } from '../../lib/adminApi'
import { IconPlus, IconTrash, IconEdit, IconCoin } from '../icons'

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
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)

  const load = useCallback(async (fresh = false) => {
    try {
      const state = await getAdminState(fresh ? 0 : 8000)
      setUsers(state.users)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
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
    setBusy(true); setError(null); setCreatedPw(null)
    try {
      if (editing) {
        await updateUser(editing.id, { ...form, password: form.password || undefined })
        toast('用户已更新')
      } else {
        const result = await createUser({ ...form, password: form.password || undefined })
        if (result.generated) setCreatedPw(result.password)
        toast('用户已创建')
      }
      closeForm()
      await load(true)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
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
    if (!balanceEdit) return
    const amount = Number(balanceEdit.value)
    if (!Number.isFinite(amount) || amount < 0) { setError('积分必须是不小于 0 的数字'); return }
    setBusy(true)
    try {
      await setUserBalance(balanceEdit.user.id, Math.trunc(amount))
      toast('积分已调整')
      setBalanceEdit(null)
      await load(true)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  return (
    <AdminShell>
      <div className="mb-5 flex items-center justify-between">
        <button type="button" onClick={openCreate} className="flex items-center gap-1.5 rounded-lg bg-[#2563eb] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8]">
          <IconPlus className="h-4 w-4" />新建用户
        </button>
        <span className="text-xs text-[#94a3b8]">站长角色登录后进入管理后台，普通用户进入前台</span>
      </div>

      {notice && <div className="mb-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      {error && <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}

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
        {users.length === 0 ? (
          <p className="px-5 py-16 text-center text-sm text-[#94a3b8]">还没有用户</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#f1f5f9] text-left text-xs text-[#94a3b8]">
                <th className="px-5 py-3.5 font-medium">用户</th>
                <th className="px-5 py-3.5 font-medium">角色</th>
                <th className="px-5 py-3.5 font-medium">积分</th>
                <th className="px-5 py-3.5 font-medium">来源</th>
                <th className="px-5 py-3.5 font-medium">状态</th>
                <th className="px-5 py-3.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-[#f8fafc] last:border-0">
                  <td className="px-5 py-3">
                    <p className="font-medium">{u.displayName || u.username}</p>
                    <p className="text-xs text-[#94a3b8]">@{u.username}</p>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${u.role === 'admin' ? 'bg-[#f5f3ff] text-[#7c3aed]' : 'bg-slate-100 text-slate-500'}`}>
                      {u.role === 'admin' ? '站长' : '用户'}
                    </span>
                  </td>
                  <td className="px-5 py-3 font-semibold text-[#2563eb]">{u.balance.toLocaleString()}</td>
                  <td className="px-5 py-3 text-[#64748b]">{u.createdVia}</td>
                  <td className="px-5 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${u.enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
                      {u.enabled ? '正常' : '停用'}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button type="button" onClick={() => openBalanceEdit(u)} className="rounded px-2 py-1 text-xs text-[#2563eb] transition hover:bg-[#eff6ff]">调积分</button>
                      <button type="button" onClick={() => openEdit(u)} className="rounded p-1.5 text-[#64748b] transition hover:bg-[#f1f5f9] hover:text-[#2563eb]" title="编辑"><IconEdit className="h-4 w-4" /></button>
                      <button type="button" onClick={() => remove(u)} className="rounded p-1.5 text-[#64748b] transition hover:bg-red-50 hover:text-red-500" title="删除"><IconTrash className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
