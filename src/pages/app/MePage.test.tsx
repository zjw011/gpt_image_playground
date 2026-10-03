// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Link, MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type TaskRecord } from '../../types'
import MePage from './MePage'

const state = vi.hoisted(() => ({
  tasks: [] as TaskRecord[],
  streamPreviews: {} as Record<string, string>,
  toast: vi.fn(),
}))
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../store', () => ({
  useStore: (selector: (value: unknown) => unknown) => selector({
    tasks: state.tasks,
    streamPreviews: state.streamPreviews,
    showToast: state.toast,
  }),
}))
vi.mock('./AppShell', () => ({
  default: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}))
vi.mock('./useTaskImage', () => ({ useThumbnail: () => null }))
vi.mock('../../lib/creditsStore', () => ({
  useCreditsStore: (selector: (value: unknown) => unknown) => selector({ view: null }),
}))
vi.mock('../../lib/backend', () => ({
  getBackendUser: () => null,
  getCreditsConfig: () => null,
  getInviteInfo: () => null,
  fetchCredits: vi.fn(),
  submitFrontLogout: vi.fn(),
  submitUserProfile: vi.fn(),
}))

function Location() {
  const location = useLocation()
  return <><output>{location.pathname + location.search}</output><Link to="/me?tab=ledger" data-testid="ledger">积分记录</Link><Link to="/me?tab=works" data-testid="works">返回作品</Link></>
}

function task(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    prompt: `作品 ${id}`,
    params: DEFAULT_PARAMS,
    inputImageIds: [],
    outputImages: [`output-${id}`],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...patch,
  }
}

describe('MePage work filters', () => {
  let container: HTMLDivElement
  let root: Root

  const renderPage = async (url = '/me?tab=works') => {
    await act(async () => root.render(<MemoryRouter initialEntries={[url]}><MePage /><Location /></MemoryRouter>))
  }
  const workLinks = () => Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href^="/result?task="]'))
  const tabs = () => Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).filter((link) => /^(全部|收藏|失败)\s+\d+$/.test(link.textContent ?? ''))
  const clickTab = async (name: '全部' | '收藏' | '失败') => {
    const link = tabs().find((item) => item.textContent?.startsWith(name))
    expect(link).toBeTruthy()
    await act(async () => link!.click())
  }

  beforeEach(() => {
    state.tasks = [
      task('done-favorite', { isFavorite: true }),
      task('failed-empty', { status: 'error', outputImages: [], isFavorite: true, error: '私密上游错误详情', apiProfileName: '私密渠道名称' }),
      task('running-favorite', { status: 'running', outputImages: [], finishedAt: null, isFavorite: true }),
      task('failed-partial', { status: 'error', outputImages: ['partial-output'], isFavorite: true, error: '另一个私密错误', apiProfileName: '另一个私密渠道' }),
      task('done-normal'),
      task('done-empty', { outputImages: [], isFavorite: true }),
    ]
    state.streamPreviews = {}
    state.toast.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('shows all, favorites and failed tabs in order with mutually consistent counts', async () => {
    await renderPage()
    expect(tabs().map((link) => link.textContent)).toEqual(['全部 3', '收藏 2', '失败 2'])
    expect(tabs().map((link) => link.getAttribute('href'))).toEqual(['/me?tab=works', '/me?tab=works&fav=1', '/me?tab=works&filter=failed'])
    expect(tabs().map((link) => link.getAttribute('aria-current'))).toEqual(['page', null, null])
    expect(workLinks().map((link) => link.getAttribute('href'))).toEqual(['/result?task=done-favorite', '/result?task=running-favorite', '/result?task=done-normal'])
    expect(container.textContent).toContain('生成中')
    expect(container.textContent).not.toContain('生成失败 · 查看并重试')
  })

  it('filters favorites from normal works only and preserves running favorites', async () => {
    await renderPage()
    await clickTab('收藏')
    expect(container.querySelector('output')?.textContent).toBe('/me?tab=works&fav=1')
    expect(tabs().map((link) => link.getAttribute('aria-current'))).toEqual([null, 'page', null])
    expect(workLinks().map((link) => link.getAttribute('href'))).toEqual(['/result?task=done-favorite', '/result?task=running-favorite'])
    expect(container.textContent).not.toContain('生成失败 · 查看并重试')
  })

  it('shows empty and partially produced errors only in failed with individual result links', async () => {
    await renderPage()
    await clickTab('失败')
    expect(container.querySelector('output')?.textContent).toBe('/me?tab=works&filter=failed')
    expect(tabs().map((link) => link.getAttribute('aria-current'))).toEqual([null, null, 'page'])
    expect(workLinks().map((link) => link.getAttribute('href'))).toEqual(['/result?task=failed-empty', '/result?task=failed-partial'])
    expect(workLinks().every((link) => link.textContent?.includes('生成失败'))).toBe(true)
    expect(container.textContent).not.toContain('私密上游错误详情')
    expect(container.textContent).not.toContain('私密渠道名称')
    expect(container.textContent).not.toContain('另一个私密错误')
    expect(container.textContent).not.toContain('另一个私密渠道')
  })

  it.each(['/me?tab=favorites', '/me?tab=works&fav=1'])('keeps the previous favorites URL working: %s', async (url) => {
    await renderPage(url)
    expect(tabs().find((link) => link.getAttribute('aria-current') === 'page')?.textContent).toBe('收藏 2')
    expect(workLinks().map((link) => link.getAttribute('href'))).toEqual(['/result?task=done-favorite', '/result?task=running-favorite'])
  })

  it.each(['/me?tab=works&filter=failed&fav=1', '/me?tab=favorites&filter=failed'])('gives the failed filter priority over old favorites parameters: %s', async (url) => {
    await renderPage(url)
    expect(tabs().find((link) => link.getAttribute('aria-current') === 'page')?.textContent).toBe('失败 2')
    expect(workLinks().map((link) => link.getAttribute('href'))).toEqual(['/result?task=failed-empty', '/result?task=failed-partial'])
  })

  it('moves a running task out of all into failed when its status changes, even after partial output', async () => {
    state.tasks = [task('transition', { status: 'running', outputImages: [], finishedAt: null })]
    await renderPage()
    expect(workLinks()).toHaveLength(1)
    expect(tabs().map((link) => link.textContent)).toEqual(['全部 1', '收藏 0', '失败 0'])
    state.tasks = [{ ...state.tasks[0], status: 'error', outputImages: ['partial'], error: '不可暴露的错误', finishedAt: 3 }]
    await renderPage()
    expect(workLinks()).toHaveLength(0)
    expect(tabs().map((link) => link.textContent)).toEqual(['全部 0', '收藏 0', '失败 1'])
    await clickTab('失败')
    expect(workLinks().map((link) => link.getAttribute('href'))).toEqual(['/result?task=transition'])
    expect(container.textContent).not.toContain('不可暴露的错误')
  })

  it('keeps the empty all and favorites states when the only saved records failed or have no output', async () => {
    state.tasks = [task('failed', { status: 'error', outputImages: ['partial'], isFavorite: true }), task('empty', { outputImages: [], isFavorite: true })]
    await renderPage()
    expect(workLinks()).toHaveLength(0)
    expect(container.textContent).toContain('还没有作品')
    expect(container.querySelector('a[href="/studio"]')?.textContent).toBe('立即创作')
    await clickTab('收藏')
    expect(workLinks()).toHaveLength(0)
    expect(container.textContent).toContain('还没有收藏')
    expect(container.querySelector('a[href="/studio"]')).toBeNull()
  })

  it('shows an explicit empty failed state without listing successful works', async () => {
    state.tasks = [task('success')]
    await renderPage('/me?tab=works&filter=failed')
    expect(workLinks()).toHaveLength(0)
    expect(container.textContent).toMatch(/还没有失败|暂无失败|没有失败任务|没有失败记录/)
    expect(tabs().map((link) => link.textContent)).toEqual(['全部 1', '收藏 0', '失败 0'])
  })

  it('resets each work filter to 48 cards after loading more and switching tabs', async () => {
    state.tasks = [
      ...Array.from({ length: 100 }, (_, index) => task(`normal-${index}`, { isFavorite: true })),
      ...Array.from({ length: 100 }, (_, index) => task(`error-${index}`, { status: 'error', outputImages: [], isFavorite: true })),
    ]
    await renderPage()
    expect(workLinks()).toHaveLength(48)
    for (const next of ['收藏', '失败', '全部'] as const) {
      const more = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('加载更多'))
      expect(more?.textContent).toContain('52')
      await act(async () => more!.click())
      expect(workLinks()).toHaveLength(96)
      await clickTab(next)
      expect(workLinks()).toHaveLength(48)
    }
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('加载更多'))!.click())
    expect(workLinks()).toHaveLength(96)
    await act(async () => container.querySelector<HTMLAnchorElement>('[data-testid="ledger"]')!.click())
    await act(async () => container.querySelector<HTMLAnchorElement>('[data-testid="works"]')!.click())
    expect(workLinks()).toHaveLength(48)
  })
})
