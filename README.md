# 得物整点抢兑助手 · Web 版

多用户 Web 版：每个用户用自己的**得物手机号 + 密码**登录，看到的是**完全独立的界面和数据**；
创建定时兑换任务需要**兑换码（一码一任务）**，方便你把使用权限控在自己手里。

> 这是 `web` 分支。`main` 分支是同项目的 Windows 桌面版（单机 exe）。

---

## 一、快速开始

### 本地试跑（不用 Docker）

Windows：双击 **`run_local.bat`**
macOS / Linux：`bash run_local.sh`

或者手动：

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt      # Windows: .venv\Scripts\pip install -r requirements.txt
python run_web.py
```

浏览器打开 <http://127.0.0.1:8000> 即可。
本地默认用 **SQLite**（数据在 `webdata/dewu.db`），不需要额外装数据库。

### 服务器部署（Docker，含 PostgreSQL）

```bash
git pull
bash deploy.sh
```

脚本会自动：生成 `.env`（数据库密码随机）→ 构建镜像 → 起 PostgreSQL + 应用 → 打印访问地址和管理员密码。

不想用脚本就三步：

```bash
cp .env.example .env      # 改一下 DB_PASSWORD
docker compose up -d --build
docker compose logs -f app
```

---

## 二、两个入口

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| 用户端 | `http://服务器:8000` | 得物手机号 + 密码登录 |
| 管理后台 | `http://服务器:8000/admin` | 兑换码 / 用户 / 全局设置 |

**管理员密码**：没设 `ADMIN_PASSWORD` 环境变量时，首次启动会随机生成，
打印在启动日志里，同时写到 `webdata/ADMIN_PASSWORD.txt`。请及时改掉。

---

## 三、用户端能做什么

- **登录**：得物手机号 + 密码。登录方式被风控时，可以改用「粘贴自己的抓包 curl」。
- **商品墙**：每个商品都显示 **图片 / 价格 / 库存 / 所需金币**，售罄的会置灰。
  这些字段接口本来就返回（`productPicture` / `platformPrice` / `stock` / `scoreCostOrigin`），
  Web 版把它们都解析出来了。
- **定时兑换任务**：点任意商品 → 填目标时间（默认 10:00:00）、提前起抢毫秒数、
  重试间隔、最大次数 → 填**兑换码** → 创建。
- **每天重复 / 自动降级兜底**：原商品下架或一直抢不到时，自动换一个「有货且买得起」的替代品
  （规则固定：买得起的里面挑最贵的；同价取列表第一个；排除原商品）。
- **库存监听**：定时拉列表，发现**新品上架 / 补货**就在网页里提示，可同时推微信。
- **微信推送（PushPlus）**：抢兑结果、库存变化推到微信。支持**群发到群组**，
  但**只群发库存变化** —— 抢兑成功/失败永远只私发（卡片里有账号信息，不该发群里）。
- **每日答题**：自动取今日题目、提交答案赚金币。
- **链路诊断**：挑一个「余额买不起」的商品去兑换，服务端会回「余额不足」——
  既证明 token/参数/接口全通，又不会真的扣金币。

---

## 四、兑换码：一码一任务

1. 管理员进 `/admin` → 「兑换码」→ 填数量（1-500）、每个码可创建任务数、前缀、备注 → 生成。
2. 把码发给用户（「导出未使用的码」可以一键下载 txt，方便发群）。
3. 用户创建任务时必须填码：**码不存在 / 已用过 / 被作废 / 被别人绑过**都会被拒绝。
4. 用过就废，**删除任务也不会返还**（这是刻意的，用来限制使用量）。
5. 后台能看到每个码的配额、状态、绑定的用户和任务。

---

## 五、数据是怎么隔离的

- **服务端会话**：cookie 里只放一个随机串，真正的身份在数据库里。改 cookie 也猜不出别人的。
- **每个用户一棵数据树**：账号、token、设置、任务、库存快照全部按 `user_id` 归属，
  互相之间没有任何共享状态（连运行时的线程都是每人一份）。
- 抢兑任务跑在**每用户独立的线程**里，日志也有各自独立的缓冲区。

---

## 六、环境变量

见 `.env.example`，常用几个：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 对外端口，默认 8000 |
| `DATABASE_URL` | 不填 → SQLite（`webdata/dewu.db`）；Docker 里由 compose 注入 PostgreSQL |
| `ADMIN_USER` / `ADMIN_PASSWORD` | 管理员账号，密码留空则首次随机生成 |
| `DEWU_ACTIVITY` | 得物活动 id，默认 `20260917`。**活动换批次后必须改** |
| `ALLOW_NEW_USER` | 是否允许新的得物账号首次登录（0 = 只允许已存在的） |
| `MAX_USERS` | 用户数上限，0 = 不限 |
| `REQUIRE_CODE_FOR_TASK` | 创建任务是否必须填兑换码 |

活动 id 和 sign 也可以在管理后台的「全局设置」里改，不用重启。

---

## 七、文件结构

```
webapp/
  config.py        环境变量配置
  db.py            引擎 / 建表 / 全局设置读写
  models.py        ORM：users / sessions / admins / redeem_codes / tasks / logs / settings
  security.py      pbkdf2 口令哈希、随机 token
  auth.py          会话建立与 FastAPI 依赖（current_user / current_admin）
  dewu_client.py   ★ 得物接口层：登录、商品列表、兑换、降级、答题
  curlparse.py     从桌面版搬过来的 curl 解析（不 import dewu_sniper，避免副作用）
  runtime.py       ★ 每用户运行时：商品缓存 / 定时任务线程 / 库存监听 / 日志 / 推送
  api_user.py      用户端 API
  api_admin.py     管理端 API
  main.py          FastAPI 装配（含单 worker 提醒）
  static/          index.html / app.js / style.css —— 零构建前端
run_web.py         本地启动入口
deploy.sh          服务器一键部署
docker-compose.yml app + PostgreSQL
tools/test_web_api.py   端到端接口测试（55 项）
tools/shot_web.py       无头浏览器截图
```

### 复用了桌面版的什么

`dewu_login.py`（手机号 AES-128-ECB、`md5(密码+"du")`、设备指纹头）和
`dewu_push.py`（PushPlus 卡片样式）是**直接 import** 复用的。

`dewu_sniper.py` **故意不 import**：它一被 import 就会实例化桌面版的 `Manager` 单例、
恢复未完成任务线程、甚至在开着监听时自动拉起监听线程 —— Web 进程不能有这种副作用。
需要的那点逻辑（curl 解析、商品解析、降级挑选）已经按 Web 的形态重写/搬到 `webapp/` 里了。

---

## 八、必须知道的几件事

1. **只能单 worker 跑。** 定时抢兑是进程内线程，多 worker 会各跑一份任务重复抢。
   `run_web.py` 和 Dockerfile 都已经固定成 1 个 worker，**不要自己加 `--workers`**。
2. **登录用的是共享设备指纹。** 密码登录必须带一组数美风控头（`shumeiid`/`SK`/`adi`…），
   这些值是从一台具体设备抓下来的常量，所有用户共用。用户量大了有可能被得物关联风控 ——
   所以保留了「粘贴自己的抓包 curl」作为兜底登录方式。
   实测结论：拉列表的 `exchange_list` 接口其实只校验 `x-auth-token`，请求头不是瓶颈。
3. **活动 id 会换。** 用户刷新列表报「活动不存在」时，去管理后台「全局设置」改活动 id。
4. **token 有效期约 365 天**，过期后用户重新登录即可。
5. 项目只做技术研究与个人学习用途，请遵守得物平台的使用规则，不要拿去做违规的事。

---

## 九、自测

```bash
python run_web.py                      # 另开一个窗口
python tools/test_web_api.py           # 55 项端到端接口测试
python tools/shot_web.py               # 无头浏览器截图到 dist/
```
