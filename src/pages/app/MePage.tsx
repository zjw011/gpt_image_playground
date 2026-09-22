// 个人中心。对应设计稿 8：左侧资料卡 + 右侧菜单（作品/收藏/积分记录/订单/账号设置）。
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from '../../store'
import { getBackendUser, getCreditsConfig, submitFrontLogout, type BackendLedgerType } from '../../lib/backend'
import { useCreditsStore } from '../../lib/creditsStore'
import AppShell from './AppShell'
import { useThumbnail } from './useTaskImage'
import {
  IconImage, IconHeart, IconCoin, IconWallet, IconUser,
  IconLogout, IconSettings, IconSparkle,
} from '../icons'

const MENU = [
  { key: 'works', label: '我的作品', icon: IconImage },
  { key: 'favorites', label: '我的收藏', icon: IconHeart },
  { key: 'ledger', label: '积分记录', icon: IconCoin },
  { key: 'orders', label: '订单记录', icon: IconWallet },
  { key: 'settings', label: '账号设置', icon: IconSettings },
] as const

type MenuKey = (typeof MENU)[number]['key']

const LEDGER_LABELS: Record<BackendLedgerType, string> = {
  signup: '注册赠送',
  redeem: '卡密兑换',
  spend: '生成消耗',
  refund: '失败退款',
  admin: '管理员调整',
}

function WorkThumb({ imageId, taskId }: { imageId: string, taskId: string }) {
  const src = useThumbnail(imageId)
  return (
    <Link
      to={`/studio/result?task=${taskId}`}
      className="group relative aspect-square overflow-hidden rounded-2xl border border-[#eceaf6] bg-[#faf9fe]"
    >
      {src
        ? <img src={src} alt="" className="h-full w-full object-cover transition duration-300 group-hover:scale-105" />
        : <span className="flex h-full w-full items-center justify-center text-[#d8d4ec]"><IconImage className="h-7 w-7" /></span>}
    </Link>
  )
}

function EmptyState({ text, cta }: { text: string, cta?: string }) {
  return (
    <div className="flex flex-col items-center rounded-3xl border border-[#eceaf6] bg-white py-20 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#efedfd] text-[#7c6cf6]">
        <IconSparkle className="h-6 w-6" />
      </span>
      <p className="mt-4 text-sm text-[#8a86ac]">{text}</p>
      {cta && (
        <Link to="/studio" className="mt-5 rounded-full bg-gradient-to-r from-[#7c6cf6] to-[#a78bfa] px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-[#7c6cf6]/25">
          {cta}
        </Link>
      )}
    </div>
  )
}

export default function MePage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const tasks = useStore((s) => s.tasks)
  const showToast = useStore((s) => s.showToast)
  const user = getBackendUser()
  const credits = getCreditsConfig()
  const view = useCreditsStore((s) => s.view)

  const tab: MenuKey = (MENU.some((item) => item.key === searchParams.get('tab')) ? searchParams.get('tab') : 'works') as MenuKey
  const name = user?.displayName || user?.username || '本地创作者'
  const doneTasks = tasks.filter((task) => task.status === 'done' && task.outputImages.length > 0)
  const favoriteTasks = tasks.filter((task) => task.isFavorite)

  const logout = async () => {
    try {
      await submitFrontLogout()
    } catch {
      // 网络失败也照常跳走：会话本来就是服务端判的
    }
    window.location.assign(import.meta.env.BASE_URL)
  }

  const switchTab = (key: MenuKey) => {
    navigate(key === 'works' ? '/me?tab=works' : `/me?tab=${key}`, { replace: true })
  }

  const gridTasks = tab === 'works' ? doneTasks : favoriteTasks

  return (
    <AppShell title="个人中心" wide>
      {/* 资料卡 */}
      <div className="flex flex-wrap items-center gap-6 rounded-3xl border border-[#eceaf6] bg-white p-6 shadow-sm">
        {user?.avatar ? (
          <img src={user.avatar} alt="" className="h-20 w-20 rounded-full object-cover ring-4 ring-[#efedfd]" />
        ) : (
          <span className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-[#7c6cf6] to-[#a78bfa] text-2xl font-bold text-white ring-4 ring-[#efedfd]">
            {name.slice(0, 1)}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="truncate text-xl font-bold">{name}</h2>
          <p className="mt-1 text-xs text-[#a5a1c4]">
            {user ? `UID: ${user.id.slice(0, 8)}` : '纯前端模式，数据保存在本机浏览器'}
            {user?.email ? ` · ${user.email}` : ''}
          </p>
        </div>
        <div className="ml-auto flex gap-8 pr-2 text-center">
          <div>
            <p className="text-2xl font-bold">{doneTasks.length}</p>
            <p className="mt-0.5 text-xs text-[#a5a1c4]">作品</p>
          </div>
          {credits && (
            <div>
              <p className="text-2xl font-bold text-[#6b5ce7]">{(view?.available ?? 0).toLocaleString()}</p>
              <p className="mt-0.5 text-xs text-[#a5a1c4]">积分</p>
            </div>
          )}
          <div>
            <p className="text-2xl font-bold">{favoriteTasks.length}</p>
            <p className="mt-0.5 text-xs text-[#a5a1c4]">收藏</p>
          </div>
        </div>
      </div>

      <div className="mt-5 flex gap-5">
        {/* 菜单 */}
        <div className="flex w-[190px] shrink-0 flex-col gap-1 self-start rounded-3xl border border-[#eceaf6] bg-white p-3 shadow-sm">
          {MENU.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => switchTab(item.key)}
              className={`flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-left text-sm font-medium transition ${
                tab === item.key ? 'bg-[#efedfd] text-[#6b5ce7]' : 'text-[#6f6a94] hover:bg-[#f5f4fb]'
              }`}
            >
              <item.icon className="h-[17px] w-[17px]" />
              {item.label}
            </button>
          ))}
          {user && (
            <button
              type="button"
              onClick={() => void logout()}
              className="mt-1 flex items-center gap-2.5 rounded-xl border-t border-[#f1effa] px-3.5 py-2.5 pt-3.5 text-left text-sm font-medium text-red-400 transition hover:bg-red-50 hover:text-red-500"
            >
              <IconLogout className="h-[17px] w-[17px]" />
              退出登录
            </button>
          )}
        </div>

        {/* 内容区 */}
        <div className="min-w-0 flex-1">
          {(tab === 'works' || tab === 'favorites') && (
            gridTasks.length === 0 ? (
              <EmptyState
                text={tab === 'works' ? '还没有作品，第一张图免费画' : '还没有收藏，看到喜欢的点颗心吧'}
                cta={tab === 'works' ? '立即创作' : undefined}
              />
            ) : (
              <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-4">
                {gridTasks.map((task) => (
                  <WorkThumb key={task.id} imageId={task.outputImages[0]} taskId={task.id} />
                ))}
              </div>
            )
          )}

          {tab === 'ledger' && (
            !credits || !view || view.ledger.length === 0 ? (
              <EmptyState text={credits ? '还没有积分变动记录' : '本站未开启积分制'} />
            ) : (
              <div className="overflow-hidden rounded-3xl border border-[#eceaf6] bg-white shadow-sm">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-[#f1effa] text-left text-xs text-[#a5a1c4]">
                      <th className="px-5 py-3.5 font-medium">时间</th>
                      <th className="px-5 py-3.5 font-medium">类型</th>
                      <th className="px-5 py-3.5 font-medium">说明</th>
                      <th className="px-5 py-3.5 text-right font-medium">变动</th>
                      <th className="px-5 py-3.5 text-right font-medium">余额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...view.ledger].reverse().map((entry, idx) => (
                      <tr key={`${entry.at}-${idx}`} className="border-b border-[#f8f7fd] last:border-0">
                        <td className="whitespace-nowrap px-5 py-3 text-[#8a86ac]">
                          {new Date(entry.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </td>
                        <td className="px-5 py-3 font-medium">{LEDGER_LABELS[entry.type] ?? entry.type}</td>
                        <td className="max-w-[220px] truncate px-5 py-3 text-[#8a86ac]" title={entry.note}>{entry.note || '—'}</td>
                        <td className={`px-5 py-3 text-right font-semibold ${entry.amount >= 0 ? 'text-emerald-500' : 'text-[#f472b6]'}`}>
                          {entry.amount >= 0 ? `+${entry.amount}` : entry.amount}
                        </td>
                        <td className="px-5 py-3 text-right text-[#8a86ac]">{entry.balanceAfter}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}

          {tab === 'orders' && <EmptyState text="暂无订单记录，充值套餐上线后会显示在这里" />}

          {tab === 'settings' && (
            <div className="rounded-3xl border border-[#eceaf6] bg-white p-6 shadow-sm">
              <h3 className="text-[15px] font-bold">账号设置</h3>
              <dl className="mt-5 space-y-4 text-sm">
                <div className="flex items-center justify-between border-b border-[#f8f7fd] pb-4">
                  <dt className="text-[#8a86ac]">用户名</dt>
                  <dd className="font-medium">{user?.username ?? name}</dd>
                </div>
                <div className="flex items-center justify-between border-b border-[#f8f7fd] pb-4">
                  <dt className="text-[#8a86ac]">邮箱</dt>
                  <dd className="font-medium">{user?.email ?? '未绑定'}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-[#8a86ac]">密码</dt>
                  <dd>
                    <Link to="/forgot" className="font-medium text-[#6b5ce7] hover:text-[#5a4cd6]">
                      通过邮箱验证码重置 →
                    </Link>
                  </dd>
                </div>
              </dl>
              {user ? (
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="mt-7 flex items-center gap-2 rounded-full border border-red-200 px-5 py-2.5 text-sm font-medium text-red-500 transition hover:bg-red-50"
                >
                  <IconLogout className="h-4 w-4" />
                  退出登录
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => showToast('本地模式下数据全部保存在浏览器里', 'info')}
                  className="mt-7 flex items-center gap-2 rounded-full border border-[#dcd8f0] px-5 py-2.5 text-sm font-medium text-[#6f6a94]"
                >
                  <IconUser className="h-4 w-4" />
                  了解数据存储
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
