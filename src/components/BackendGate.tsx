import { useState } from 'react'
import { submitGuestPassword } from '../lib/backend'

interface Props {
  title: string
  onUnlocked: () => void
}

/** 访客口令门禁：后端开启门禁且当前会话未通过时展示，通过后由 App 重新拉取渠道。 */
export default function BackendGate({ title, onUnlocked }: Props) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim() || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await submitGuestPassword(password)
      onUnlocked()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-[#141518]">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-gray-200/70 bg-white/80 p-7 shadow-sm backdrop-blur dark:border-white/[0.08] dark:bg-white/[0.03]"
      >
        <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-gray-500 dark:text-gray-400">
          此站点需要访问口令，请向管理员索取后输入。
        </p>
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="访问口令"
          className="mt-5 w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
        />
        {error && <div className="mt-2 text-xs leading-5 text-red-500">{error}</div>}
        <button
          type="submit"
          disabled={!password.trim() || submitting}
          className="mt-4 w-full rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? '验证中…' : '进入'}
        </button>
      </form>
    </div>
  )
}
