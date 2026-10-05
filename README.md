# 得物整点抢兑助手 · Web 版

本分支提供多用户 Web 服务；EXE 代码保持原样。界面采用浅色布局，桌面侧栏、手机底部导航。

## 执行流程

1. 用户输入手机号和密码：仅加密保存凭据、建立本站会话，不调用得物登录。
2. 管理员的公共账号统一提供商品列表，客户浏览和刷新商品不登录自己的得物账号。
3. 用户选择商品、填写授权码并创建任务，默认北京时间 10:00:00。
4. 09:58 提取一个 3 分钟代理，用它登录并提前校正商品；同账号同期任务共享登录与代理。
5. 10:00 使用已准备的 token 和同一代理兑换。本轮最多 50 秒，且必须在代理过期前 8 秒停止发送新请求；降级兑换共用截止时间和尝试次数。
6. 成功后用用户自己的 PushPlus token 私发通知。网页可以关闭，服务器继续执行。

代理或登录失败会停止本轮，不会偷偷改用直连、旧 token 或自动购买第二个 IP。不同账号不会分配同一个仍有效的出口 IP；如果平台返回重复 IP，本轮明确失败。

支持每天重复、自动降级（用户可关闭）、授权码后台生成、账号禁用和推送测试。建议只保留必要任务，降低代理费用和同账号并发请求。

## 服务器运行

服务器需已安装 Docker 和 Docker Compose：

```bash
git clone --branch web https://github.com/zjw011/gpt_image_playground.git dewu-web
cd dewu-web
bash deploy.sh
```

脚本首次生成 `.env` 和随机数据库密码，启动 PostgreSQL 与 Web 服务。用户入口 `http://服务器IP:8000`，后台 `http://服务器IP:8000/admin`。管理员首次随机密码保存在 `webdata/ADMIN_PASSWORD.txt`；立即在后台修改。

更新和检查：

```bash
git pull --ff-only origin web
docker compose up -d --build
docker compose logs --tail=100 app
curl -f http://127.0.0.1:8000/healthz
```

停服务用 `docker compose stop`；不要用 `docker compose down -v`，它会删除数据库卷。

正式对外服务请配置 HTTPS 反向代理，把 `.env` 中 `COOKIE_SECURE=1` 后重建服务。代理应保留 `Host`，并正确传递客户 IP；`.env` 中 `FORWARDED_ALLOW_IPS` 应填写可信代理的实际 IP 或 CIDR，避免登录限流把所有用户当成同一人。只运行 **一个 worker、一个应用实例**，调度器是进程内线程，不能横向多开。容器使用 `Asia/Shanghai`；服务器启用 NTP 时钟同步，实际发请求时间仍受线程调度和网络延迟影响，不能保证兑换成功。

## 第一次配置（按顺序）

1. 后台 → 全局设置 → 公共账号：填写管理员自己的得物账号，测试并启用。该账号负责商品列表；未配置时，密码用户不会登录得物来补拉列表。
2. 后台 → 天启IP：填 `secret`（提取密钥）、`sign`（用户签名）、`key`（天启账号）。选择套餐实际支持的协议，默认 SOCKS5，启用；定时任务固定提取 3 分钟。
3. 白名单模式：点击“本机 IP 加白名单”。程序运行时也会检查并添加，成功结果缓存 5 分钟；白名单填的是服务器公网出口 IP，不是提取出来的代理 IP。账号密码认证模式填代理用户名和密码，无需 `key` 或自动白名单。
4. “测试提取”会实际消耗一次额度，不需要反复点；没有配置真实代理与公共账号时，无法完整验证线上链路。
5. 后台 → 兑换码：生成授权码，一码默认一任务，删除任务不会退码。已关联任务和核销记录可查询。
6. 用户 → 设置 → 微信推送：填自己的 PushPlus token，打开开关、保存、发送测试。兑换结果永远私发。

天启不是程序“生成”IP，而是调用提取接口租用平台提供的 IP。程序发送 GET：

```text
http://api.tianqiip.com/getip?secret=你的提取密钥&sign=你的签名&num=1&type=json&port=3&time=3&ts=1&mr=1
```

`port=3` 表示 SOCKS5 协议，并非实际端口；真实端口来自返回的 `data[0].port`。`code=1000` 才表示提取成功。程序将返回的 IP 和端口组合成 `socks5h://IP:端口`，登录、商品校正和兑换都使用它。`time=3` 要求套餐支持 3 分钟按次提取，费用由套餐决定。天启接口按你提供的说明使用 HTTP，密钥只填写在后台，不应公开提取链接。

## 本地运行

```bash
python -m venv .venv
# Linux / macOS
.venv/bin/pip install -r requirements.txt
.venv/bin/python run_web.py
```

Windows 用 `.venv\Scripts\pip install -r requirements.txt` 和 `.venv\Scripts\python run_web.py`，也可以双击 `run_local.bat`。

## 账号和数据

得物密码使用 Fernet 加密存储，密钥由 `SECRET_KEY` 或 `webdata/secret.key` 提供。备份数据库和该密钥；丢失密钥无法解密密码。

本站不实时验证得物账号，所以首次保存只代表登记成功，账号是否有效在执行任务前得物登录时确认。已有密码账号进入本站必须匹配已保存密码，不能用任意密码覆盖。得物密码改动后由管理员在用户页“重置凭据”，先停止该账号任务；重置会使原本站会话失效。首次登记不证明手机号所有权，面向已知客户可在登记完成后设置 `ALLOW_NEW_USER=0`。

抓包 token 是独立的高级登录方式，默认通过 token 的稳定摘要生成本站账号标识；不会自动提取天启代理或保存密码。不要将不受信任的 token 绑定到别人的手机号。

授权码核销采用数据库事务、PostgreSQL 行锁和条件更新，避免并发重复使用。本站会话按用户隔离；写请求检查 Origin；登录有频率限制。HTTPS 部署时启用 Secure cookie。数据、账号文件、日志、`.env`、构建产物均不上传 Git。

重复任务会恢复等待/执行中任务，也会在重启后恢复已完成的每日重复任务。服务器中断可能导致请求结果不确定，恢复时按下一次目标时间调度；请在得物 App 核对订单，避免立即重复执行。进程内日志不持久化，暂不提供可靠消息队列或推送失败自动重发。

## 验证

离线测试不会调用得物或付费代理：

```bash
python tools/test_web_core.py
python tools/test_tianqi.py
pip install -r requirements-dev.txt
python tools/test_web_regressions.py
```

新增测试使用临时数据库，覆盖延迟登录、密码校验、并发代理共享、重复出口拒绝、代理故障停止、白名单失败不提取、兑换截止时间、整点不刷新商品、个人推送 token、授权码核销、零提前量、跨站提交和限流。真实端到端测试 `tools/test_web_api.py` 需要真实账号和独立数据目录，会访问平台，请按需执行。

更详细的本次分析见 [WEB_REVIEW.md](WEB_REVIEW.md)。
