import { useEffect, useRef, useState } from 'react'
import { readClipboardImages } from '../lib/imagePaste'
import { useStore } from '../store'

export default function ImagePasteButton({ upload, disabled = false, label = '粘贴图片' }: { upload: (files: File[]) => Promise<void>, disabled?: boolean, label?: string }) {
  const busy = useRef(false)
  const active = useRef(true)
  const [reading, setReading] = useState(false)
  const showToast = useStore((s) => s.showToast)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  const paste = async () => {
    if (busy.current || disabled) return
    busy.current = true
    setReading(true)
    try {
      const files = await readClipboardImages()
      if (active.current) await upload(files)
    } catch (err) {
      console.warn('剪贴板图片读取失败', err)
      if (active.current) showToast(err instanceof Error && err.name !== 'NotAllowedError' ? err.message : '未获得剪贴板读取权限，请点击上传区域后按 Ctrl+V（Mac：⌘V）粘贴', 'error')
    } finally {
      busy.current = false
      if (active.current) setReading(false)
    }
  }
  return <button type="button" disabled={disabled || reading} onClick={() => void paste()} className="min-h-11 rounded-xl border border-[#dfd8f6] bg-white px-3 py-2 text-xs font-semibold text-[#7b65d9] transition hover:bg-[#f1ecff] disabled:opacity-50">{reading ? '正在粘贴…' : label}</button>
}
