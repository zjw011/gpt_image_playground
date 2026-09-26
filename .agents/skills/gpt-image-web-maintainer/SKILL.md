---
name: gpt-image-web-maintainer
description: Maintain, review, debug, optimize, test, or deploy the gpt-image-web repository while preserving its data-safety and deployment invariants.
---

# 绘想项目维护

处理本仓库的实现、修复、优化、审查或部署任务时：

1. 先读取根目录 `AGENTS.md`，并查看 `docs/maintenance-log.md` 最近三条记录，避免重犯已经记录的问题。
2. 涉及持久化数据时优先保证可恢复性：元数据解析失败必须停止破坏性清理，积分、账号、渠道和作品数据不得静默回落为空库后覆盖原文件。
3. 保持纯静态模式和 Node 托管模式都可用；路由保持单层路径，分区使用查询参数。
4. 修改后至少运行 `npm run build` 和 `npm test`。涉及路由、页面、后台管控时，再运行对应的 `audit:menu`、`audit:render` 或 `audit:server`。
5. 每次产生实质代码或配置变更，都在 `docs/maintenance-log.md` 顶部追加一条记录，写清日期、变化、验证结果和可复用经验。纯问答或只读检查不记日志。
6. 最终回复简要列出完成内容、验证结果和维护记录位置。回复最后固定给出以下服务器更新命令，且不要再在它后面添加内容：

```bash
cd /www/wwwroot/gpt_image_playground
git fetch origin && git merge origin/feat/huixiang-rebuild && docker compose up -d --build
```
