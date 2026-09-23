// 「验证码已发送」提示卡。
// 用户最常踩的坑不是没发出去，而是邮件被 QQ/163 扔进了垃圾箱或订阅邮件，
// 所以发成功后就把这几个去处明说，配上有效期和重发节奏，省得用户干等。
export default function EmailSentNotice({ email }: { email: string }) {
  return (
    <div className="mt-5 rounded-xl bg-emerald-50 px-4 py-3.5 text-left text-[12.5px] leading-5 text-emerald-700">
      <p className="font-medium">验证码已发送至 {email}，10 分钟内有效</p>
      <ul className="mt-1.5 space-y-0.5 text-emerald-600/90">
        <li>· 几分钟没收到？翻一下「垃圾邮件」和「订阅邮件」文件夹，邮件服务商经常把验证码归进去</li>
        <li>· 确认没有的话，等 60 秒冷却后点「重新发送」即可，不用反复刷新页面</li>
      </ul>
    </div>
  )
}
