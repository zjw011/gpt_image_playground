// react-router 的 basename 必须是绝对路径。
// vite.config 里 base 是 './'（构建产物要能塞进任意子路径，资源走相对路径），
// 但 './' 直接丢给 createBrowserRouter 会让整张路由表一条都匹配不上——
// 页面全白、点任何按钮都没反应。这里统一把非绝对 base 收敛成 '/'。
export function resolveRouterBasename(base: string) {
  return base.startsWith('/') ? base : '/'
}
