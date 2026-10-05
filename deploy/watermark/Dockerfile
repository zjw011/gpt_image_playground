FROM python:3.12-slim
WORKDIR /app
COPY deploy/watermark/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY deploy/watermark/worker.py ./
ENV PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
USER 10001:10001
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=2)"
CMD ["python", "worker.py"]
