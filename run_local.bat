@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   得物整点抢兑助手 · Web 版   本地启动
echo   （不用 Docker，直接用 Python 跑）
echo ============================================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [x] 没找到 python，请先装 Python 3.10+ 并勾选 "Add to PATH"
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [1/3] 首次运行，正在创建虚拟环境 .venv ...
  python -m venv .venv || (echo [x] 创建虚拟环境失败 & pause & exit /b 1)
)

echo [2/3] 安装依赖（首次会慢一点）...
".venv\Scripts\python.exe" -m pip install -q --upgrade pip
".venv\Scripts\python.exe" -m pip install -q -r requirements.txt || (echo [x] 装依赖失败 & pause & exit /b 1)

echo [3/3] 启动服务（关掉这个窗口就是停止服务）
echo.
".venv\Scripts\python.exe" run_web.py
pause
