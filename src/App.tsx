import { useEffect, useState } from 'react'
import { initStore, restoreExplicitPresetConfig, useStore } from './store'
import { buildSettingsFromUrlParams, clearUrlSettingParams, getExplicitUrlSettingsIds, hasUrlSettingParams } from './lib/urlSettings'
import { createDefaultOpenAIProfile, hasDefaultPresetConfig, isAgentTextApiProfile, normalizeSettings } from './lib/apiProfiles'
import { getCustomProviderConfigUrl, hasEmbeddedDefaultConfig, loadCustomProviderSettingsFromUrl, loadEmbeddedDefaultConfig } from './lib/customProviderConfigUrl'
import { getDefaultPresetProfileId, getPresetProfileIds, isPresetConfigOnlyEnabled, setBackendManagedMode, setPresetConfig } from './lib/presetConfig'
import { backendBootstrapToPresetConfig, loadBackendBootstrap, type BackendBootstrap } from './lib/backend'
import { syncWorkspaceId } from './lib/workspace'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import type { AppSettings } from './types'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import AgentWorkspace from './components/AgentWorkspace'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import SupportPromptModal from './components/SupportPromptModal'
import BackendGate from './components/BackendGate'
import { FavoriteCollectionPickerModal, FavoriteCollectionsView, ManageCollectionsModal } from './components/FavoriteCollections'
import { useGlobalClickSuppression } from './lib/clickSuppression'

let defaultConfigImportStarted = false

export default function App() {
  const appMode = useStore((s) => s.appMode)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  // null 表示尚未确定是否为后端托管模式，此期间不渲染主界面，避免闪现未锁定的设置。
  const [backend, setBackend] = useState<BackendBootstrap | null | undefined>(undefined)
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()

  useEffect(() => {
    if (defaultConfigImportStarted) return
    defaultConfigImportStarted = true

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

    void loadBackendBootstrap()
      .then((data) => {
        // 工作区决定 localStorage 键与 IndexedDB 库名，而 store 已经用缓存的工作区水合过了。
        // 身份和上次不一致时只能刷新重来，否则会把上一个账号的数据显示给当前账号。
        if (syncWorkspaceId(data?.workspaceId)) {
          window.location.reload()
          return
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
            }))
            clearAppliedUrlSettings()
            return
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
        })
      })
      .catch((error) => {
        console.warn('Failed to import preset config:', error)
        setBackend((current) => current === undefined ? null : current)
        setPresetConfig(null)
        const state = useStore.getState()
        void applyUrlSettings(state.settings).then((settings) => {
          useStore.getState().setSettings(settings)
          clearAppliedUrlSettings()
        })
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

  if (backend === undefined) return null

  if (backend && backend.accessMode !== 'open' && !backend.authenticated) {
    return <BackendGate title={backend.site.title} accessMode={backend.accessMode} onUnlocked={() => window.location.reload()} />
  }

  return (
    <>
      <Header />
      {appMode === 'agent' ? (
        <AgentWorkspace />
      ) : (
        <main data-home-main data-drag-select-surface className="pb-48">
          <div className="safe-area-x max-w-7xl mx-auto">
            <SearchBar />
            {filterFavorite && !activeFavoriteCollectionId ? <FavoriteCollectionsView /> : <TaskGrid />}
          </div>
        </main>
      )}
      <InputBar />
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      <SupportPromptModal />
      <FavoriteCollectionPickerModal />
      <ManageCollectionsModal />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
    </>
  )
}
