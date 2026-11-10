import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useStore } from '../store'
import { isTaskInProgress } from '../lib/taskState'
import { BrandMark } from '../pages/theme'

// 只短暂保留亲眼观察到结束的任务，导入作品和刷新页面不会刷出历史通知。
const COMPLETION_VISIBLE_MS = 20_000

export default function TaskProgressDock({ children }: { children?: ReactNode }) {
  const tasks = useStore((s) => s.tasks)
  const location = useLocation()
  const [now, setNow] = useState(Date.now)
  const [tracked, setTracked] = useState<Record<string, number | null>>({})
  const [expanded, setExpanded] = useState(() => typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 768px)').matches)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(min-width: 768px)')
    const resize = () => setExpanded(media.matches)
    media.addEventListener('change', resize)
    return () => media.removeEventListener('change', resize)
  }, [])

  useEffect(() => {
    setTracked((previous) => {
      const next: Record<string, number | null> = {}
      for (const task of tasks) {
        if (isTaskInProgress(task)) {
          next[task.id] = null
          continue
        }
        if (!(task.id in previous)) continue
        const ended = previous[task.id] ?? Date.now()
        if (now - ended < COMPLETION_VISIBLE_MS) next[task.id] = ended
      }
      const ids = Object.keys(next)
      return ids.length === Object.keys(previous).length && ids.every((id) => previous[id] === next[id]) ? previous : next
    })
  }, [tasks, now])

  const visible = tasks.filter((task) => isTaskInProgress(task) || (task.id in tracked && (tracked[task.id] === null || now - tracked[task.id]! < COMPLETION_VISIBLE_MS)))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const active = visible.length > 0
  const runningCount = visible.filter(isTaskInProgress).length
  const currentTask = location.pathname === '/result' ? new URLSearchParams(location.search).get('task') : null

  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    // 所有蝴蝶共用一只时钟，按时间戳算耗时，后台标签页节流也不会少算。
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    const refresh = () => { if (!document.hidden) setNow(Date.now()) }
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [active])

  const times = visible.map((task) => {
    const ms = isTaskInProgress(task) ? now - task.createdAt : task.elapsed ?? (task.finishedAt ?? tracked[task.id] ?? now) - task.createdAt
    const seconds = Math.max(0, Math.floor(ms / 1000))
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  })
  const compactIndex = Math.max(0, visible.findIndex(isTaskInProgress))

  return (
    <div className="task-progress-layout" data-dock-active={active}>
      {children}
      {active && <section className="task-progress-dock" aria-label="生成任务进度" data-expanded={expanded}>
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {runningCount ? `${runningCount} 个任务生成中。` : ''}{visible.length > runningCount ? `${visible.length - runningCount} 个任务已结束，可以查看结果。` : ''}
        </p>
        {expanded ? <>
          <div className="task-progress-heading">
            <span>{runningCount ? <>创作中 <b>{runningCount}</b></> : '任务已结束'}</span>
            <button type="button" aria-label="收起任务进度" aria-expanded="true" aria-controls="task-progress-list" onClick={() => setExpanded(false)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>
          <div id="task-progress-list" className="task-progress-list" data-task-list>
            {visible.map((task, idx) => {
              const running = isTaskInProgress(task)
              const recovering = running && Boolean(task.falRecoverable || task.customRecoverable)
              const partial = !running && task.outputImages.length > 0 && (task.status === 'error' || Boolean(task.outputErrors?.length))
              const state = running ? 'running' : partial ? 'partial' : task.status === 'done' ? 'done' : 'error'
              const status = recovering ? '恢复查询中' : running ? task.liveFrameCount ? `${task.liveFramesCompleted ?? 0}/${task.liveFrameCount} 帧` : '生成中' : partial ? '部分完成' : task.status === 'done' ? '已完成' : '未完成'
              const elapsed = times[idx]
              return <Link
                key={task.id}
                to={`/result?task=${encodeURIComponent(task.id)}`}
                data-task-id={task.id}
                data-state={state}
                aria-current={currentTask === task.id ? 'page' : undefined}
                aria-label={`任务 ${idx + 1}，${status}，查看：${task.prompt}`}
                title={`${status} · ${running ? '已等待' : '用时'} ${elapsed}\n${task.prompt}`}
                className="task-progress-butterfly"
                onClick={() => {
                  if (running) return
                  setTracked((previous) => {
                    const next = { ...previous }
                    delete next[task.id]
                    return next
                  })
                }}
              >
                <span className="task-progress-time" role="timer" aria-live="off" aria-label={`${running ? '已等待' : '用时'} ${elapsed}`}>{elapsed}</span>
                <span className="task-progress-wings" style={{ animationDelay: `${idx % 5 * -0.6}s` }}>
                  <span className="task-progress-glow" aria-hidden="true" />
                  <BrandMark className="task-progress-mark" />
                  <span className="task-progress-spark" aria-hidden="true">✦</span>
                </span>
                <span className="task-progress-status"><span className="task-progress-dot" aria-hidden="true" />{status}</span>
                <span className="task-progress-index" aria-hidden="true">{String(idx + 1).padStart(2, '0')}</span>
              </Link>
            })}
          </div>
          <span className="task-progress-caption">轻点蝴蝶查看</span>
        </> : <button type="button" className="task-progress-compact" aria-label="展开任务进度" aria-expanded="false" aria-controls="task-progress-list" onClick={() => setExpanded(true)}>
          <span className="task-progress-time" role="timer" aria-live="off" aria-label={`${runningCount ? '最早生成任务已等待' : '用时'} ${times[compactIndex]}`}>{times[compactIndex]}</span>
          <BrandMark className="task-progress-compact-mark" />
          <span className="task-progress-count">{runningCount || visible.length}</span>
          <span className="task-progress-compact-label">{runningCount ? visible[compactIndex].falRecoverable || visible[compactIndex].customRecoverable ? '恢复查询中' : '创作中' : '查看结果'}</span>
        </button>}
      </section>}
    </div>
  )
}
