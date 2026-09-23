// 积分与卡密：积分设置 + 卡密生成 + 最近兑换。
import { useCallback, useEffect, useState } from 'react'
import AdminShell from './AdminShell'
import { getAdminCredits, updateCredits, generateCards, listCards } from '../../lib/adminApi'
import { IconPlus } from '../icons'

export default function CreditsPage() {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [recent, setRecent] = useState<Array<Record<string, unknown>>>([])

  // 积分设置表单
  const [enabled, setEnabled] = useState(true)
  const [costPerImage, setCostPerImage] = useState('1')
  const [signupBonus, setSignupBonus] = useState('50')
  const [purchaseUrl, setPurchaseUrl] = useState('')

  // 卡密生成表单
  const [cardCount, setCardCount] = useState('10')
  const [cardCredits, setCardCredits] = useState('100')

  const load = useCallback(async () => {
    try {
      const result = await getAdminCredits()
      setData(result)
      const settings = (result as { settings?: Record<string, unknown> }).settings ?? {}
      setEnabled(settings.enabled !== false)
      setCostPerImage(String(settings.costPerImage ?? 1))
      setSignupBonus(String(settings.signupBonus ?? 0))
      setPurchaseUrl(String(settings.purchaseUrl ?? ''))
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])

  const loadCards = useCallback(async () => {
    try {
      const result = await listCards('limit=20')
      setRecent((result as { cards?: Array<Record<string, unknown>> }).cards ?? [])
    } catch {}
  }, [])

  useEffect(() => { void load(); void loadCards() }, [load, loadCards])

  const toast = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(null), 3000) }

  const saveCredits = async () => {
    setBusy(true); setError(null)
    try {
      await updateCredits({
        credits: {
          enabled,
          costPerImage: Number(costPerImage) || 0,
          signupBonus: Number(signupBonus) || 0,
          purchaseUrl,
        },
      })
      toast('积分设置已保存')
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const genCards = async () => {
    setBusy(true); setError(null)
    try {
      await generateCards({ count: Number(cardCount) || 1, credits: Number(cardCredits) || 1 })
      toast(`已生成 ${cardCount} 张卡密`)
      await load(); await loadCards()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  return (
    <AdminShell>
      {notice && <div className="mb-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      {error && <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 积分设置 */}
        <div className="rounded-2xl border border-[#e6ebf2] bg-white p-5 shadow-sm">
          <h3 className="text-sm font-bold">积分设置</h3>
          <div className="mt-4 space-y-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 rounded accent-[#2563eb]" />
              启用积分制
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-[#475569]">每张图消耗积分</span>
              <input type="number" min="0" value={costPerImage} onChange={(e) => setCostPerImage(e.target.value)} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-[#475569]">注册赠送积分</span>
              <input type="number" min="0" value={signupBonus} onChange={(e) => setSignupBonus(e.target.value)} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-[#475569]">卡密购买链接（可选）</span>
              <input value={purchaseUrl} onChange={(e) => setPurchaseUrl(e.target.value)} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" placeholder="https://…" />
            </label>
            <button type="button" onClick={saveCredits} disabled={busy} className="rounded-lg bg-[#2563eb] px-5 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8] disabled:opacity-50">保存设置</button>
          </div>
        </div>

        {/* 卡密生成 */}
        <div className="rounded-2xl border border-[#e6ebf2] bg-white p-5 shadow-sm">
          <h3 className="text-sm font-bold">生成卡密</h3>
          <div className="mt-4 space-y-4">
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-[#475569]">数量</span>
              <input type="number" min="1" value={cardCount} onChange={(e) => setCardCount(e.target.value)} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-[#475569]">每张面值（积分）</span>
              <input type="number" min="1" value={cardCredits} onChange={(e) => setCardCredits(e.target.value)} className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/15" />
            </label>
            <button type="button" onClick={genCards} disabled={busy} className="flex items-center gap-1.5 rounded-lg bg-[#2563eb] px-5 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8] disabled:opacity-50">
              <IconPlus className="h-4 w-4" />生成卡密
            </button>
            <p className="text-xs text-[#94a3b8]">生成后可导出，卡密用于用户自助兑换积分</p>
          </div>

          {recent.length > 0 && (
            <div className="mt-5 border-t border-[#f1f5f9] pt-4">
              <h4 className="text-xs font-semibold text-[#64748b]">最近兑换</h4>
              <ul className="mt-2 space-y-1.5 text-[13px]">
                {recent.slice(0, 8).map((card, idx) => (
                  <li key={idx} className="flex items-center justify-between">
                    <span className="font-mono text-xs text-[#64748b]">{String(card.code ?? '')}</span>
                    <span className="text-[#94a3b8]">{String(card.credits ?? '')} 积分</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </AdminShell>
  )
}
