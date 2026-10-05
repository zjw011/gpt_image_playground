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
from .models import (Admin, Proxy, RedeemCode, Session as DbSession, Setting,
                     Task, User)
from .runtime import ST_DELETED, runtime_for
from .security import COOKIE_ADMIN, hash_pw, verify_pw

router = APIRouter(prefix="/api/admin", tags=["admin"])

# ★ 这些 Setting 里有明文密钥/密码，通用 /settings 接口必须把它们过滤掉：
#   public_account = 公共账号的得物密码；tianqi = 天启IP 的 secret/sign/key
_SECRET_KEYS = ("public_account", "tianqi")

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


# ==================================================================== 代理 IP
def _px_row(p):
    from . import proxies as PX
    return {
        "id": p.id,
        "mask": PX.mask(p.url),
        "hostport": PX.hostport(p.url),
        "kind": p.kind, "scheme": p.scheme,
        "label": p.label or "",
        "status": p.status, "enabled": bool(p.enabled),
        "exit_ip": p.exit_ip or "", "latency_ms": p.latency_ms or 0,
        "ok_count": p.ok_count or 0, "fail_count": p.fail_count or 0,
        "fail_streak": p.fail_streak or 0,
        "bound_user_id": p.bound_user_id,
        "last_ok_at": p.last_ok_at.strftime("%m-%d %H:%M") if p.last_ok_at else "",
        "last_error": p.last_error or "",
        "created_at": p.created_at.strftime("%Y-%m-%d %H:%M") if p.created_at else "",
    }


@router.get("/proxies")
def list_proxies(request: Request, q: str = "", status: str = ""):
    """代理池列表 + 汇总结论。"""
    from . import proxies as PX
    current_admin(request)
    with db_session() as s:
        rows = list(s.scalars(select(Proxy).order_by(Proxy.id.desc())))
        users = {u.id: _mask(u.phone) for u in s.scalars(select(User))}
        g = {r.key: r.value for r in s.scalars(select(Setting))}
        items = [_px_row(p) for p in rows]
    if q:
        ql = q.strip().lower()
        items = [i for i in items if ql in i["mask"].lower() or ql in i["label"].lower()
                 or ql in i["hostport"].lower() or ql in i["exit_ip"]]
    if status:
        items = [i for i in items if i["status"] == status]
    for i in items:
        i["bound_phone"] = users.get(i["bound_user_id"], "")
    stats = {
        "total": len(items),
        "alive": sum(1 for i in items if i["enabled"]),
        "ok": sum(1 for i in items if i["enabled"] and i["status"] == "ok"),
        "bad": sum(1 for i in items if i["enabled"] and i["status"] == "bad"),
        "bound": sum(1 for i in items if i["bound_user_id"]),
        "untested": sum(1 for i in items if i["status"] == "new"),
        "master": bool(g.get("proxy_enabled")),
        "required": bool(g.get("proxy_required")),
        "socks": sum(1 for i in items if i["kind"] == "socks"),
    }
    return {"ok": True, "proxies": items, "stats": stats,
            "schemes": list(PX.SCHEMES)}


@router.post("/proxies/import")
def import_proxies(payload: dict, request: Request):
    """批量粘贴导入。一行一个，格式见 webapp/proxies.normalize_line。

    ``text``      多行文本
    ``scheme``    裸 ``host:port`` 行默认当成什么协议（socks5h / socks5 / http）
    ``label``     给这一批统一打个备注
    """
    from . import proxies as PX
    current_admin(request)
    text = str(payload.get("text") or "")
    scheme = str(payload.get("scheme") or PX.DEFAULT_SCHEME).lower()
    if scheme not in PX.SCHEMES:
        scheme = PX.DEFAULT_SCHEME
    batch_label = str(payload.get("label") or "")[:60]
    items, errors = PX.normalize_many(text, default_scheme=scheme)
    if not items:
        return {"ok": False, "msg": "没有解析出任何代理（检查一下格式）",
                "errors": errors, "added": 0}

    added, dup = 0, 0
    with db_session() as s:
        exist = {u for (u,) in s.execute(select(Proxy.url)).all()}
        for d in items:
            if d["url"] in exist:
                dup += 1
                continue
            s.add(Proxy(url=d["url"], kind=d["kind"], scheme=d["scheme"],
                        host=d["host"], port=d["port"], user=d["user"],
                        label=d["label"] or batch_label, status="new"))
            exist.add(d["url"])
            added += 1
    return {"ok": True, "added": added, "dup": dup, "errors": errors[:20],
            "bad_count": len(errors),
            "msg": "导入 %d 个（跳过重复 %d 个，格式不对 %d 行）"
                   % (added, dup, len(errors))}


@router.post("/proxies/check")
def check_proxies(payload: dict, request: Request):
    """探测代理：``ids`` 为空则测全部未禁用的（上限 200 个，免得卡死）。"""
    from . import proxies as PX
    current_admin(request)
    ids = payload.get("ids") or []
    with db_session() as s:
        stmt = select(Proxy).where(Proxy.enabled.is_(True)).order_by(Proxy.id).limit(200)
        rows = list(s.scalars(stmt))
        if ids:
            rows = [r for r in rows if r.id in [int(i) for i in ids]]
        targets = [(r.id, r.url) for r in rows]

    good, bad, out = 0, 0, []
    for pid, url in targets:
        ok, ip, ms, err = PX.check(url)
        with db_session() as s:
            p = s.get(Proxy, pid)
            if p is None:
                continue
            p.latency_ms = ms
            if ok:
                p.exit_ip = ip or ""
                p.status = "ok"
                p.last_ok_at = datetime.datetime.now()
                p.last_error = ""
                p.fail_streak = 0
                good += 1
            else:
                p.status = "bad"
                p.last_error = str(err or "")[:300]
                p.fail_streak = int(p.fail_streak or 0) + 1
                bad += 1
        out.append({"id": pid, "ok": ok, "exit_ip": ip, "latency_ms": ms,
                    "error": err})
    return {"ok": True, "good": good, "bad": bad, "results": out,
            "msg": "检测完成：可用 %d 个，不通 %d 个" % (good, bad)}


@router.post("/proxies/delete")
def delete_proxies(payload: dict, request: Request):
    current_admin(request)
    ids = payload.get("ids") or []
    if not isinstance(ids, list):
        return {"ok": False, "msg": "ids 必须是数组"}
    n = 0
    with db_session() as s:
        for i in ids:
            p = s.get(Proxy, int(i))
            if p is not None:
                s.delete(p)
                n += 1
    return {"ok": True, "msg": "已删除 %d 个" % n}


@router.post("/proxies/auto_assign")
def auto_assign_proxies(payload: dict, request: Request):
    """把「还没绑人」的可用代理，按顺序发给「还没代理」的用户。

    ``only_ok`` 默认 True：只发探测通过的。池子不够就有人分不到 ——
    分不到的用户抢兑走直连，不会报错。
    """
    current_admin(request)
    only_ok = payload.get("only_ok", True)
    with db_session() as s:
        q = select(Proxy).where(Proxy.enabled.is_(True), Proxy.bound_user_id.is_(None))
        if only_ok:
            q = q.where(Proxy.status == "ok")
        free = list(s.scalars(q.order_by(Proxy.latency_ms.asc(), Proxy.id.asc())))
        busy_users = {u for (u,) in s.execute(
            select(Proxy.bound_user_id).where(Proxy.bound_user_id.isnot(None))).all()}
        users = [u for u in s.scalars(select(User).order_by(User.id)) if u.id not in busy_users]
        n = 0
        for p, u in zip(free, users):
            p.bound_user_id = u.id
            n += 1
    return {"ok": True, "assigned": n,
            "msg": "已分配 %d 个（空余代理 %d，等待分配的用户 %d）"
                   % (n, len(free), len(users))}


# ★ 注意顺序：FastAPI 按声明顺序匹配，带 {pid} 的这条路必须放在所有
#   字面量路径（import / check / delete / auto_assign）后面，
#   否则 /proxies/auto_assign 会被当成 pid=auto_assign 而 422。
@router.post("/proxies/{pid}")
def update_proxy(pid: int, payload: dict, request: Request):
    """改单个代理：启用/停用、备注、绑定给谁（bound_user_id=0 表示解绑）。

    也允许直接改 ``status / exit_ip / latency_ms`` —— 管理员手工标注用：
    比如代理商那边换了出口、或者你知道这个 IP 已经废了，不用等探测就能标出来。
    """
    current_admin(request)
    with db_session() as s:
        p = s.get(Proxy, pid)
        if p is None:
            return {"ok": False, "msg": "代理不存在"}
        if "enabled" in payload:
            p.enabled = bool(payload.get("enabled"))
        if "label" in payload:
            p.label = str(payload.get("label") or "")[:60]
        if "status" in payload:
            v = str(payload.get("status") or "").strip()
            p.status = v if v in ("ok", "bad", "untested") else p.status
        if "exit_ip" in payload:
            p.exit_ip = str(payload.get("exit_ip") or "")[:64]
        if "latency_ms" in payload:
            try:
                p.latency_ms = max(0, int(payload.get("latency_ms") or 0))
            except (TypeError, ValueError):
                pass
        if "bound_user_id" in payload:
            v = payload.get("bound_user_id")
            try:
                v = int(v or 0)
            except Exception:
                v = 0
            if v:
                # 一个用户只留一个代理：先把别人身上的这个用户解绑
                for other in s.scalars(select(Proxy).where(
                        Proxy.bound_user_id == v, Proxy.id != pid)):
                    other.bound_user_id = None
            p.bound_user_id = v or None
        row = _px_row(p)
    return {"ok": True, "proxy": row}


# ==================================================================== 天启IP
# 抢兑前 2 分钟要「提一个短效 IP → 用同一个 IP 登录 → 到点兑换」，靠的就是它。
def _tq_status():
    from . import tianqi as TQ
    c = TQ.cfg()
    return {"last_ok_at": c["last_ok_at"], "last_err": c["last_err"],
            "where": c["last_where"]}


@router.get("/tianqi")
def get_tianqi(request: Request):
    from . import tianqi as TQ
    current_admin(request)
    return {"ok": True, "config": TQ.public_view(), "status": _tq_status(),
            "lead_login_sec": TQ.LEAD_LOGIN_SEC,
            "lives": list(__import__("tianqiip").LIVES)}


@router.post("/tianqi")
def save_tianqi(payload: dict, request: Request):
    """保存天启配置。★ 密钥字段回显的是打码值 —— 原样发回来不会覆盖真值。"""
    from . import tianqi as TQ
    current_admin(request)
    kw = {}
    for k in TQ.FIELDS:
        if k not in payload:
            continue
        v = payload.get(k)
        if k in TQ.MASK_FIELDS:
            s = str(v or "")
            if not s or set(s) == {"*"} or "*" in s:   # 打码回显 → 不动真值
                continue
            kw[k] = s
        elif k == "enabled":
            kw[k] = bool(v)
        elif k in ("protocol", "life"):
            kw[k] = v
        else:
            kw[k] = v
    TQ.save_cfg(**kw)
    return {"ok": True, "msg": "已保存", "config": TQ.public_view(),
            "status": _tq_status()}


@router.post("/tianqi/test")
def test_tianqi(request: Request):
    """真提一个 IP 看看 —— 验证 secret/sign 对不对、白名单通不通。"""
    from . import tianqi as TQ
    current_admin(request)
    d, err = TQ.one_proxy()
    if err:
        TQ.save_cfg(last_err=str(err)[:200])
        return {"ok": False, "msg": err, "config": TQ.public_view(),
                "status": _tq_status()}
    return {"ok": True, "msg": "提取成功：%s（%s）" % (d.get("url"), d.get("where")),
            "proxy": d, "config": TQ.public_view(), "status": _tq_status()}


@router.post("/tianqi/white")
def sync_tianqi_white(request: Request):
    """把本机公网 IP 加进天启白名单（免密的 s5 全靠它认人）。"""
    from . import tianqi as TQ
    current_admin(request)
    ip, err = TQ.client()
    if ip is None:
        return {"ok": False, "msg": err, "config": TQ.public_view(),
                "status": _tq_status()}
    ok, msg = ip.ensure_white()
    return {"ok": bool(ok), "msg": msg, "config": TQ.public_view(),
            "status": _tq_status()}


# ==================================================================== 公共账号
# 专门拿来「拉商品列表」的那个号。用户端不登录也能看列表，靠的就是它。
# ★ 密码绝不出这个接口（只回打码值），所以它不走进下面的通用 /settings。
def _pa_status(snap):
    """公共账号的运行状态（不含配置，配置走 config）。"""
    return {"ok": snap["ok"], "count": snap["count"], "balance": snap["balance"],
            "at": snap["at"], "err": snap["err"], "running": snap["running"],
            "logs": snap["logs"]}


@router.get("/public-account")
def get_public_account(request: Request):
    """读公共账号配置 + 当前状态。"""
    from . import global_list as GL
    current_admin(request)
    snap = GL.snapshot()
    return {"ok": True, "config": snap["config"], "status": _pa_status(snap)}


@router.post("/public-account")
def save_public_account(payload: dict, request: Request):
    """保存公共账号。密码留空 = 不改（前端把打码值回显成 * 也不会覆盖）。"""
    from . import global_list as GL
    current_admin(request)
    kw = {}
    if "phone" in payload:
        kw["phone"] = str(payload.get("phone") or "").strip()
    if "password" in payload:
        pw = str(payload.get("password") or "")
        if pw and set(pw) != {"*"}:        # 全是星号 = 前端回显的打码值，别当真密码存
            kw["password"] = pw
    if "enabled" in payload:
        kw["enabled"] = bool(payload.get("enabled"))
    if "interval_sec" in payload:
        kw["interval_sec"] = payload.get("interval_sec")
    cfg = GL.save_cfg(**kw)
    if not cfg.get("enabled"):
        GL.stop()
    elif GL.configured():
        GL.start()
    snap = GL.snapshot()
    return {"ok": True, "msg": "已保存", "config": snap["config"],
            "status": _pa_status(snap)}


@router.post("/public-account/test")
def test_public_account(request: Request):
    """强制重新登录 + 拉一次列表 —— 验证手机号密码对不对。"""
    from . import global_list as GL
    current_admin(request)
    ok, msg = GL.test_login()
    snap = GL.snapshot()
    return {"ok": ok, "msg": msg, "config": snap["config"],
            "status": _pa_status(snap)}


@router.post("/public-account/refresh")
def refresh_public_account(request: Request):
    """用现有登录态拉一次列表（不重新登录，省事）。"""
    from . import global_list as GL
    current_admin(request)
    ok, msg = GL.refresh()
    snap = GL.snapshot()
    return {"ok": ok, "msg": msg, "config": snap["config"],
            "status": _pa_status(snap)}


# ==================================================================== 全局设置
@router.get("/settings")
def get_global(request: Request):
    current_admin(request)
    with db_session() as s:
        # ★ public_account 里有明文密码，绝不能被通用接口带出去
        out = {r.key: r.value for r in s.scalars(select(Setting))
               if r.key not in _SECRET_KEYS}
    return {"ok": True, "settings": out}


@router.post("/settings")
def save_global(payload: dict, request: Request):
    current_admin(request)
    allowed = {"dewu_activity", "dewu_sign", "dewu_answer_sign",
               "allow_new_user", "max_users", "require_code_for_task",
               "proxy_enabled", "proxy_required"}
    for k, v in (payload or {}).items():
        if k in allowed:
            if k == "max_users":
                try:
                    v = int(v or 0)
                except Exception:
                    v = 0
            elif k in ("allow_new_user", "require_code_for_task",
                       "proxy_enabled", "proxy_required"):
                v = bool(v)
            else:
                v = str(v or "")
            put_setting(k, v)
    with db_session() as s:
        out = {r.key: r.value for r in s.scalars(select(Setting))
               if r.key not in _SECRET_KEYS}      # 同上：别带明文密钥
    return {"ok": True, "settings": out}
