# -*- coding: utf-8 -*-
"""会话（登录态）与 FastAPI 依赖。

会话是「服务端会话」：cookie 里只放一个随机串，真正的用户身份存数据库。
这样用户之间**天然隔离** —— 前端拿不到别人的任何东西，改 cookie 也猜不出别人的。
"""
import datetime

from fastapi import HTTPException, Request, Response

from .config import settings
from .db import db_session
from .models import Admin, Session as DbSession, User
from .security import COOKIE_ADMIN, COOKIE_USER, new_token


def _cookie_name(kind):
    return COOKIE_ADMIN if kind == "admin" else COOKIE_USER


def create_session(kind, request=None, user_id=None, admin_id=None):
    tok = new_token()
    with db_session() as s:
        s.add(DbSession(
            id=tok, kind=kind, user_id=user_id, admin_id=admin_id,
            expires_at=datetime.datetime.now() + datetime.timedelta(days=settings.session_days),
            ip=(request.client.host if request and request.client else "")[:64],
            ua=(request.headers.get("user-agent", "") if request else "")[:200],
        ))
    return tok


def drop_session(tok):
    if not tok:
        return
    with db_session() as s:
        row = s.get(DbSession, tok)
        if row:
            s.delete(row)


def set_cookie(resp: Response, kind, tok):
    resp.set_cookie(
        _cookie_name(kind), tok,
        max_age=settings.session_days * 86400,
        httponly=True, secure=settings.cookie_secure, samesite="lax", path="/",
    )


def clear_cookie(resp: Response, kind):
    resp.delete_cookie(_cookie_name(kind), path="/")


def lookup(kind, tok):
    """按 cookie 里的 token 找会话，返回 (session_row_snapshot, account_obj)。"""
    if not tok:
        return None, None
    with db_session() as s:
        row = s.get(DbSession, tok)
        if row is None or row.kind != kind:
            return None, None
        if row.expires_at and row.expires_at < datetime.datetime.now():
            s.delete(row)
            return None, None
        if kind == "admin":
            adm = s.get(Admin, row.admin_id) if row.admin_id else None
            return ({"id": row.id}, adm)
        usr = s.get(User, row.user_id) if row.user_id else None
        return ({"id": row.id}, usr)


# ------------------------------------------------------------------ 依赖
def current_user(request: Request) -> User:
    """必须登录的用户；未登录 → 401（前端据此跳登录页）。"""
    _, usr = lookup("user", request.cookies.get(COOKIE_USER))
    if usr is None:
        raise HTTPException(status_code=401, detail="未登录")
    if usr.status != "active":
        raise HTTPException(status_code=403, detail="账号已被管理员禁用")
    return usr


def current_admin(request: Request) -> Admin:
    _, adm = lookup("admin", request.cookies.get(COOKIE_ADMIN))
    if adm is None:
        raise HTTPException(status_code=401, detail="管理员未登录")
    return adm
