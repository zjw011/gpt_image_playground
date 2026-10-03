# Live 实况导出研究

核查日期：2026-10-03。只读研究上游源码，未安装外部 Skill、执行上游脚本或复制上游实现。

## 两个仓库的用途并不相同

| 来源 | 实际相关实现 | 对绘想的意义 |
| --- | --- | --- |
| [guizang-social-card-skill](https://github.com/op7418/guizang-social-card-skill) | 图文排版工作流。Live 相关脚本用 ImageIO 给静态图写 MakerApple 字典中的 `17` 标识，用 AVFoundation 给 MOV 写相同的 `content.identifier` 和定时 `still-image-time` 元数据轨；另调用 makelive 打包 `.pvt` | 苹果配对文件的参考，但这部分依赖苹果框架，不能直接装进当前 Linux / Alpine Node 容器；不是从图片生成动作的模型 |
| [live-photo-conv](https://github.com/wszqkzqk/live-photo-conv) | Vala / GExiv2 实现照片与视频合并，FFmpeg 或 GStreamer 处理视频。LiveMaker 将视频追加到 JPEG，写入 Google MicroVideo / MotionPhoto XMP 和 Container.Directory 视频长度 | 单文件 Motion Photo 路线，不能把生成的 JPEG 直接宣传为苹果原生 Live Photo；不同手机、相册和分享平台仍需实测 |

核查源码：[照片标识](https://github.com/op7418/guizang-social-card-skill/blob/main/scripts/add-livephoto-maker-note.swift)、[视频配对轨](https://github.com/op7418/guizang-social-card-skill/blob/main/scripts/add-livephoto-mov-metadata.swift)、[PVT 打包](https://github.com/op7418/guizang-social-card-skill/blob/main/scripts/package-live-photo.py)、[Motion Photo 元数据与封装](https://github.com/wszqkzqk/live-photo-conv/blob/main/src/livemaker.vala)、[FFmpeg 后端](https://github.com/wszqkzqk/live-photo-conv/blob/main/src/livemakerffmpeg.vala)。

第一个仓库标注 AGPL-3.0，并单列[商业授权说明](https://github.com/op7418/guizang-social-card-skill/blob/main/COMMERCIAL_LICENSING.md)；第二个仓库源文件标注 LGPL-2.1-or-later。后续引入代码、依赖或打包分发前需单独审查相应许可义务，本次不引入两者代码或依赖。

## 苹果原生导出需要验证的闭环

1. 先从原图生成稳定、可解码的短视频。轻微缩放 / 横移无需 AI；真实眨眼等动作仍依赖模型质量，增加混合播放帧数不能修复人物或背景漂移。
2. 生成配对静态图与 MOV，写入匹配的资产标识和静态帧时间元数据轨。改文件后缀或只写一条全局标签均不等于完成配对。
3. 在苹果环境加载并验证两份资源，再通过相册的照片与 pairedVideo 资源导入流程写入相册。网页直接下载普通视频没有这个相册配对流程。
4. 在实际 iPhone 验证导入、长按播放、封面、首尾衔接和导出/分享后的配对保留。`.pvt` 是研究仓库采用的传输包，不承诺浏览器下载后系统一定能直接识别。

苹果文档：[PHLivePhoto](https://developer.apple.com/documentation/photos/phlivephoto)、[从资源加载并校验](https://developer.apple.com/documentation/photos/phlivephoto/request(withresourcefileurls:placeholderimage:targetsize:contentmode:resulthandler:))、[PHAssetCreationRequest](https://developer.apple.com/documentation/photos/phassetcreationrequest)。

当前 Windows 开发机和 Linux 部署不具备这两个 Swift 脚本要求的苹果框架。其打包依赖 [makelive](https://github.com/RhetTbull/makelive) 同样明确要求 macOS，并通过 Core Graphics / AVFoundation 写入元数据，不是能直接替换成 Linux Python 脚本的方案。本次没有新增 Mac 转换服务、iOS 应用或未经验证的原生下载按钮；需要确定可用的苹果转换/导入环境并完成真机验证后再接入。这是已研究方案的环境限制，不意味着所有 Linux 原生封装路线都不可行。

## 本次系统改进与验收边界

- 快速运镜和 AI 微动作共用本地编码生命周期，优先尝试 MP4 / AVC；编码器不可用或初始化失败时回退真实 WebM。扩展名与实际 MIME 匹配，不假冒 MOV / Live Photo。
- AI 导出不再靠逐帧累积等待决定时间轴，按真实经过时间绘制往返混合，目标捕获帧率 30fps，首尾画面相同，底帧始终不透明；关键帧数不是最终视频帧数。
- 两种导出都支持导航取消、后台页中止、图片读取与编码超时、空输出检查、异常释放录制器和轨道；不重新调用 AI、不产生额外积分消费。
- AI 微动作预览在手机上沿用原图比例，避免固定高容器制造大黑边；完整解码后才启用播放，后台暂停进度，回前台不跳过后台时长，并遵循减少动态偏好。暂停、继续不再重复解码整组帧。
- 结果页明确「下载视频」和原生格式边界，给出另行转换导入的说明。MP4 能否在某个手机解码与能否作为原生实况入库是两个验收项。
- 本地单元测试和 Chrome 编码/解码验证不能代替 iPhone Safari、苹果相册或得物等发布平台的真机验收；不宣传已完成苹果原生导出。
