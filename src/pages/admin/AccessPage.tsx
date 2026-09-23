// 访问与安全：访客口令设置（共享口令模式用）。
import { useCallback, useEffect, useState } from 'react'
import AdminShell from './AdminShell'
import { getAdminState, setGuestPassword, generatePasscode } from '../../lib/adminApi'

export default function AccessPage() {
  const [password, setPassword] = useState('')
  const [guestSet, setGuestSet] = useState(false)
  const [accessMode, setAccessMode] = useState('accounts')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const state = await getAdminState()
      setGuestSet(state.guestPasswordSet)
      setAccessMode(String((state.site as Record<string, unknown>).accessMode ?? 'accounts'))
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const toast = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(null), 3000) }

  const save = async () => {
    setBusy(true); setError(null)
    try {
      await setGuestPassword(password)
      setPassword('')
      toast('访客口令已更新')
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const random = async () => {
    try {
      const { password: pw } = await generatePasscode()
      setPassword(pw)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

  return (
    <AdminShell>
      {notice && <div className="mb-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      {error && <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}

      <div className="rounded-2xl border border-[#e6ebf2] bg-white p-5 shadow-sm">
        <h3 className="text-sm font-bold">访客口令</h3>
        <p className="mt-1 text-xs text-[#94a3b8]">
          共享口令模式下，所有访客用同一个口令进入。当前访问方式：{accessMode === 'passcode' ? '共享口令' : accessMode === 'accounts' ? '多用户账号' : accessMode === 'open' ? '开放模式' : '微信扫码'}
          {guestSet ? '（已设置口令）' : '（未设置）'}
        </p>
        <div className="mt-4 flex items-center gap-3">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full max-w-xs rounded-lg border border-[#e2e8f0] px-3 py-2 text-sm outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15"
            placeholder="输入新口令（至少 6 位）"
          />
          <button type="button" onClick={random} disabled={busy} className="shrink-0 rounded-lg border border-[#e2e8f0] px-4 py-2 text-sm font-medium text-[#475569] transition hover:bg-[#f8fafc]">随机生成</button>
          <button type="button" onClick={save} disabled={busy || password.length < 6} className="shrink-0 rounded-lg bg-[#2563eb] px-5 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8] disabled:opacity-50">保存</button>
        </div>
      </div>
    </AdminShell>
  )
}
