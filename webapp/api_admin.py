# -*- coding: utf-8 -*-
"""管理端 API：兑换码批量生成、用户管理、全局设置、统计。

和用户端是**同一个系统**，只是登录入口不同（管理员登录 → admin cookie）。
"""
import datetime
import secrets

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import func, select

from .auth import (clear_cookie, create_session, current_admin, drop_session,
                   set_cookie)
from .db import db_session, put_setting
from .models import Admin, RedeemCode, Session as DbSession, Setting, Task, User
from .runtime import ST_DELETED, runtime_for
from .security import COOKIE_ADMIN, hash_pw, verify_pw

router = APIRouter(prefix="/api/admin", tags=["admin"])

# 去掉了容易看错的 0/O/1/I/L
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def _gen_code(prefix="DW", groups=2, size=4):
    body = "-".join("".join(secrets.choice(_ALPHABET) for _ in range(size))
                    for _ in range(groups))
    return ("%s-%s" % (prefix, body)) if prefix else body


def _mask(phone):
    p = str(phone or "")
    return p[:3] + "****" + p[-4:] if len(p) == 11 else p


# ==================================================================== 登录
@router.post("/login")
def admin_login(payload: dict, request: Request, response: Response):
    name = str(payload.get("username") or "").strip()
    pw = str(payload.get("password") or "")
    with db_session() as s:
        adm = s.scalars(select(Admin).where(Admin.username == name)).first()
        if adm is None or not verify_pw(pw, adm.pwd_hash):
            return {"ok": False, "msg": "用户名或密码不对"}
        adm.last_login_at = datetime.datetime.now()
        aid = adm.id
        uname = adm.username
    tok = create_session("admin", request=request, admin_id=aid)
    set_cookie(response, "admin", tok)
    return {"ok": True, "admin": {"id": aid, "username": uname}}


@router.post("/logout")
def admin_logout(request: Request, response: Response):
    drop_session(request.cookies.get(COOKIE_ADMIN))
    clear_cookie(response, "admin")
    return {"ok": True}


@router.get("/me")
def admin_me(request: Request):
    adm = current_admin(request)
    return {"ok": True, "admin": {"id": adm.id, "username": adm.username}}


@router.post("/password")
def change_password(payload: dict, request: Request):
    adm = current_admin(request)
    if not verify_pw(str(payload.get("old") or ""), adm.pwd_hash):
        return {"ok": False, "msg": "原密码不对"}
    new = str(payload.get("new") or "")
    if len(new) < 6:
        return {"ok": False, "msg": "新密码至少 6 位"}
    with db_session() as s:
        row = s.get(Admin, adm.id)
        row.pwd_hash = hash_pw(new)
    return {"ok": True}


# ==================================================================== 概览
@router.get("/overview")
def overview(request: Request):
    current_admin(request)
    with db_session() as s:
        nu = s.scalar(select(func.count(User.id))) or 0
        nt = s.scalar(select(func.count(Task.id)).where(Task.status != ST_DELETED)) or 0
        nok = s.scalar(select(func.count(Task.id)).where(Task.status == "成功")) or 0
        nfail = s.scalar(select(func.count(Task.id)).where(Task.status == "失败")) or 0
        nc = s.scalar(select(func.count(RedeemCode.id))) or 0
        nc_used = s.scalar(select(func.count(RedeemCode.id))
                           .where(RedeemCode.status == "used")) or 0
        nsess = s.scalar(select(func.count(DbSession.id))
                         .where(DbSession.kind == "user")) or 0
    return {"ok": True, "stats": {
        "users": nu, "tasks": nt, "success": nok, "fail": nfail,
        "codes": nc, "codes_used": nc_used, "sessions": nsess,
    }}


# ==================================================================== 用户
@router.get("/users")
def users(request: Request):
    current_admin(request)
    with db_session() as s:
        rows = list(s.scalars(select(User).order_by(User.id.desc())))
        out = []
        for u in rows:
            ntask = s.scalar(select(func.count(Task.id))
                             .where(Task.user_id == u.id, Task.status != ST_DELETED)) or 0
            nok = s.scalar(select(func.count(Task.id))
                           .where(Task.user_id == u.id, Task.status == "成功")) or 0
            out.append({
                "id": u.id, "phone": _mask(u.phone), "remark": u.remark or "",
                "dewu_user_id": u.dewu_user_id or "", "status": u.status,
                "activity": u.activity or "",
                "has_token": bool(u.token),
                "watch": bool((u.st().get("watch") or {}).get("enabled")),
                "push": bool((u.st().get("push") or {}).get("enabled")),
                "tasks": ntask, "success": nok,
                "created_at": u.created_at.strftime("%Y-%m-%d %H:%M") if u.created_at else "",
                "last_login": u.last_login_at.strftime("%Y-%m-%d %H:%M") if u.last_login_at else "",
            })
    return {"ok": True, "users": out}


@router.post("/users/{uid}/status")
def set_user_status(uid: int, payload: dict, request: Request):
    current_admin(request)
    st = str(payload.get("status") or "active")
    if st not in ("active", "banned"):
        return {"ok": False, "msg": "状态只能是 active / banned"}
    with db_session() as s:
        u = s.get(User, uid)
        if u is None:
            return {"ok": False, "msg": "用户不存在"}
        u.status = st
        if st == "banned":            # 禁用时顺手踢掉他的所有会话
            for sess in s.scalars(select(DbSession).where(DbSession.user_id == uid)):
                s.delete(sess)
    return {"ok": True}


@router.post("/users/{uid}/kick")
def kick_user(uid: int, request: Request):
    current_admin(request)
    with db_session() as s:
        n = 0
        for sess in s.scalars(select(DbSession).where(DbSession.user_id == uid)):
            s.delete(sess)
            n += 1
    return {"ok": True, "msg": "已踢下线 %d 个会话" % n}


@router.delete("/users/{uid}")
def delete_user(uid: int, request: Request):
    current_admin(request)
    with db_session() as s:
        u = s.get(User, uid)
        if u is None:
            return {"ok": False, "msg": "用户不存在"}
        for sess in s.scalars(select(DbSession).where(DbSession.user_id == uid)):
            s.delete(sess)
        for t in s.scalars(select(Task).where(Task.user_id == uid)):
            s.delete(t)
        s.delete(u)
    return {"ok": True}


# ==================================================================== 兑换码
@router.get("/codes")
def codes(request: Request, q: str = "", status: str = "", limit: int = 500):
    current_admin(request)
    with db_session() as s:
        stmt = select(RedeemCode).order_by(RedeemCode.id.desc()).limit(max(1, min(2000, limit)))
        rows = list(s.scalars(stmt))
        if q:
            ql = q.strip().upper()
            rows = [r for r in rows if ql in (r.code or "").upper() or ql in (r.note or "").upper()]
        if status:
            rows = [r for r in rows if r.status == status]
        out = [{
            "id": r.id, "code": r.code, "note": r.note or "",
            "quota": r.quota, "used": r.used, "status": r.status,
            "bound_user_id": r.bound_user_id, "bound_task_id": r.bound_task_id,
            "created_at": r.created_at.strftime("%Y-%m-%d %H:%M") if r.created_at else "",
            "used_at": r.used_at.strftime("%Y-%m-%d %H:%M") if r.used_at else "",
        } for r in rows]
    return {"ok": True, "codes": out, "total": len(out)}


@router.post("/codes/generate")
def generate_codes(payload: dict, request: Request):
    adm = current_admin(request)
    try:
        count = max(1, min(500, int(payload.get("count") or 1)))
        quota = max(1, min(100, int(payload.get("quota") or 1)))
    except Exception:
        return {"ok": False, "msg": "数量/配额格式不对"}
    prefix = str(payload.get("prefix") or "DW").strip().upper()[:8]
    note = str(payload.get("note") or "")[:110]
    made = []
    with db_session() as s:
        for _ in range(count):
            for _try in range(12):
                c = _gen_code(prefix)
                if not s.scalars(select(RedeemCode).where(RedeemCode.code == c)).first():
                    break
            else:
                return {"ok": False, "msg": "连续 12 次都撞码，请换一个前缀再试"}
            s.add(RedeemCode(code=c, note=note, quota=quota, used=0,
                             status="unused", created_by=adm.username))
            made.append(c)
    return {"ok": True, "codes": made, "count": len(made)}


@router.post("/codes/{cid}/status")
def code_status(cid: int, payload: dict, request: Request):
    current_admin(request)
    st = str(payload.get("status") or "")
    if st not in ("unused", "used", "disabled"):
        return {"ok": False, "msg": "状态只能是 unused / used / disabled"}
    with db_session() as s:
        r = s.get(RedeemCode, cid)
        if r is None:
            return {"ok": False, "msg": "兑换码不存在"}
        r.status = st
    return {"ok": True}


@router.post("/codes/delete")
def delete_codes(payload: dict, request: Request):
    current_admin(request)
    ids = payload.get("ids") or []
    if not isinstance(ids, list):
        return {"ok": False, "msg": "ids 必须是数组"}
    with db_session() as s:
        n = 0
        for i in ids:
            r = s.get(RedeemCode, int(i))
            if r is not None:
                s.delete(r)
                n += 1
    return {"ok": True, "msg": "已删除 %d 个" % n}


@router.post("/codes/export")
def export_codes(payload: dict, request: Request):
    """导出为纯文本（一行一个），方便发群/发好友。"""
    current_admin(request)
    status = str(payload.get("status") or "unused")
    with db_session() as s:
        rows = list(s.scalars(select(RedeemCode).where(RedeemCode.status == status)
                              .order_by(RedeemCode.id)))
    txt = "\n".join(r.code for r in rows)
    return {"ok": True, "text": txt, "count": len(rows)}


# ==================================================================== 全局设置
@router.get("/settings")
def get_global(request: Request):
    current_admin(request)
    with db_session() as s:
        out = {r.key: r.value for r in s.scalars(select(Setting))}
    return {"ok": True, "settings": out}


@router.post("/settings")
def save_global(payload: dict, request: Request):
    current_admin(request)
    allowed = {"dewu_activity", "dewu_sign", "dewu_answer_sign",
               "allow_new_user", "max_users", "require_code_for_task"}
    for k, v in (payload or {}).items():
        if k in allowed:
            if k == "max_users":
                try:
                    v = int(v or 0)
                except Exception:
                    v = 0
            elif k in ("allow_new_user", "require_code_for_task"):
                v = bool(v)
            else:
                v = str(v or "")
            put_setting(k, v)
    with db_session() as s:
        out = {r.key: r.value for r in s.scalars(select(Setting))}
    return {"ok": True, "settings": out}
