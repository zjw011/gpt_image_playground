# 得物整点抢兑助手 · Web 版
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Shanghai \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# 时区 + 编译依赖一次装完、装完依赖再把编译工具卸掉（同一个 RUN = 同一层，不会留在镜像里）
COPY requirements.txt .
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends tzdata gcc libpq-dev; \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime; echo $TZ > /etc/timezone; \
    pip install --no-cache-dir -r requirements.txt; \
    apt-get purge -y --auto-remove gcc libpq-dev; \
    rm -rf /var/lib/apt/lists/*

# ★ 只拷 web 版真正需要的东西。
#   dewu_sniper.py 故意**不拷**：它一被 import 就会实例化桌面版的 Manager 单例、
#   恢复未完成任务线程、甚至在开着监听时自动拉起监听线程 —— Web 进程不能有这种副作用。
#   （dewu_push 里对它的引用包在 try/except 里，import 失败会静默跳过。）
COPY webapp/ ./webapp/
# dewu_proxies.py = 代理 IP 池的实现，桌面版和 Web 版共用一份（webapp/proxies.py 只是转发）
COPY dewu_proxies.py dewu_login.py dewu_push.py tianqiip.py ./
COPY run_web.py .

RUN mkdir -p /app/webdata
VOLUME ["/app/webdata"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=4).status==200 else 1)"

# ★ 必须单 worker：定时抢兑是进程内线程，多 worker 会各跑一份、重复抢。
#   run_web.py 里已经固定 workers=1，不要在这里改成 uvicorn --workers N。
CMD ["python", "run_web.py"]
