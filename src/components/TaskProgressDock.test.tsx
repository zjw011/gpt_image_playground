// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import { useStore } from '../store'
import TaskProgressDock from './TaskProgressDock'

vi.mock('../store', async () => {
  const { create } = await import('zustand')
  return { useStore: create(() => ({ tasks: [] as TaskRecord[] })) }
})

function Page() {
  const location = useLocation()
  const navigate = useNavigate()
  return <main><output>{location.pathname + location.search}</output><button onClick={() => navigate('/me?tab=works')}>切换作品页</button></main>
}

function task(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id, prompt: `任务 ${id} 的创作描述`, params: { ...DEFAULT_PARAMS }, inputImageIds: [], outputImages: [],
    status: 'running', createdAt: Date.now() - 9000, finishedAt: null, elapsed: null, error: null,
    ...patch,
  }
}

describe('蝴蝶任务进度浮层', () => {
  let el: HTMLDivElement
  let root: Root | null
  let desktop: boolean
  const render = async () => act(async () => root!.render(<MemoryRouter initialEntries={['/studio']}><TaskProgressDock><Page /></TaskProgressDock></MemoryRouter>))
  const update = async (tasks: TaskRecord[]) => act(async () => useStore.setState({ tasks }))
  const advance = async (ms: number) => act(async () => vi.advanceTimersByTime(ms))
  const dock = () => el.querySelector('[aria-label="生成任务进度"]')
  const link = (id: string) => Array.from(el.querySelectorAll<HTMLAnchorElement>('a[data-task-id]')).find((item) => item.dataset.taskId === id)
  const time = (id: string) => link(id)?.querySelector('[role="timer"]')?.textContent

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T08:00:00Z'))
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    desktop = true
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? false : query.includes('min-width') ? desktop : !desktop,
      media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })))
    useStore.setState({ tasks: [] })
    el = document.createElement('div')
    document.body.append(el)
    root = createRoot(el)
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    el.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('没有进行中的任务时不展示浮层，历史成功和失败也不自动弹出', async () => {
    await update([
      task('old-done', { status: 'done', finishedAt: Date.now(), outputImages: ['old-image'] }),
      task('old-error', { status: 'error', finishedAt: Date.now(), error: '旧错误' }),
    ])
    await render()
    expect(dock()).toBeNull()
    expect(el.querySelector('main')?.textContent).toContain('/studio')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('一条任务一只品牌蝴蝶，用各自开始时间计时且只使用一个时钟', async () => {
    await update([task('new'), task('older', { createdAt: Date.now() - 64000 })])
    await render()
    expect(el.querySelectorAll('a[data-task-id]')).toHaveLength(2)
    expect(time('new')).toContain('0:09')
    expect(time('older')).toContain('1:04')
    expect(link('new')?.querySelector('img')?.getAttribute('src')).toContain('/brand/logo-mark.png')
    expect(vi.getTimerCount()).toBe(1)
    await advance(2000)
    expect(time('new')).toContain('0:11')
    expect(time('older')).toContain('1:06')
  })

  it('跨应用页面继续计时，蝴蝶链接编码任务 ID 并进入对应结果', async () => {
    const id = 'task /?中文'
    await update([task(id)])
    await render()
    await act(async () => el.querySelector<HTMLButtonElement>('main button')!.click())
    expect(el.querySelector('output')?.textContent).toBe('/me?tab=works')
    await advance(3000)
    expect(time(id)).toContain('0:12')
    expect(link(id)?.getAttribute('href')).toBe(`/result?task=${encodeURIComponent(id)}`)
    await act(async () => link(id)!.click())
    expect(el.querySelector('output')?.textContent).toBe(`/result?task=${encodeURIComponent(id)}`)
    expect(useStore.getState().tasks[0].status).toBe('running')
    expect(link(id)).toBeDefined()
  })

  it('标签页恢复时按真实时间追赶，计时不依赖后台执行了多少次回调', async () => {
    await update([task('background')])
    await render()
    vi.setSystemTime(Date.now() + 90000)
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(time('background')).toContain('1:39')
  })

  it.each(['done', 'error'] as const)('观察到 %s 后冻结耗时并在 20 秒后退出，保留原任务记录', async (status) => {
    const running = task('finishing')
    await update([running])
    await render()
    await advance(6000)
    const finished = { ...running, status, finishedAt: Date.now(), elapsed: 15000, outputImages: status === 'done' ? ['image'] : [], error: status === 'error' ? '未完成' : null }
    await update([finished])
    expect(link('finishing')?.textContent).toContain(status === 'done' ? '已完成' : '未完成')
    expect(time('finishing')).toContain('0:15')
    await advance(19000)
    expect(time('finishing')).toContain('0:15')
    await advance(1000)
    expect(dock()).toBeNull()
    expect(useStore.getState().tasks).toEqual([finished])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('部分出图显示部分完成，点击结果后收起提醒而不删除作品', async () => {
    const running = task('partial')
    await update([running])
    await render()
    const partial = { ...running, status: 'done' as const, finishedAt: Date.now(), outputImages: ['saved'], outputErrors: [{ requestIndex: 1, error: '内容安全审核未通过' }] }
    await update([partial])
    expect(link('partial')?.textContent).toContain('部分完成')
    await act(async () => link('partial')!.click())
    expect(el.querySelector('output')?.textContent).toBe('/result?task=partial')
    expect(dock()).toBeNull()
    expect(useStore.getState().tasks).toEqual([partial])
  })

  it('Live 任务展示真实帧数，普通任务不虚构百分比', async () => {
    await update([task('live', { liveFrameCount: 6, liveFramesCompleted: 2 }), task('normal')])
    await render()
    expect(link('live')?.textContent).toContain('2/6')
    expect(link('normal')?.textContent).not.toContain('%')
  })

  it('收起和展开只改变显示，不取消任务或重置计时', async () => {
    const running = task('active')
    await update([running])
    await render()
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="收起任务进度"]')!.click())
    expect(el.querySelector('[aria-label="展开任务进度"]')).not.toBeNull()
    await advance(5000)
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="展开任务进度"]')!.click())
    expect(time('active')).toContain('0:14')
    expect(useStore.getState().tasks).toEqual([running])
  })

  it('移动端初始收起，可主动展开查看每条任务', async () => {
    desktop = false
    await update([task('one'), task('two')])
    await render()
    const toggle = el.querySelector<HTMLButtonElement>('[aria-label="展开任务进度"]')
    expect(toggle).not.toBeNull()
    await act(async () => toggle!.click())
    expect(el.querySelectorAll('a[data-task-id]')).toHaveLength(2)
  })

  it('删除最后一个任务立即移除浮层并停止时钟，卸载也清理时钟', async () => {
    await update([task('removed')])
    await render()
    await update([])
    expect(dock()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    await update([task('new')])
    expect(link('new')).toBeDefined()
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => root!.unmount())
    root = null
    expect(vi.getTimerCount()).toBe(0)
  })
})
