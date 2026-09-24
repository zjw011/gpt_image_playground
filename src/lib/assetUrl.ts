// 内置素材（public/art/*）的 URL 构造。
//
// 这些图片文件名是固定的，但内容会随版本更新。CDN（如腾讯云 EdgeOne）会按
// 后缀给它们设一个自己的 TTL，部署窗口里回源拿到的 404/502 也会被缓存住，
// 表现为"有的电脑能看图、有的看不到"。给 URL 挂上构建期版本号之后，
// 每次部署 URL 都变，CDN 与浏览器都必须重新取——这类问题从根上消失。
export function assetUrl(path: string) {
  return `${path}?v=${__ASSET_VERSION__}`
}
