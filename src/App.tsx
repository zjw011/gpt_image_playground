import { useEffect, useState } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { initStore, restoreExplicitPresetConfig, useStore } from './store'
import { buildSettingsFromUrlParams, clearUrlSettingParams, getExplicitUrlSettingsIds, hasUrlSettingParams } from './lib/urlSettings'
import { createDefaultOpenAIProfile, hasDefaultPresetConfig, isAgentTextApiProfile, normalizeSettings } from './lib/apiProfiles'
import { getCustomProviderConfigUrl, hasEmbeddedDefaultConfig, loadCustomProviderSettingsFromUrl, loadEmbeddedDefaultConfig } from './lib/customProviderConfigUrl'
import { getDefaultPresetProfileId, getPresetProfileIds, isPresetConfigOnlyEnabled, setBackendManagedMode, setPresetConfig } from './lib/presetConfig'
import { backendAgentSettings, backendBootstrapToPresetConfig, getBootstrapFailure, loadBackendBootstrap, type BackendBootstrap } from './lib/backend'
import { syncWorkspaceId } from './lib/workspace'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import type { AppSettings } from './types'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import RedeemCardModal from './components/RedeemCardModal'
import { FavoriteCollectionPickerModal, ManageCollectionsModal } from './components/FavoriteCollections'
import { PageLoading } from './pages/theme'
import BootstrapError from './components/BootstrapError'
import { useGlobalClickSuppression } from './lib/clickSuppression'

let defaultConfigImportStarted = false
// 引导结果整页只算一次：App 在「/studio 这一族路由 ↔ 其它分支（帮助中心/后台/登录）」之间
// 来回导航时会被反复挂载，每次都重跑「拉 bootstrap + IndexedDB 水合 + 配置导入」，
// 慢服务器上就是用户看到的「点一下菜单卡一下、整屏正在进入绘想」。
// 这里把整条链缓存成 Promise，重进 App 时直接复用现成结果，同步给组件状态，秒开。
let appBootstrapPromise: Promise<BackendBootstrap | null> | null = null

function startAppBootstrap(setBackend: (b: BackendBootstrap | null) => void, setFailure: (message: string | null) => void) {
  if (appBootstrapPromise) return appBootstrapPromise
  defaultConfigImportStarted = true
  // 是否已经向组件通报过 bootstrap 结果：失败兜底时要据此决定是置 null 还是保留现状
  let announced: BackendBootstrap | null | undefined

  const searchParams = new URLSearchParams(window.location.search)
    const customProviderConfigUrl = getCustomProviderConfigUrl()
    const embeddedDefaultConfig = hasEmbeddedDefaultConfig()
    const loadDefaultConfig = () => embeddedDefaultConfig
      ? Promise.resolve().then(() => loadEmbeddedDefaultConfig())
      : loadCustomProviderSettingsFromUrl(customProviderConfigUrl)

    const applyUrlSettings = async (baseSettings: Partial<AppSettings>) => {
      const ids = getExplicitUrlSettingsIds(searchParams)
      const restored = await restoreExplicitPresetConfig(ids)
      const restoredSettings = useStore.getState().settings
      const sourceSettings = restored
        ? { ...restoredSettings, ...baseSettings, customProviders: restoredSettings.customProviders, profiles: restoredSettings.profiles }
        : baseSettings
      const nextSettings = buildSettingsFromUrlParams(sourceSettings, searchParams)
      return Object.keys(nextSettings).length ? nextSettings : sourceSettings
    }

    const clearAppliedUrlSettings = () => {
      if (!hasUrlSettingParams(searchParams)) return

      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    // 部署窗口里第一次请求经常吃 502：先自己重试几轮，绝大多数用户不会看到失败页。
    const loadWithRetry = async () => {
      let data: BackendBootstrap | null = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        data = await loadBackendBootstrap()
        if (getBootstrapFailure() === null) return data
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)))
      }
      return data
    }

    const promise = loadWithRetry()
      .then((data) => {
        // 三次都失败：明确告诉用户"站点在更新"，不要静默退回纯前端模式
        const failure = getBootstrapFailure()
        if (failure && !data) {
          setFailure(failure)
          setBackend(null)
          return null
        }
        setFailure(null)
        // 工作区决定 localStorage 键与 IndexedDB 库名，而 store 已经用缓存的工作区水合过了。
        // 身份和上次不一致时只能刷新重来，否则会把上一个账号的数据显示给当前账号。
        if (syncWorkspaceId(data?.workspaceId)) {
          window.location.reload()
          // 页面马上整个重来，这里的返回值没人消费，给齐类型即可
          return data
        }

        setBackend(data)
        setBackendManagedMode(Boolean(data))
        return initStore().then(async () => {
          // 后端托管模式：渠道全部来自服务端，跳过 URL / 内嵌配置那套导入逻辑。
          if (data) {
            const backendConfig = backendBootstrapToPresetConfig(data)
            setPresetConfig(backendConfig)
            await useStore.getState().setPresetImportedSettings(backendConfig)
            const state = useStore.getState()
            state.setSettings(normalizeSettings({
              ...state.settings,
              channelFailover: data.site.failoverEnabled,
              channelFailoverMaxAttempts: data.site.failoverMaxAttempts,
              // Agent 也由后台总控：用户不需要（也无法）自己挑文本/图像渠道。
              ...backendAgentSettings(data),
            }))
            clearAppliedUrlSettings()
            return data
          }

          const importedSettings = embeddedDefaultConfig || customProviderConfigUrl
            ? await loadDefaultConfig()
            : hasDefaultPresetConfig()
              ? {
                  customProviders: [],
                  profiles: [{ ...createDefaultOpenAIProfile(), isDefault: true }],
                }
              : null
          setPresetConfig(importedSettings)

          const state = useStore.getState()
          if (importedSettings) {
            await state.setPresetImportedSettings(importedSettings)
          } else if (state.previousPresetConfig) {
            await state.setPresetImportedSettings({ customProviders: [], profiles: [] })
          }

          const syncedState = useStore.getState()
          if (!importedSettings) {
            useStore.setState({ dismissedPresetProfileIds: [], dismissedPresetProviderIds: [] })
            if (syncedState.settings.profiles.some((profile) => profile.isDefault)) {
              syncedState.setSettings({
                profiles: syncedState.settings.profiles.map((profile) => profile.isDefault ? { ...profile, isDefault: undefined } : profile),
              })
            }
          }

          const current = useStore.getState()
          const presetIds = getPresetProfileIds()
          const defaultPresetId = getDefaultPresetProfileId()
          const settings = isPresetConfigOnlyEnabled()
            ? normalizeSettings({
                ...current.settings,
                activeProfileId: presetIds.has(current.settings.activeProfileId)
                  ? current.settings.activeProfileId
                  : defaultPresetId ?? [...presetIds][0],
                agentTextProfileId: current.settings.agentTextProfileId && presetIds.has(current.settings.agentTextProfileId)
                  ? current.settings.agentTextProfileId
                  : current.settings.profiles.find((profile) => presetIds.has(profile.id) && isAgentTextApiProfile(profile))?.id ?? null,
                agentImageProfileId: current.settings.agentImageProfileId && presetIds.has(current.settings.agentImageProfileId)
                  ? current.settings.agentImageProfileId
                  : defaultPresetId ?? [...presetIds][0],
              })
            : current.settings
          current.setSettings(await applyUrlSettings(settings))
          clearAppliedUrlSettings()
          return data
        })
      })
      .catch((error) => {
        console.warn('Failed to import preset config:', error)
        setBackend(announced ?? null)
        setPresetConfig(null)
        const state = useStore.getState()
        void applyUrlSettings(state.settings).then((settings) => {
          useStore.getState().setSettings(settings)
          clearAppliedUrlSettings()
        })
        // 引导失败按"无后端"处理：界面照常可用，只是没有托管配置
        return null
      })
  appBootstrapPromise = promise
  return promise
}

export default function App() {
  // null 表示尚未确定是否为后端托管模式，此期间不渲染主界面，避免闪现未锁定的设置。
  const [backend, setBackend] = useState<BackendBootstrap | null | undefined>(undefined)
  // 引导彻底失败（站点在更新/连不上）：显示专门的重试页，而不是当成纯前端模式继续
  const [bootstrapFailure, setBootstrapFailure] = useState<string | null>(null)
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()

  useEffect(() => {
    void startAppBootstrap(setBackend, setBootstrapFailure).then((data) => {
      // 首次挂载时 startAppBootstrap 内部已经提前 set 过一次（bootstrap 一回来就渲染）；
      // SPA 里重进 App 时靠这里把缓存好的最终结果立刻吐出来，不再等网络。
      setBackend(data)
    })
  }, [])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  useEffect(() => {
    if (backend) document.title = backend.site.title
  }, [backend])

  if (bootstrapFailure) return <BootstrapError message={bootstrapFailure} />
  if (backend === undefined) return <PageLoading text="正在进入绘想…" />

  // 登录门禁：新版登录/注册页在 /login、/register，未登录直接跳转过去。
  if (backend && backend.accessMode !== 'open' && !backend.authenticated) {
    return <Navigate to="/login" replace />
  }

  return (
    <>
      <Outlet />
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      <RedeemCardModal />
      <FavoriteCollectionPickerModal />
      <ManageCollectionsModal />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
    </>
  )
}
