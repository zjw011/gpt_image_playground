# -*- coding: utf-8 -*-
"""本地启动入口（不用 Docker 就跑这个）。

    python run_web.py

默认 http://127.0.0.1:8000
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

if __name__ == "__main__":
    import uvicorn

    from webapp.config import settings

    host = os.environ.get("HOST", "127.0.0.1")
    reload = os.environ.get("DEV_RELOAD", "").lower() in ("1", "true", "yes")
    print("=" * 62)
    print("  得物整点抢兑助手 · Web 版")
    print("  打开浏览器访问： http://%s:%d" % (host if host != "0.0.0.0" else "127.0.0.1",
                                              settings.port))
    print("  管理员入口：     http://%s:%d/admin" % (host if host != "0.0.0.0" else "127.0.0.1",
                                                   settings.port))
    print("  数据目录：       %s" % settings.data_dir)
    print("=" * 62)
    uvicorn.run("webapp.main:app", host=host, port=settings.port,
                workers=1, reload=reload,
                forwarded_allow_ips=os.environ.get("FORWARDED_ALLOW_IPS", "127.0.0.1"))
