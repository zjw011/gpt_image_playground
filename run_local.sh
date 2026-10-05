#!/usr/bin/env bash
# macOS / Linux 本地启动（不用 Docker）
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "[1/3] 创建虚拟环境 .venv ..."
  python3 -m venv .venv
fi
echo "[2/3] 安装依赖 ..."
./.venv/bin/python -m pip install -q --upgrade pip
./.venv/bin/python -m pip install -q -r requirements.txt
echo "[3/3] 启动 ..."
exec ./.venv/bin/python run_web.py
