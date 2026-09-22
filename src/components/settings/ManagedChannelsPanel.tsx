// 用户侧的「我的渠道」面板。
// 后端托管模式下渠道和模型全部由管理员在后台下发，这里只做展示与切换，
// 不提供任何新增/编辑/删除入口——保持"运营在后台、用户在台前"的边界。
import { useStore } from '../../store'
import { getApiProviderLabel } from '../../lib/apiProfiles'
import { getDefaultPresetProfileId, getPresetProfileIds } from '../../lib/presetConfig'

export default function ManagedChannelsPanel() {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)

  const presetIds = getPresetProfileIds()
  const channels = settings.profiles.filter((profile) => presetIds.has(profile.id))
  const defaultId = getDefaultPresetProfileId()
  const activeId = channels.some((profile) => profile.id === settings.activeProfileId)
    ? settings.activeProfileId
    : defaultId ?? channels[0]?.id

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-2xl border border-blue-100 bg-blue-50/60 p-4 dark:border-blue-500/20 dark:bg-blue-500/[0.06]">
        <svg className="mt-0.5 h-5 w-5 shrink-0 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
        <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-gray-600 dark:text-gray-300">
          渠道与模型由管理员在后台统一维护，接口地址和密钥不会下发到浏览器。
          下面列出的是本站可用的渠道，你只能在其中选择，不能新增或修改。
        </div>
      </div>

      <div className="space-y-2.5">
        <span className="block text-sm text-gray-600 dark:text-gray-300">可用渠道</span>
        {channels.length === 0 && (
          <p className="rounded-xl border border-dashed border-gray-200/70 px-3.5 py-6 text-center text-[13px] text-gray-400 dark:border-white/[0.08] dark:text-gray-500">
            管理员还没有配置渠道，暂时无法生成图片。
          </p>
        )}
        {channels.map((channel) => {
          const isActive = channel.id === activeId
          const isDefault = channel.id === defaultId
          const switchable = channels.length > 1
          return (
            <button
              key={channel.id}
              type="button"
              disabled={!switchable}
              onClick={() => {
                if (!switchable || isActive) return
                setSettings({ activeProfileId: channel.id })
              }}
              className={`flex w-full items-start justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition ${
                isActive
                  ? 'border-blue-300 bg-blue-50/60 dark:border-blue-500/40 dark:bg-blue-500/[0.08]'
                  : 'border-gray-200/70 bg-white/60 dark:border-white/[0.08] dark:bg-white/[0.03]'
              } ${switchable && !isActive ? 'hover:border-blue-200 hover:bg-blue-50/40 dark:hover:bg-blue-500/[0.05]' : ''} ${!switchable ? 'cursor-default' : ''}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-gray-700 dark:text-gray-200">{channel.name}</span>
                  <span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-400">
                    {getApiProviderLabel(settings, channel.provider)}
                  </span>
                  {isDefault && (
                    <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
                      默认
                    </span>
                  )}
                </div>
                <div className="mt-1.5 truncate text-xs text-gray-500 dark:text-gray-500">
                  模型 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">{channel.model || '未指定'}</code>
                </div>
                {channel.description && (
                  <div data-selectable-text className="mt-1.5 text-xs leading-5 text-gray-500 dark:text-gray-500">
                    {channel.description}
                  </div>
                )}
              </div>
              {isActive && (
                <span className="mt-0.5 flex shrink-0 items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400">
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                  使用中
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="text-xs leading-relaxed text-gray-400 dark:text-gray-500">
        需要新增渠道或调整模型？请联系站点管理员。
      </div>
    </div>
  )
}
