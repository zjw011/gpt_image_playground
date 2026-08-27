# 后台托管模式（自建服务端 + 渠道故障转移）

原版应用是纯浏览器应用：API 地址和密钥保存在用户自己的 localStorage 里，由浏览器直接请求第三方接口。这适合"自己用"，但不适合"把站点分享给别人用"——你得把密钥交出去。

后台托管模式在原有前端外面套了一层零依赖的 Node 服务：

- 你在 `/admin` 后台里添加 API 渠道（地址 + 密钥 + 模型）。
- 别人打开前端只能看到渠道名称和模型，看不到地址和密钥。
- 前端请求打到同源的 `/api/relay/<渠道id>/...`，由服务端补上真实地址与 `Authorization` 再转发。
- 一个渠道生图失败时，自动换下一个渠道重试，直到出图成功或所有渠道都失败。

它和现有的 nginx 静态部署（`deploy/Dockerfile`）互不影响，二者选一即可。

## 快速开始

### Docker Compose（推荐）

先在本机打包，只传必需的文件（`node_modules` 有 20000+ 个文件、近 400MB，绝对不要传，镜像里会重新 `npm ci`）：

```bash
# Windows PowerShell / Linux / macOS 都可用
tar --exclude=node_modules --exclude=dist --exclude=.git --exclude=docs \
    -czf gip.tar.gz .
```

打出来约 2MB。传到服务器后：

```bash
mkdir -p ~/gip && tar -xzf gip.tar.gz -C ~/gip && cd ~/gip
cp .env.example .env
vi .env                      # 至少填 GIP_ADMIN_PASSWORD
docker compose up -d --build
```

首次构建要在服务器上跑 `npm ci` + `npm run build`，大约 2-5 分钟，内存建议 ≥ 1GB（512MB 容易在 Vite 构建阶段 OOM）。

更省事的办法是用 git：服务器上 `git clone` 你的仓库，`node_modules` 和 `dist` 本来就在 `.gitignore` 里，不用操心打包。

看日志确认起来了：

```bash
docker compose logs -f
```

然后打开 `http://服务器IP:8080/admin` 登录后台添加渠道，前端在 `http://服务器IP:8080`。

常用运维命令：

```bash
docker compose restart        # 重启
docker compose down           # 停止（配置保留在卷里）
docker compose up -d --build  # 更新代码后重新构建
```

配置存在名为 `gip-server-data` 的 Docker 卷里，`down` 不会删除；只有 `down -v` 才会连配置一起删掉。

> 根目录的 `compose.yaml` 部署的是后台托管模式。原来的纯静态 nginx 部署仍然可用，但需要手动 `docker build -f deploy/Dockerfile`，两者不要混用。

### 本地直接跑

```bash
npm install
npm run build          # 生成 dist/
npm run server         # 启动服务，默认 http://127.0.0.1:8080
# 或者一步到位：npm start（先 build 再启动）
```

首次访问 `/admin` 时页面会让你设置管理员口令。

## 上公网前必须做的两件事

1. **挂 HTTPS 反代**。服务本身只讲 HTTP，直接暴露到公网意味着管理员口令、访客口令、生成的图片全程明文传输。最省事的是 Caddy：

   ```
   your-domain.com {
     reverse_proxy 127.0.0.1:8080
   }
   ```

   用 nginx 的话注意三点，否则会踩坑：`client_max_body_size 512m;`（默认 1MB，图生图直接 413）、`proxy_read_timeout 900s;`（默认 60s，慢渠道会被掐断）、`proxy_buffering off;`（否则流式输出全被缓冲）。

2. **决定要不要开访客门禁**。不填 `GIP_GUEST_PASSWORD` 就等于任何知道你地址的人都能用你的密钥生图，账单是你的。要么设访客口令，要么在反代层加 IP 白名单。

另外建议把 8080 端口只绑到本机（`compose.yaml` 里 ports 那行改成 `'127.0.0.1:8080:8080'`），只让反代能访问，避免有人绕过 HTTPS 直连。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `GIP_DATA_DIR` | `<项目根>/server-data` | 配置文件目录，`config.json` 以 `0600` 权限写入 |
| `GIP_DIST_DIR` | `<项目根>/dist` | 前端构建产物目录 |
| `GIP_ADMIN_PASSWORD` | 空 | 仅在尚未设置管理员口令时生效，用于免交互初始化（至少 8 字符） |
| `GIP_GUEST_PASSWORD` | 空 | 仅在尚未设置访客口令时生效，设置后自动开启门禁（至少 8 字符） |

## 后台功能

`/admin` 是一个无构建步骤的原生 JS 单页：

- **渠道管理**：新增 / 编辑 / 删除 / 上下移动排序，每个渠道可单独配置服务商类型、地址、密钥、模型、API 模式、超时、Codex CLI 兼容、流式开关、透明背景实现等。
- **连通测试**：对 OpenAI 兼容渠道发一次 `GET models` 请求（20 秒超时），确认地址与密钥可用；fal 渠道没有轻量探测端点，只确认密钥已配置。
- **故障转移顺序**：就是渠道列表的顺序，用「上移／下移」调整。
- **站点设置**：站点标题、访客门禁开关、故障转移开关与最大尝试渠道数、是否允许访客调整生成参数。
- **口令管理**：修改管理员口令（需要当前口令，修改后其他设备的登录失效）、设置或清除访客口令。
- **自定义服务商**：粘贴 `http-image` 模板 JSON 数组，用于对接非 OpenAI 格式的第三方接口，格式与前端「自定义服务商」完全一致（可用 `docs/custom-provider-llm-prompt.md` 让大模型生成）。

编辑渠道时 API Key 留空表示"不修改"，后台不会把已保存的密钥回传给浏览器，只回传形如 `sk-a************wxyz` 的掩码。

## 前端行为差异

服务端存在时，前端在启动阶段请求 `/api/bootstrap`，拿到渠道列表后进入托管模式：

- 渠道被映射成 API 配置，`baseUrl` 指向 `/api/relay/<渠道id>/`，`apiKey` 是占位值 `backend-managed`。
- 设置页不再显示 API URL、API 代理和 API Key 输入框，改为一段说明；配置列表不可新增、复制、删除、拖动。
- 开启访客门禁时，先显示口令页，验证通过后写入 30 天有效期的 HttpOnly Cookie。
- 关闭门禁时任何人都能直接使用你配置的渠道，请自行斟酌是否暴露到公网。

纯静态部署（没有这个服务端）时 `/api/bootstrap` 请求失败，前端会原样退回到自带配置模式，行为与升级前一致。

## 故障转移

作用范围是画廊模式（文生图 / 图生图 / 遮罩重绘），Agent 模式暂不改动。

- 候选顺序：当前渠道排第一，其余按后台渠道列表顺序补齐，只包含配置完整的渠道。
- 换渠道时前端会弹一条提示，说明上一个渠道失败、正在尝试哪一个。
- 重试期间会关闭流式输出——中间步骤图一旦推给前端就无法干净地换渠道重试。
- 本地校验类失败（图片过大、图片已不存在、遮罩尺寸不匹配等）换渠道也一样会失败，直接报错不重试。
- fal 与自定义异步任务的"连接断开但任务仍在跑"属于可恢复状态，走原有的轮询恢复逻辑，不触发故障转移。
- 所有候选都失败时，错误信息里会逐条列出每个渠道的首行报错；任务详情页的"渠道重试"区块会展示完整尝试记录。

## 安全说明

- 密钥只存在服务端配置文件里，`/api/bootstrap` 的渠道投影不含 `baseUrl` 和 `apiKey`。
- 中继会剥离客户端的 `Authorization`、`Cookie`、`Origin`、`Referer`、`X-Forwarded-*` 后再转发，避免访客伪造凭据或让上游看到内网信息。
- fal 中继按 `fal.run` / `fal.ai` 主机白名单校验目标地址；管理员填了自定义 fal 网关时，目标 origin 会被改写到该网关，防止被当作任意 URL 代理。
- 所有会改状态的管理接口和 `/api/session` 都要求同源。
- 登录按 IP 限流：10 分钟内失败 10 次锁定 10 分钟。
- 口令用 scrypt 加盐哈希存储，校验用 `timingSafeEqual`。
- 服务本身不提供 HTTPS。放到公网时请在前面挂一层 TLS 反代（Caddy / nginx / Cloudflare），否则口令与图片都是明文传输。
