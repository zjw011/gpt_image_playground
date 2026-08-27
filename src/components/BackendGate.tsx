import { useState } from 'react'
import { submitFrontLogin, type BackendAccessMode } from '../lib/backend'
import { syncWorkspaceId } from '../lib/workspace'

interface Props {
  title: string
  accessMode: BackendAccessMode
  onUnlocked: () => void
}

/** 前台门禁：共享口令模式只要口令，多用户模式要用户名 + 口令。通过后由 App 重新拉取渠道。 */
export default function BackendGate({ title, accessMode, onUnlocked }: Props) {
  const accounts = accessMode === 'accounts'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const canSubmit = Boolean(password.trim()) && (!accounts || Boolean(username.trim())) && !submitting

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await submitFrontLogin(accounts ? { username: username.trim(), password } : { password })
      // 先落工作区再刷新，省掉 App 启动时发现身份变化后的第二次刷新。
      syncWorkspaceId(typeof result.workspaceId === 'string' ? result.workspaceId : null)
      onUnlocked()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  const inputClass = 'w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50'

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-[#141518]">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-gray-200/70 bg-white/80 p-7 shadow-sm backdrop-blur dark:border-white/[0.08] dark:bg-white/[0.03]"
      >
        <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-gray-500 dark:text-gray-400">
          {accounts
            ? '请用管理员分配的账号登录，你的作品只有自己能看到。'
            : '此站点需要访问口令，请向管理员索取后输入。'}
        </p>
        {accounts && (
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            placeholder="用户名"
            className={`mt-5 ${inputClass}`}
          />
        )}
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          autoFocus={!accounts}
          autoComplete="current-password"
          placeholder={accounts ? '登录口令' : '访问口令'}
          className={`${accounts ? 'mt-3' : 'mt-5'} ${inputClass}`}
        />
        {error && <div className="mt-2 text-xs leading-5 text-red-500">{error}</div>}
        <button
          type="submit"
          disabled={!canSubmit}
          className="mt-4 w-full rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? '验证中…' : accounts ? '登录' : '进入'}
        </button>
      </form>
    </div>
  )
}
