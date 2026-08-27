// 渠道故障转移：一个渠道出图失败时，按顺序换下一个渠道重试，直到成功或候选用尽。
// 纯逻辑放在这里，store.ts 只负责按候选列表循环调用。

import type { ApiProfile, AppSettings, TaskRecord } from '../types'
import { validateApiProfile } from './apiProfiles'

/** 本地前置校验失败，换渠道也一样会失败，不参与故障转移。 */
const LOCAL_FAILURE_PATTERNS = [
  /过大：/,
  /图片已不存在/,
  /遮罩图片已不存在/,
  /遮罩与主图尺寸不一致/,
  /找不到此任务所使用的 API 配置/,
]

export function isFailoverableError(err: unknown): boolean {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return false
  const message = err instanceof Error ? err.message : String(err)
  return !LOCAL_FAILURE_PATTERNS.some((pattern) => pattern.test(message))
}

/**
 * 候选渠道顺序：起始渠道排第一，其余按 settings.profiles 顺序补齐。
 * 只保留配置完整的渠道，避免把必然失败的配置算进尝试次数。
 */
export function getFailoverCandidates(settings: AppSettings, startProfile: ApiProfile): ApiProfile[] {
  const candidates = [startProfile]
  if (!settings.channelFailover) return candidates

  for (const profile of settings.profiles) {
    if (profile.id === startProfile.id) continue
    if (validateApiProfile(profile)) continue
    candidates.push(profile)
  }

  const limit = settings.channelFailoverMaxAttempts > 0
    ? Math.max(1, settings.channelFailoverMaxAttempts)
    : candidates.length
  return candidates.slice(0, limit)
}

/** 故障转移期间关闭流式：中间步骤图一旦推给前端就无法干净地换渠道重试。 */
export function withFailoverStreamingDisabled(profile: ApiProfile, willFailover: boolean): ApiProfile {
  if (!willFailover || !profile.streamImages) return profile
  return { ...profile, streamImages: false }
}

/** 看门狗预算：多渠道尝试的总耗时可能远超单个渠道的 timeout。 */
export function getFailoverTimeoutBudget(candidates: ApiProfile[]): number {
  return candidates.reduce((sum, profile) => sum + Math.max(0, profile.timeout), 0)
}

export function createFailoverAttempt(profile: ApiProfile, err: unknown): NonNullable<TaskRecord['failoverAttempts']>[number] {
  return {
    profileId: profile.id,
    profileName: profile.name,
    model: profile.model,
    error: err instanceof Error ? err.message : String(err),
    at: Date.now(),
  }
}

/** 全部候选都失败时的汇总错误文案。 */
export function formatFailoverError(attempts: NonNullable<TaskRecord['failoverAttempts']>, lastError: string): string {
  if (attempts.length <= 1) return lastError
  const lines = attempts.map((attempt, idx) => `${idx + 1}. ${attempt.profileName}：${attempt.error.split('\n')[0]}`)
  return `已尝试 ${attempts.length} 个渠道，全部失败：\n${lines.join('\n')}\n\n最后一个渠道的完整错误：\n${lastError}`
}
