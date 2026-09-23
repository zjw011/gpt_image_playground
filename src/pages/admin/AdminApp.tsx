// 后台视图分发。路由是单层的 /admin，分区由 ?tab= 决定。
//
// 不用 /admin/channels 这类子路径是因为产物按 base:'./' 构建（要能塞进任意子路径部署）：
// 两层路径会让浏览器把 ./assets/xxx.js 解析成 /admin/assets/xxx.js，整页白屏。
// 每个视图自己渲染 AdminShell，切页签等于换内容、壳保持不变。
import { useSearchParams } from 'react-router-dom'
import DashboardPage from './DashboardPage'
import ChannelsPage from './ChannelsPage'
import UsagePage from './UsagePage'
import UsersPage from './UsersPage'
import CreditsPage from './CreditsPage'
import WechatPage from './WechatPage'
import SmtpPage from './SmtpPage'
import SitePage from './SitePage'
import { ADMIN_TABS } from './AdminShell'

const VIEWS: Record<string, React.ComponentType> = {
  dashboard: DashboardPage,
  channels: ChannelsPage,
  usage: UsagePage,
  users: UsersPage,
  credits: CreditsPage,
  wechat: WechatPage,
  smtp: SmtpPage,
  site: SitePage,
}

export default function AdminApp() {
  const [searchParams] = useSearchParams()
  const tab = searchParams.get('tab') ?? 'dashboard'
  // 认不出来的 tab 回仪表盘，不要给一个空白页。
  const known = ADMIN_TABS.some((item) => item.key === tab)
  const View = VIEWS[known ? tab : 'dashboard'] ?? DashboardPage
  return <View />
}
