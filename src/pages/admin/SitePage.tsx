// 站点设置：标题、访问方式、注册开关、故障转移、Agent 模式。
import { useCallback, useEffect, useState } from 'react'
import AdminShell from './AdminShell'
import { getAdminState, updateSite, generateInvite, deleteInvite } from '../../lib/adminApi'

const ACCESS_LABELS: Record<string, string> = {
  open: '开放模式（无需登录）',
  passcode: '共享口令',
  accounts: '多用户账号',
}
// 「微信扫码」不在可选项里：微信登录还没上线，选它等于把所有人锁在门外。
// 等公众号/小程序下来、微信登录做好后再放回来。

export default function SitePage() {
  const [form, setForm] = useState({
    title: '', accessMode: 'accounts', registrationEnabled: true,
    requireInviteCode: false, inviteCode: '',
    referralEnabled: false, referralReward: '50', referralMaxInvites: '20',
    ipLimitEnabled: false, ipMaxAccounts: '2',
    failoverEnabled: true,
  })
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (fresh = false) => {
    try {
      const state = await getAdminState(fresh ? 0 : 8000)
      const site = (state.site as Record<string, unknown>) ?? {}
      setForm({
        title: String(site.title ?? '绘想'),
        accessMode: String(site.accessMode ?? 'accounts'),
        registrationEnabled: site.registrationEnabled === true,
        requireInviteCode: site.requireInviteCode === true,
        inviteCode: String(site.inviteCode ?? ''),
        referralEnabled: site.referralEnabled === true,
        referralReward: String(site.referralReward ?? 50),
        referralMaxInvites: String(site.referralMaxInvites ?? 20),
        ipLimitEnabled: site.ipLimitEnabled === true,
        ipMaxAccounts: String(site.ipMaxAccounts ?? 2),
        failoverEnabled: site.failoverEnabled !== false,
      })
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const toast = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(null), 3000) }

  const save = async () => {
    setBusy(true); setError(null)
    try {
      await updateSite({
        title: form.title, accessMode: form.accessMode,
        registrationEnabled: form.registrationEnabled,
        requireInviteCode: form.requireInviteCode,
        failoverEnabled: form.failoverEnabled,
        referralEnabled: form.referralEnabled,
        referralReward: Number(form.referralReward) || 0,
        referralMaxInvites: Number(form.referralMaxInvites) || 0,
        ipLimitEnabled: form.ipLimitEnabled,
        ipMaxAccounts: Number(form.ipMaxAccounts) || 2,
      })
      toast('站点设置已保存')
      await load(true)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const genInvite = async () => {
    setBusy(true); setError(null)
    try {
      const result = await generateInvite()
      setForm((f) => ({ ...f, inviteCode: String(result.inviteCode ?? '') }))
      toast('已生成新邀请码')
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const clearInvite = async () => {
    setBusy(true); setError(null)
    try { await deleteInvite(); setForm((f) => ({ ...f, inviteCode: '' })); toast('邀请码已作废') }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const input = 'w-full rounded-lg border border-[#e2e8f0] px-3 py-2 text-sm outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15'
  const label = 'mb-1.5 block text-sm font-medium text-[#475569]'

  return (
    <AdminShell>
      {notice && <div className="mb-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      {error && <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}

      <div className="rounded-2xl border border-[#e6ebf2] bg-white p-5 shadow-sm">
        <h3 className="text-sm font-bold">站点设置</h3>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={label}>站点标题</span>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={input} />
          </label>
          <label className="block">
            <span className={label}>访问方式</span>
            <select value={form.accessMode} onChange={(e) => setForm({ ...form, accessMode: e.target.value })} className={input}>
              {Object.entries(ACCESS_LABELS).map(([key, text]) => <option key={key} value={key}>{text}</option>)}
            </select>
          </label>
          <div className="flex flex-col gap-3 pt-1">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.registrationEnabled} onChange={(e) => setForm({ ...form, registrationEnabled: e.target.checked })} className="h-4 w-4 rounded accent-[#2563eb]" />
              开放自助注册
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.requireInviteCode} onChange={(e) => setForm({ ...form, requireInviteCode: e.target.checked })} className="h-4 w-4 rounded accent-[#2563eb]" />
              要求邀请码
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.failoverEnabled} onChange={(e) => setForm({ ...form, failoverEnabled: e.target.checked })} className="h-4 w-4 rounded accent-[#2563eb]" />
              渠道故障转移
            </label>
          </div>
        </div>

        {/* 邀请返积分：奖励只在被邀请人真正出图后才发 */}
        <div className="mt-5 border-t border-[#f1f5f9] pt-5">
          <h4 className="text-sm font-semibold">邀请返积分</h4>
          <p className="mt-1 text-xs text-[#94a3b8]">
            用户可在「积分中心」拿到自己的邀请链接。奖励在<span className="font-medium text-[#475569]">被邀请人成功生成第一张图</span>后才发给邀请人——
            只注册不出图的小号拿不到任何积分。
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.referralEnabled} onChange={(e) => setForm({ ...form, referralEnabled: e.target.checked })} className="h-4 w-4 rounded accent-[#2563eb]" />
              开启邀请奖励
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-[#475569]">邀请人获得</span>
              <input
                type="number" min="0" value={form.referralReward} disabled={!form.referralEnabled}
                onChange={(e) => setForm({ ...form, referralReward: e.target.value })}
                className="w-28 rounded-lg border border-[#e2e8f0] px-3 py-2 text-sm outline-none focus:border-[#3b82f6] disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
              />
              <span className="text-[#475569]">积分 / 人</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-[#475569]">最多奖励</span>
              <input
                type="number" min="0" value={form.referralMaxInvites} disabled={!form.referralEnabled}
                onChange={(e) => setForm({ ...form, referralMaxInvites: e.target.value })}
                className="w-24 rounded-lg border border-[#e2e8f0] px-3 py-2 text-sm outline-none focus:border-[#3b82f6] disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
              />
              <span className="text-[#475569]">人（0 = 不限）</span>
            </label>
          </div>
        </div>

        {/* 同 IP 注册上限 */}
        <div className="mt-5 border-t border-[#f1f5f9] pt-5">
          <h4 className="text-sm font-semibold">同 IP 注册限制</h4>
          <p className="mt-1 text-xs text-[#94a3b8]">
            注册时会记录来源 IP（IPv6 按 /64 归并）。管理员手动创建的账号不受限制，是救急通道。
            注意：学校、公司、家庭共用网络会误伤，拿不准就先别开。
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.ipLimitEnabled} onChange={(e) => setForm({ ...form, ipLimitEnabled: e.target.checked })} className="h-4 w-4 rounded accent-[#2563eb]" />
              限制同 IP 注册数量
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-[#475569]">每个 IP 最多</span>
              <input
                type="number" min="1" max="100" value={form.ipMaxAccounts} disabled={!form.ipLimitEnabled}
                onChange={(e) => setForm({ ...form, ipMaxAccounts: e.target.value })}
                className="w-24 rounded-lg border border-[#e2e8f0] px-3 py-2 text-sm outline-none focus:border-[#3b82f6] disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
              />
              <span className="text-[#475569]">个账号</span>
            </label>
          </div>
        </div>

        {/* 邀请码 */}
        <div className="mt-5 border-t border-[#f1f5f9] pt-5">
          <h4 className="text-sm font-semibold">邀请码</h4>
          <div className="mt-3 flex items-center gap-3">
            <input value={form.inviteCode} readOnly className={`${input} font-mono`} placeholder="尚未生成" />
            <button type="button" onClick={genInvite} disabled={busy} className="shrink-0 rounded-lg border border-[#e2e8f0] px-4 py-2 text-sm font-medium text-[#475569] transition hover:bg-[#f8fafc]">生成新码</button>
            {form.inviteCode && (
              <button type="button" onClick={clearInvite} disabled={busy} className="shrink-0 rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-500 transition hover:bg-red-50">作废</button>
            )}
          </div>
        </div>

        <button type="button" onClick={save} disabled={busy} className="mt-6 rounded-lg bg-[#2563eb] px-5 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8] disabled:opacity-50">保存设置</button>
      </div>
    </AdminShell>
  )
}
