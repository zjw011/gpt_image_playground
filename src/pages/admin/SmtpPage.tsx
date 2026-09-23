// 邮件发信：SMTP 配置 + 连接测试 + 发测试信。QQ 邮箱已预配置。
import { useCallback, useEffect, useState } from 'react'
import AdminShell from './AdminShell'
import { getAdminState, updateSmtp, testSmtp, sendSmtpTest } from '../../lib/adminApi'

export default function SmtpPage() {
  const [form, setForm] = useState({
    enabled: true, host: '', port: '465', encryption: 'ssl',
    user: '', password: '', from: '', fromName: '',
    dailyLimitPerEmail: '8', hourlyLimitPerIp: '20',
  })
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [testTo, setTestTo] = useState('')

  const load = useCallback(async () => {
    try {
      const state = await getAdminState()
      const smtp = (state.smtp as Record<string, unknown>) ?? {}
      setForm({
        enabled: smtp.enabled !== false,
        host: String(smtp.host ?? ''),
        port: String(smtp.port ?? 465),
        encryption: String(smtp.encryption ?? 'ssl'),
        user: String(smtp.user ?? ''),
        password: '',
        from: String(smtp.from ?? ''),
        fromName: String(smtp.fromName ?? ''),
        dailyLimitPerEmail: String(smtp.dailyLimitPerEmail ?? 8),
        hourlyLimitPerIp: String(smtp.hourlyLimitPerIp ?? 20),
      })
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const toast = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(null), 3000) }

  const save = async () => {
    setBusy(true); setError(null)
    try {
      await updateSmtp({
        ...form,
        port: Number(form.port) || 465,
        dailyLimitPerEmail: Number(form.dailyLimitPerEmail) || 8,
        hourlyLimitPerIp: Number(form.hourlyLimitPerIp) || 20,
        password: form.password || undefined,
      })
      toast('邮件发信设置已保存')
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const doTest = async () => {
    setBusy(true); setError(null)
    try {
      const result = await testSmtp({ ...form, password: form.password || undefined })
      toast(result.ok ? 'SMTP 连接成功' : `连接失败：${String(result.message ?? '未知原因')}`)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const doSend = async () => {
    if (!testTo.trim()) { setError('请填写收件邮箱'); return }
    setBusy(true); setError(null)
    try {
      await sendSmtpTest({ ...form, to: testTo.trim(), password: form.password || undefined })
      toast(`测试邮件已发送到 ${testTo.trim()}`)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const input = 'w-full rounded-lg border border-[#e2e8f0] px-3 py-2 text-sm outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15'
  const label = 'mb-1.5 block text-sm font-medium text-[#475569]'

  return (
    <AdminShell>
      {notice && <div className="mb-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      {error && <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}

      <div className="rounded-2xl border border-[#e6ebf2] bg-white p-5 shadow-sm">
        <h3 className="text-sm font-bold">SMTP 发信配置</h3>
        <p className="mt-1 text-xs text-[#94a3b8]">用于注册 / 找回密码的邮箱验证码。QQ 邮箱授权码请在邮箱设置里生成（不是登录密码）。</p>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={label}>SMTP 服务器</span>
            <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} className={input} placeholder="smtp.qq.com" />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className={label}>端口</span>
              <input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} className={input} />
            </label>
            <label className="block">
              <span className={label}>加密</span>
              <select value={form.encryption} onChange={(e) => setForm({ ...form, encryption: e.target.value })} className={input}>
                <option value="ssl">SSL</option>
                <option value="starttls">STARTTLS</option>
                <option value="none">无</option>
              </select>
            </label>
          </div>
          <label className="block">
            <span className={label}>发件邮箱</span>
            <input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} className={input} placeholder="xxx@qq.com" />
          </label>
          <label className="block">
            <span className={label}>授权码（留空表示不修改）</span>
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className={input} placeholder="QQ 邮箱授权码" />
          </label>
          <label className="block">
            <span className={label}>发件人名称</span>
            <input value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} className={input} placeholder="绘想" />
          </label>
          <label className="flex items-center gap-2 pt-6">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} className="h-4 w-4 rounded accent-[#2563eb]" />
            <span className="text-sm">启用邮件发信</span>
          </label>
        </div>

        <div className="mt-6 flex flex-wrap gap-2 border-t border-[#f1f5f9] pt-5">
          <button type="button" onClick={save} disabled={busy} className="rounded-lg bg-[#2563eb] px-5 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8] disabled:opacity-50">保存</button>
          <button type="button" onClick={doTest} disabled={busy} className="rounded-lg border border-[#e2e8f0] px-5 py-2 text-sm font-medium text-[#475569] transition hover:bg-[#f8fafc]">测试连接</button>
          <div className="flex items-center gap-2">
            <input value={testTo} onChange={(e) => setTestTo(e.target.value)} className={input} placeholder="收件邮箱" />
            <button type="button" onClick={doSend} disabled={busy} className="rounded-lg border border-[#e2e8f0] px-5 py-2 text-sm font-medium text-[#475569] transition hover:bg-[#f8fafc]">发测试信</button>
          </div>
        </div>
      </div>
    </AdminShell>
  )
}
