import { useEffect, useState } from 'react'
import { isBackendMode } from '../lib/backend'

export default function WatermarkDownloadOption({ checked, onChange, disabled = false, compact = false }: { checked: boolean, onChange: (value: boolean) => void, disabled?: boolean, compact?: boolean }) {
  const [availability, setAvailability] = useState({ available: false, reason: isBackendMode() ? '正在检查服务…' : '纯静态模式不支持水印处理' })
  useEffect(() => {
    if (!isBackendMode()) return
    let alive = true
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      controller.abort()
      if (alive) setAvailability({ available: false, reason: '服务暂不可用，仍可下载原图' })
    }, 5000)
    void fetch('/api/image-cleanup', { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error('服务不可用')
      const value = await response.json()
      if (!controller.signal.aborted) setAvailability({ available: value.available === true, reason: typeof value.reason === 'string' ? value.reason : '服务不可用' })
    }).catch(() => { if (!controller.signal.aborted) setAvailability({ available: false, reason: '服务暂不可用，仍可下载原图' }) }).finally(() => clearTimeout(timer))
    return () => {
      alive = false
      clearTimeout(timer)
      controller.abort()
    }
  }, [])
  return (
    <div className={compact ? 'border-b border-gray-100 px-3 py-2 dark:border-gray-700' : 'rounded-2xl border border-[#eceaf6] bg-white px-4 py-3'}>
      <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs font-semibold text-[#6f6a94]">
        <input type="checkbox" checked={checked && availability.available} disabled={disabled || !availability.available} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 shrink-0 accent-[#7c6cf6]" />
        移除可见 AI 水印
      </label>
      <p className="text-[11px] leading-5 text-[#8a86ac]">{availability.available ? compact ? '仅下载副本；原图保留' : '仅处理你有权移除的可见标记，可能留下修补痕迹。原图保留，不处理隐形水印。' : availability.reason}</p>
    </div>
  )
}
