#!/usr/bin/env bash
# 服务器上一键部署（git pull 之后跑这个）
#   bash deploy.sh
# 会自动：生成 .env → 构建镜像 → 起 PostgreSQL + 应用 → 打印访问地址和管理员密码
set -euo pipefail
cd "$(dirname "$0")"

say() { printf "\n\033[1;36m%s\033[0m\n" "$1"; }

# ---------- 前置检查 ----------
if ! command -v docker >/dev/null 2>&1; then
  echo "✗ 没找到 docker，请先装： https://docs.docker.com/engine/install/"
  exit 1
fi
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "✗ 没找到 docker compose，请装 docker compose 插件"
  exit 1
fi

# ---------- .env ----------
if [ ! -f .env ]; then
  cp .env.example .env
  # 注意：head 提前关闭管道会让上游 tr 收到 SIGPIPE，set -o pipefail 下会中止脚本 → 兜一下
  PW=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c 20 || true)
  PW=${PW:-changeme$(date +%s)}
  # 兼容 GNU sed / BSD sed
  if sed --version >/dev/null 2>&1; then
    sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=${PW}|" .env
  else
    sed -i '' "s|^DB_PASSWORD=.*|DB_PASSWORD=${PW}|" .env
  fi
  say "已生成 .env（数据库密码已随机）"
fi

PORT=$(grep -E '^PORT=' .env | head -1 | cut -d= -f2)
PORT=${PORT:-8000}

say "开始构建并启动（第一次会拉镜像、装依赖，耐心等 1~3 分钟）…"
$DC up -d --build

say "等待服务就绪…"
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "  ✓ 服务已就绪"
    break
  fi
  sleep 3
  [ "$i" = "40" ] && echo "  ! 迟迟没起来，下面看看日志"
done

say "最近日志："
$DC logs --tail=60 app 2>&1 | sed -n '1,60p' || true

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
IP=${IP:-服务器IP}
PKG=$(grep -E '^ADMIN_USER=' .env | head -1 | cut -d= -f2); PKG=${PKG:-admin}
APW=$(grep -E '^ADMIN_PASSWORD=' .env | head -1 | cut -d= -f2)
[ -z "$APW" ] && APW=$(cat webdata/ADMIN_PASSWORD.txt 2>/dev/null || echo "见日志")

cat <<EOF

============================================================
  ✅ 部署完成

  用户端    http://${IP}:${PORT}
  管理后台  http://${IP}:${PORT}/admin
  管理员    ${PKG} / ${APW}

  常用命令：
    看日志    $DC logs -f app
    重启      $DC restart app
    更新代码  git pull && $DC up -d --build
    停止      $DC down
    连数据库  $DC exec db psql -U dewu -d dewu
============================================================
EOF
