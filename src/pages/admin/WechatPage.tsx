// 微信登录：目前只放一个入口占位。
// 公众号 / 小程序都还没申请，扫码登录没有可对接的凭证，所以这一版不做配置表单，
// 只明确告诉管理员"这个功能在计划里、还没开"。等公众号下来后再把配置表单接回来。
import AdminShell from './AdminShell'
import { IconWechat, IconBolt } from '../icons'

export default function WechatPage() {
  return (
    <AdminShell>
      <div className="rounded-2xl border border-[#e6ebf2] bg-white p-8 shadow-sm">
        <div className="flex flex-col items-center text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#f0fdf4] text-[#22c55e]">
            <IconWechat className="h-8 w-8" />
          </span>
          <h3 className="mt-5 flex items-center gap-2 text-lg font-bold text-[#1e293b]">
            微信登录
            <span className="rounded-full bg-[#fff7ed] px-2.5 py-1 text-xs font-medium text-[#ea580c]">开发中</span>
          </h3>
          <p className="mt-3 max-w-md text-sm leading-6 text-[#64748b]">
            这个入口先占位放在这里。等公众号或小程序申请下来、拿到 AppID 与 AppSecret 之后，
            再回来开启扫码登录，届时本站会多一种登录方式。
          </p>

          <div className="mt-6 w-full max-w-lg rounded-xl bg-[#f8fafc] px-5 py-4 text-left">
            <p className="flex items-center gap-2 text-sm font-medium text-[#475569]">
              <IconBolt className="h-4 w-4 text-[#3b82f6]" />
              当前可用的登录方式
            </p>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-[#64748b]">
              <li className="flex gap-2">
                <span className="text-[#94a3b8]">·</span>
                账号注册：邮箱收验证码 → 设置用户名与密码，注册完直接登录。
              </li>
              <li className="flex gap-2">
                <span className="text-[#94a3b8]">·</span>
                账号登录：用户名 + 密码，前台顶部「登录」进入。
              </li>
              <li className="flex gap-2">
                <span className="text-[#94a3b8]">·</span>
                忘记密码：凭邮箱验证码重设。
              </li>
            </ul>
          </div>

          <p className="mt-5 text-xs text-[#94a3b8]">
            邮件发信在「邮件发信」里配置；没配好之前注册取不到验证码。
          </p>
        </div>
      </div>
    </AdminShell>
  )
}
