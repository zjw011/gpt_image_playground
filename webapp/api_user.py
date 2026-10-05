# -*- coding: utf-8 -*-
"""用户端 API：登录、商品、任务、库存监听、推送、答题、设置。"""
import datetime
import hmac
import hashlib

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy import select, update

from . import dewu_client as DW
from . import global_list as GL
from .auth import (clear_cookie, create_session, current_user, drop_session,
                   set_cookie, lookup)
from .db import db_session, global_cfg
from .models import Log, RedeemCode, Task, User, merge_defaults
from .runtime import ST_DELETED, ST_WAIT, LEAD_LOGIN_SEC, runtime_for
from .security import COOKIE_USER

from .access_links import COOKIE_ACCESS, request_grant, consume_grant

import dewu_push as PUSH

router = APIRouter(prefix="/api", tags=["user"])


def _err(code, msg):
    raise HTTPException(status_code=code, detail=msg)


def _mask(phone):
    p = str(phone or "")
    return p[:3] + "****" + p[-4:] if len(p) == 11 else p


# ==================================================================== 登录/登出
@router.post("/login")
def login(payload: dict, request: Request, response: Response):
    """两种登录方式：

      · ``{phone, password}``  → ★ **懒登录**：只把账号密码存下来，**后台不登录**。
        真登录发生在「创建了任务、开抢前 2 分钟」：那时才提一个 3 分钟的短效 IP，
        用**同一个 IP** 完成登录和兑换 —— 一个号只用一个出口，最不容易被风控。
      · ``{curl}``             → 粘贴自己的抓包 curl，直接拿 token（登录被风控时的兜底）。
        这条是即时的，不走懒登录。
    """
    from . import secret_store as SE

    phone = str(payload.get("phone") or "").strip()
    password = str(payload.get("password") or "")
    curl = str(payload.get("curl") or "").strip()
    g = global_cfg()

    activity = ""
    dewu_uid = None
    lazy = False
    if curl:
        token = DW.token_from_curl(curl)
        if not token:
            return {"ok": False, "msg": "这段 curl 里没找到 x-auth-token，"
                                        "请复制得物「金币兑换」列表接口那一条（含 Cookie 的那条）"}
        activity = DW.activity_from_curl(curl)
        if not phone:
            phone = "curl-" + hashlib.sha256(token.encode()).hexdigest()[:15]
    else:
        if not phone.isdigit() or len(phone) != 11:
            return {"ok": False, "msg": "请输入 11 位手机号"}
        if not password:
            return {"ok": False, "msg": "请输入密码"}
        if not SE.available():
            return {"ok": False, "msg": "服务器缺少 cryptography 库，存不了密码（"
                                        "pip install cryptography），请让管理员处理"}
        lazy = True
        token = ""                       # ★ 关键：不登录，token 留空
        activity = g.get("dewu_activity") or ""

    with db_session() as s:
        u = s.scalars(select(User).where(User.phone == phone)).first()
        if u is None:
            if not g.get("allow_new_user"):
                return {"ok": False, "msg": "管理员已关闭新用户登录"}
            n = len(list(s.scalars(select(User.id))))
            if g.get("max_users") and n >= int(g["max_users"]):
                return {"ok": False, "msg": "用户数已达上限（%s），请联系管理员" % g["max_users"]}
            u = User(phone=phone, remark=payload.get("remark") or "")
            u.settings = merge_defaults({})
            s.add(u)
            s.flush()
        if lazy and u.token and not u.pw_enc:
            _, owner = lookup(
                "user", request.cookies.get(COOKIE_USER))
            if owner is None or owner.id != u.id:
                return {"ok": False, "msg": "此账号使用抓包登录，请先使用原登录方式进入"}
        if u.pw_enc and (not lazy or not hmac.compare_digest(
                password.encode(), SE.decrypt(u.pw_enc).encode())):
            return {"ok": False, "msg": "账号或密码不正确；修改得物密码后请联系管理员重置本站凭据"}
        if not lazy and u.token and not hmac.compare_digest(token, u.token):
            return {"ok": False, "msg": "登录凭据不正确"}
        if u.status != "active":
            return {"ok": False, "msg": "该账号已被管理员禁用"}
        if lazy:
            # 已校验的同一凭据再次进入不清除本轮 token，避免影响已准备任务。
            if not u.pw_enc:
                u.token = ""
                u.login_ip = ""
                u.login_where = ""
                u.login_at = None
            u.pw_enc = SE.encrypt(password)
        else:
            u.token = token
            u.pw_enc = ""                # 改用 curl 模式 → 不再自动登录
            u.login_where = ""
        u.dewu_user_id = str(dewu_uid or u.dewu_user_id or "")
        if activity:
            u.activity = activity
        u.last_login_at = datetime.datetime.now()
        uid = u.id
        phone_show = u.phone

    tok = create_session("user", request=request, user_id=uid)
    set_cookie(response, "user", tok)
    rt = runtime_for(uid)
    if lazy:
        rt.log("已保存账号密码（%s）—— 暂不登录，开抢前 %d 秒才自动登录"
               % (_mask(phone_show), LEAD_LOGIN_SEC))
    else:
        rt.log("登录成功（%s · 抓包 token 模式）" % _mask(phone_show))
    if GL.configured():
        GL.ensure_fresh()            # 商品列表由公共账号提供，顺手刷一下
    elif not lazy:
        rt.refresh()
    return {"ok": True, "lazy": lazy,
            "user": {"id": uid, "phone": _mask(phone_show)},
            "msg": "账号密码已保存，创建任务后、开抢前 %d 秒才会自动登录"
                   % LEAD_LOGIN_SEC if lazy else "登录成功"}


@router.post("/logout")
def logout(request: Request, response: Response):
    drop_session(request.cookies.get(COOKIE_USER))
    clear_cookie(response, "user")
    response.delete_cookie(COOKIE_ACCESS, path="/")
    return {"ok": True}


@router.get("/me")
def me(request: Request):
    from . import tianqi as TQ
    u = current_user(request)
    g = global_cfg()
    pub = GL.public_view()
    rt = runtime_for(u.id)
    li = rt.login_info()
    grant = request_grant(request)
    return {
        "ok": True,
        "user": {"id": u.id, "phone": _mask(u.phone), "remark": u.remark or "",
                 "activity": u.activity or g.get("dewu_activity"),
                 "dewu_user_id": u.dewu_user_id or "",
                 "created_at": u.created_at.strftime("%Y-%m-%d %H:%M") if u.created_at else ""},
        "access_link": grant,
        "settings": u.st(),
        "proxy": rt.proxy_info(),
        # ★ 登录状态：懒登录模式下这里长期是「未登录」，开抢前 2 分钟才会变成已登录
        "login": dict(li, lazy=bool(li.get("has_password")),
                      lead_sec=LEAD_LOGIN_SEC),
        "global": {"activity": g.get("dewu_activity"),
                   "require_code": bool(g.get("require_code_for_task") and not grant),
                   "proxy_enabled": g.get("proxy_enabled"),
                   "proxy_required": g.get("proxy_required"),
                   # 管理员配了公共账号 → 商品列表由它统一提供
                   "public_list": pub["configured"],
                   "list_source": "public" if pub["configured"] else "self",
                   # 天启IP 配好了才会在开抢前提 IP 登录，否则直连登录
                   "auto_ip": TQ.ready(),
                   "lead_login_sec": LEAD_LOGIN_SEC},
    }


# ==================================================================== 状态
@router.get("/state")
def state(request: Request, logs: int = 120):
    u = current_user(request)
    rt = runtime_for(u.id)
    snap = rt.snapshot()
    _apply_public_list(snap)
    with db_session() as s:
        # 「已删除」只是逻辑删除（保留历史），不该再出现在用户的列表里
        tasks = [t.brief() for t in s.scalars(
            select(Task).where(Task.user_id == u.id, Task.status != ST_DELETED)
            .order_by(Task.id.desc()))]
    snap["tasks"] = tasks
    snap["logs"] = rt.logs_snapshot(logs)
    snap["server_time"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    snap["push_ready"] = rt.push_ready()
    snap["access_link"] = request_grant(request)
    snap["require_code"] = bool(global_cfg().get("require_code_for_task") and not snap["access_link"])
    return snap


def _apply_public_list(snap):
    """商品列表改走「公共账号」那份（管理员配了就共用，用户不登录也能看）。

    ★ 余额不跟着换 —— 公共账号的余额跟用户没关系，用户的余额永远是他自己的。
    ★ 管理员把公共账号清空后，缓存里那份就不再用了（否则会一直吃老数据）。
    """
    gp = GL.snapshot()
    pub = gp["config"]
    usable = bool(pub.get("configured"))
    snap["public_ready"] = usable
    if usable and gp["count"]:
        snap["products"] = gp["products"]
        snap["list_source"] = "public"
        snap["list_at"] = gp["at"]
        snap["list_error"] = None
    else:
        snap["list_source"] = "public" if usable else "self"
        if usable and gp["err"]:
            snap["list_error"] = "公共账号拉取失败：%s" % gp["err"]
    return snap


@router.post("/products/refresh")
def refresh(request: Request):
    """刷新商品列表。配了公共账号就刷那份（所有用户共用），否则刷自己的。"""
    u = current_user(request)
    if GL.configured():
        ok, msg = GL.refresh()
        return {"ok": ok, "msg": msg, "source": "public"}
    rt = runtime_for(u.id)
    ok, msg = rt.refresh()
    return {"ok": ok, "msg": msg, "source": "self"}


# ==================================================================== 兑换码
def _consume_code(s, code_text, user_id, task_id):
    """在同一个事务里核销兑换码。返回 (ok, msg)。"""
    code_text = str(code_text or "").strip().upper()
    if not code_text:
        return False, "请输入兑换码"
    c = s.scalars(select(RedeemCode).where(RedeemCode.code == code_text).with_for_update()).first()
    if c is None:
        return False, "兑换码不存在"
    if c.status == "disabled":
        return False, "这个兑换码已被管理员作废"
    if int(c.used or 0) >= int(c.quota or 1):
        return False, "这个兑换码已经用过了（一个兑换码只能创建 %d 个任务）" % (c.quota or 1)
    if c.bound_user_id and c.bound_user_id != user_id:
        return False, "这个兑换码已经被其他用户使用了"
    used = int(c.used or 0)
    quota = int(c.quota or 1)
    result = s.execute(update(RedeemCode).where(
        RedeemCode.id == c.id, RedeemCode.used == used,
        RedeemCode.status != "disabled"
    ).values(used=used + 1, bound_user_id=user_id, bound_task_id=task_id,
             used_at=datetime.datetime.now(),
             status="used" if used + 1 >= quota else c.status),
             execution_options={"synchronize_session": False})
    if result.rowcount != 1:
        return False, "兑换码正在被使用，请刷新后重试"
    return True, "ok"


# ==================================================================== 任务
@router.post("/tasks")
def create_task(payload: dict, request: Request):
    u = current_user(request)
    rt = runtime_for(u.id)
    g = global_cfg()

    from . import tianqi as TQ
    if u.pw_enc and not TQ.ready():
        return {"ok": False, "msg": "管理员尚未启用并配置天启代理，请联系管理员后创建任务"}
    cid = payload.get("cId")
    code_text = payload.get("code") or ""
    grant = request_grant(request)
    if g.get("require_code_for_task") and not code_text and not grant:
        return {"ok": False, "msg": "请输入兑换码（一个兑换码只能创建一个任务）"}

    snap = _apply_public_list(rt.snapshot())
    prize = next((p for p in snap["products"] if p.get("cId") == cid), None)
    if prize is None:
        return {"ok": False, "msg": "商品不在当前列表里，请先刷新列表再选"}

    st = u.st()
    td = st.get("task_defaults") or {}
    try:
        tstr = str(payload.get("time") or td.get("time") or "10:00:00").strip()
        hh, mm, ss = [int(x) for x in tstr.split(":")]
        assert 0 <= hh < 24 and 0 <= mm < 60 and 0 <= ss < 60
        lead = min(5000, max(0, int(payload.get("lead_ms", td.get("lead_ms", 0)))))
        interval = min(10000, max(200, int(payload.get("interval_ms", td.get("interval_ms", 200)))))
        max_attempts = min(600, max(1, int(payload.get("max_attempts", td.get("max_attempts", 200)))))
        repeat = bool(payload.get("repeat_daily"))
        fb_on = bool(payload.get("fallback", (st.get("fallback") or {}).get("enabled", True)))
    except Exception:
        return {"ok": False, "msg": "时间/参数格式不对（目标时间示例 10:00:00）"}

    with db_session() as s:
        task = Task(user_id=u.id, prize=prize, orig_prize=dict(prize),
                    target_time=tstr, lead_ms=lead, interval_ms=interval,
                    max_attempts=max_attempts, repeat_daily=repeat,
                    fallback_enabled=fb_on, status=ST_WAIT, detail="排队中")
        s.add(task)
        s.flush()
        tid = task.id
        if grant and not code_text:
            grant_id = consume_grant(s, request.cookies.get(COOKIE_ACCESS))
            if not grant_id:
                s.rollback()
                return {"ok": False, "msg": "免码链接已失效或额度已用完，请使用兑换码"}
            task.access_link_id = grant_id
        if code_text:
            ok, msg = _consume_code(s, code_text, u.id, tid)
            if not ok:
                s.rollback()
                return {"ok": False, "msg": msg}
            task.code_id = s.scalars(select(RedeemCode.id).where(
                RedeemCode.code == str(code_text).strip().upper())).first()
        s.add(Log(user_id=u.id, msg="创建任务#%d：「%s」金币%s @ %s 每天%s"
                  % (tid, prize.get("cName"), prize.get("cost"), tstr, tstr)))

    rt.log("创建任务#%d：「%s」金币%s @ %s%s"
           % (tid, prize.get("cName"), prize.get("cost"), tstr,
              " · 已开自动降级" if fb_on else ""))
    rt.schedule(tid, run_now=bool(payload.get("run_now")))
    return {"ok": True, "task_id": tid}


@router.post("/tasks/{task_id}/delete")
def delete_task(task_id: int, request: Request):
    u = current_user(request)
    rt = runtime_for(u.id)
    rt.stop_task(task_id)
    with db_session() as s:
        t = s.get(Task, task_id)
        if t is None or t.user_id != u.id:
            return {"ok": False, "msg": "任务不存在"}
        t.status = ST_DELETED
    rt.log("已删除任务#%d" % task_id)
    return {"ok": True}


@router.post("/tasks/{task_id}/stop")
def stop_task(task_id: int, request: Request):
    u = current_user(request)
    rt = runtime_for(u.id)
    ok, msg = rt.stop_task(task_id)
    return {"ok": ok, "msg": msg}


@router.post("/tasks/{task_id}/run_now")
def run_now(task_id: int, request: Request):
    u = current_user(request)
    rt = runtime_for(u.id)
    with db_session() as s:
        t = s.get(Task, task_id)
        if t is None or t.user_id != u.id:
            return {"ok": False, "msg": "任务不存在"}
        t.status = ST_WAIT
    ok, msg = rt.schedule(task_id, run_now=True)
    return {"ok": ok, "msg": msg}


@router.post("/tasks/clear_done")
def clear_done(request: Request):
    u = current_user(request)
    rt = runtime_for(u.id)
    with db_session() as s:
        for t in s.scalars(select(Task).where(Task.user_id == u.id)):
            if t.status not in (ST_WAIT, "兑换中"):
                t.status = ST_DELETED
    return {"ok": True}


# ==================================================================== 库存监听（已下线）
# ★ Web 端不再让用户自己跑监听：客户的账号只在开抢前 LEAD_LOGIN_SEC 秒被用到，
#   库存变化由服务端用公共账号统一拉（商品列表那份），实时提醒走组织群二维码公告。
#   这两个写接口保留路径只为让老客户端拿到一句人话，不再真的去登录客户账号。
_WATCH_RETIRED = ("库存监听已下线：库存由服务端统一监控（不占用你的账号）。"
                  "请在「设置 → 公告」扫码加入组织群，实时库存变化会在群里通知。")


@router.post("/watch/start")
def watch_start(payload: dict, request: Request):
    current_user(request)
    return {"ok": False, "msg": _WATCH_RETIRED}


@router.post("/watch/stop")
def watch_stop(request: Request):
    """保留：把历史遗留的监听线程停掉（幂等，不会再起）。"""
    u = current_user(request)
    ok, msg = runtime_for(u.id).watch_stop_now()
    return {"ok": ok, "msg": msg}


@router.post("/watch/once")
def watch_once(request: Request):
    current_user(request)
    return {"ok": False, "msg": _WATCH_RETIRED}


# ==================================================================== 设置
@router.post("/settings")
def save_settings(payload: dict, request: Request):
    """保存推送 / 库存监听 / 自动降级 / 答题 / 代理 的开关（只允许改这几个 section）。"""
    u = current_user(request)
    st = u.st()
    for sec in ("push", "watch", "fallback", "answer", "task_defaults", "proxy"):
        got = payload.get(sec)
        if isinstance(got, dict):
            st[sec].update({k: v for k, v in got.items() if k in st[sec]})
    if "topic" in st["push"]:
        st["push"]["topic"] = PUSH.clean_topic(st["push"].get("topic"))
    with db_session() as s:
        row = s.get(User, u.id)
        row.settings = st
    return {"ok": True, "settings": st}


# ==================================================================== 代理 IP
@router.get("/proxy")
def proxy_get(request: Request):
    """这个账号的代理状态（当前出口 IP / 池子大小 / 会不会真的走代理）。"""
    u = current_user(request)
    return {"ok": True, "proxy": runtime_for(u.id).proxy_info()}


@router.post("/proxy/rotate")
def proxy_rotate(request: Request, payload: dict = None):
    """换一个出口 IP（从管理员导入的池子里挑另一个绑过来）。"""
    u = current_user(request)
    rt = runtime_for(u.id)
    ok, msg = rt.proxy_rotate(prefer_id=(payload or {}).get("id"))
    return {"ok": ok, "msg": msg, "proxy": rt.proxy_info()}


@router.post("/proxy/test")
def proxy_test(request: Request):
    """探一次当前代理：出口 IP 是几、延迟多少。"""
    u = current_user(request)
    rt = runtime_for(u.id)
    ok, msg = rt.proxy_test()
    return {"ok": ok, "msg": msg, "proxy": rt.proxy_info()}


@router.post("/push/test")
def push_test(request: Request):
    u = current_user(request)
    p = (u.st().get("push") or {})
    if not p.get("token"):
        return {"ok": False, "msg": "请先填 PushPlus token"}
    card = PUSH.build_card("success", u.remark or _mask(u.phone),
                           "示例商品 · 星巴克中杯拿铁券", 300, 1234,
                           datetime.datetime.now().strftime("%m-%d %H:%M:%S"),
                           task_id=1, attempts=3,
                           note="这是一条测试推送。看到它就说明 token 填对了。")
    ok, msg = PUSH.send("🎉 抢兑成功 | 这是一条测试推送", card, token=p["token"])
    if ok and p.get("topic") and p.get("group_stock", True):
        ok2, msg2 = PUSH.send("📢 库存群发测试 | 群里所有人都该收到这条",
                              card, token=p["token"], topic=p["topic"])
        return {"ok": ok2, "msg": "私发成功；群发：%s" % msg2}
    return {"ok": ok, "msg": msg}


# ==================================================================== 安全探针
@router.post("/probe")
def probe(request: Request):
    """不花金币地验证链路（挑买不起的商品去兑换，服务端会回余额不足）。"""
    u = current_user(request)
    rt = runtime_for(u.id)
    if rt.creds()[1]:
        return {"ok": False, "msg": "密码模式只在任务开始前登录，不提供即时链路诊断"}
    ok0, msg0 = rt.ensure_login()
    if not ok0:
        return {"ok": False, "msg": msg0}
    snap = _apply_public_list(rt.snapshot())
    sess = rt.session()
    if sess is None:
        return {"ok": False, "msg": "登录态丢失，请重新提交账号密码"}
    # ★ 余额用用户自己的（公共账号的金币跟这个号没关系）
    ok, msg = sess.probe_chain(snap["products"], snap.get("balance"))
    rt.log("[链路诊断] %s" % msg, "ok" if ok else "error")
    return {"ok": bool(ok), "msg": msg}


# ==================================================================== 每日答题（已下线）
# ★ 客户账号只在开抢前 LEAD_LOGIN_SEC 秒被用到，答题要登录客户账号 → Web 端不再提供。
#   路径保留只为给老客户端一句人话，不再触发任何登录。
_ANSWER_RETIRED = ("每日答题已下线：为避免频繁登录，你的账号只在抢兑前 2 分钟被用到。"
                   "金币请直接在得物 App 里答。")


@router.get("/answer/today")
def answer_today(request: Request):
    current_user(request)
    return {"ok": False, "msg": _ANSWER_RETIRED}


@router.post("/answer/submit")
def answer_submit(payload: dict, request: Request):
    current_user(request)
    return {"ok": False, "msg": _ANSWER_RETIRED}
