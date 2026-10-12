FROM python:3.12-slim
WORKDIR /app
COPY deploy/watermark/requirements.txt ./
# 国内服务器使用 HTTPS 镜像；允许构建时覆盖，但不关闭证书校验。
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
# 连接重试不等于中途下载重试，旧版 pip 读取超时后需要重跑整个安装。
RUN for attempt in 1 2 3; do \
      if python -m pip install --no-cache-dir --disable-pip-version-check \
        --index-url "$PIP_INDEX_URL" --timeout 120 --retries 5 \
        --only-binary=:all: --progress-bar off -r requirements.txt; then exit 0; fi; \
      if [ "$attempt" = 3 ]; then exit 1; fi; \
      echo "Python dependencies download failed, retrying ($attempt/3)..."; \
      sleep 5; \
    done
COPY deploy/watermark/worker.py ./
ENV PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
USER 10001:10001
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=2)"
CMD ["python", "worker.py"]
