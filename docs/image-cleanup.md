# 下载副本的可见 AI 水印处理

## 范围与部署

- 生成结果页可勾选「移除可见 AI 水印」，默认关闭。已有生成图片右键菜单也提供该选项，支持逐张及批量 ZIP 下载；不是第三方付费图片或任意版权水印擦除工具。
- 只修改下载副本；不写回 IndexedDB、作品广场、服务端作品或积分账本。未识别到水印返回原始字节，无法确认清理成功同样保留原图。结果页服务出错可取消勾选直接下载，批量下载出错保留原图并报告数量。
- 普通视频 / Live 导出不提供去水印选项。纯静态部署显示不可用，原来的下载仍能使用。计算接口要求启用账号的登录会话，即使站点访问模式为 open 也不开放匿名计算。
- `compose.yaml` 自带独立 CPU Python 工作容器，不需要显卡，不把 Python / OpenCV 塞进 Node Alpine 镜像。处理容器没有公开端口或数据卷，以非 root 运行，根文件系统只读，临时图片处理结束即删除；每次独立子进程，45 秒超时终止，不下载大型扩散模型。
- 非 Compose 托管可自行运行工作容器，在 Node 环境配置 `GIP_WATERMARK_URL`。未配置不会影响正常生图或下载；不要把工作服务端口暴露公网。
- 请求限 PNG / JPEG / WebP 静态图、16MB、800 万像素；CPU 工作者单并发，Node 全局最多 2 个在途、每账号单并发及每分钟 12 次。超限、繁忙、超时应下载原图，不自动尝试重新生图。

## 上游与许可

- 上游：[wiltodelta/remove-ai-watermarks](https://github.com/wiltodelta/remove-ai-watermarks)，固定 `remove-ai-watermarks[visible]==0.44.0`；代码许可为 [Apache-2.0](https://github.com/wiltodelta/remove-ai-watermarks/blob/main/LICENSE)。安装分发包自带上游许可，镜像保留其安装目录内的声明。没有复制上游代码或安装其 Agent Skill。
- 调用 `remove_visible_detailed` 数组 API，显式 `backend='cv2'`、`sensitivity='strict'`、`strip_metadata=False`。不调用 `remove_all`、隐形水印扩散流程或元数据清理函数。模板支持与限制由上游版本决定，不保证识别所有渠道标记，也不保证无修补痕迹。
- CPU OpenCV 会对识别区域修补，可能影响水印下的纹理，需人工检查。只交付 `cleaned` 修补结果；`partial` / `unvalidated` / `no_watermark` 均保留原图并明确提示。
- 修改后的副本使用 PNG，保留 alpha、EXIF、ICC、DPI、PNG 文本与已知 XMP 字段，不主动清除生成来源说明。发现 C2PA / JUMBF 签名来源凭证时拒绝处理，避免破坏签名；格式转换不能声称完整保留所有未知元数据。来源图片始终保留。用户应仅处理有权移除且允许移除的可见标记。

## 验证

- JavaScript 回归：`npm test`，包括格式 / 大小校验、账号权限、状态返回、并发占位回收、原图回退和 ZIP 副本处理。
- Python 回归：安装工作服务依赖后运行 `python deploy/watermark/test_worker.py`。使用本地合成样本覆盖已知星形水印修复、非水印区域 / alpha / 文本元数据保留、无水印字节完全一致及签名凭证 / 非图片拒绝。
- 专项真实浏览器审计：`npm run build` 后运行 `npm run audit:image-cleanup`，自带隔离后端与 Python 工作者。需要 Python 工作依赖与本机 Chrome；可用 `AUDIT_PYTHON` 指定 Python 可执行文件。覆盖真实算法、账号 / 同源权限、默认关闭、手机布局、原图与副本下载及原文件不变。
- 原图保留和处理成功判定必须与后续版本保持一致，不能把「已执行修补」直接等同「已去水印」。
