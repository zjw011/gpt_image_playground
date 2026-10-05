# -*- coding: utf-8 -*-
"""FastAPI 应用装配。

★ 必须单 worker 运行：定时抢兑是进程内线程，多 worker 会各自跑一份任务、重复抢。
"""
import logging
import os
import time
from collections import defaultdict, deque
from urllib.parse import urlsplit
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import api_admin, api_user, global_list
from .db import init_db
from .runtime import boot_all

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    info = boot_all()
    logging.getLogger("dewu").info("启动完成：恢复 %(users)s 个用户 / %(tasks)s 个任务", info)
    # 公共账号（拉商品列表用）：配了才起，没配就是 no-op
    try:
        ok, msg = global_list.start()
        logging.getLogger("dewu").info("公共账号商品列表：%s", msg if ok else "未启用（%s）" % msg)
    except Exception:                       # noqa: BLE001
        logging.getLogger("dewu").exception("公共账号后台刷新启动失败")
    yield
    global_list.stop()


app = FastAPI(title="得物整点抢兑助手 · Web 版", docs_url=None, redoc_url=None,
              lifespan=lifespan)

# 限制登录猜测，并拒绝浏览器跨站写请求（反向代理需保留 Host）。
_login_attempts = defaultdict(deque)


@app.middleware("http")
async def request_guard(request: Request, call_next):
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        origin = request.headers.get("origin")
        if origin and urlsplit(origin).netloc != request.headers.get("host"):
            return JSONResponse(status_code=403, content={"ok": False, "msg": "不允许跨站提交"})
        if request.url.path in ("/api/login", "/api/admin/login"):
            now = time.monotonic()
            ip = request.client.host if request.client else "unknown"
            # 清理过期地址，避免公开服务的记录无限增长。
            for key in list(_login_attempts):
                q = _login_attempts[key]
                while q and now - q[0] >= 60:
                    q.popleft()
                if not q:
                    del _login_attempts[key]
            q = _login_attempts[ip]
            if len(q) >= 20:
                return JSONResponse(status_code=429, headers={"Retry-After": "60"},
                                    content={"ok": False, "msg": "登录过于频繁，请一分钟后重试"})
            q.append(now)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers["X-Frame-Options"] = "DENY"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


app.include_router(api_user.router)
app.include_router(api_admin.router)


@app.exception_handler(HTTPException)
async def http_exc(_req: Request, exc: HTTPException):
    """统一成 {ok:false,msg}，前端只看这两个字段。"""
    return JSONResponse(status_code=exc.status_code,
                        content={"ok": False, "msg": exc.detail, "code": exc.status_code})


@app.get("/access/{slug}/{token}")
def access_entry(slug: str, token: str):
    from .access_links import COOKIE_ACCESS, lookup_link, valid
    from .db import db_session
    from .config import settings
    with db_session() as s:
        link = lookup_link(s, token)
        if not valid(link) or link.slug != slug:
            response = JSONResponse(status_code=403, content={"ok": False, "msg": "免码链接无效、已停用、已过期或额度已用完"})
            response.delete_cookie(COOKIE_ACCESS, path="/")
            return response
    response = RedirectResponse("/", status_code=303)
    response.set_cookie(COOKIE_ACCESS, token, max_age=7 * 86400, httponly=True,
                        secure=settings.cookie_secure, samesite="lax", path="/")
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/admin")
def admin_page():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/healthz")
def healthz():
    return {"ok": True}


# 静态文件挂在最后：/api/* 已经被上面的路由抢走了
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
