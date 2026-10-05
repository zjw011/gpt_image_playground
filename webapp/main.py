# -*- coding: utf-8 -*-
"""FastAPI 应用装配。

★ 必须单 worker 运行：定时抢兑是进程内线程，多 worker 会各自跑一份任务、重复抢。
"""
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import api_admin, api_user
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
    yield


app = FastAPI(title="得物整点抢兑助手 · Web 版", docs_url=None, redoc_url=None,
              lifespan=lifespan)

app.include_router(api_user.router)
app.include_router(api_admin.router)


@app.exception_handler(HTTPException)
async def http_exc(_req: Request, exc: HTTPException):
    """统一成 {ok:false,msg}，前端只看这两个字段。"""
    return JSONResponse(status_code=exc.status_code,
                        content={"ok": False, "msg": exc.detail, "code": exc.status_code})


@app.get("/admin")
def admin_page():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/healthz")
def healthz():
    return {"ok": True}


# 静态文件挂在最后：/api/* 已经被上面的路由抢走了
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
