# -*- coding: utf-8 -*-
"""用户端 API：登录、商品、任务、库存监听、推送、答题、设置。"""
import datetime

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy import select

from . import dewu_client as DW
from .auth import (clear_cookie, create_session, current_user, drop_session,
                   set_cookie)
from .db import db_session, global_cfg
from .models import Log, RedeemCode, Task, User, merge_defaults
from .runtime import ST_DELETED, ST_WAIT, runtime_for
from .security import COOKIE_USER

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
      · {phone, password}  → 走 dewu_login 的客户端加密（推荐）
      · {curl}             → 粘贴自己的抓包 curl（登录被风控时的兜底）
    """
    phone = str(payload.get("phone") or "").strip()
    password = str(payload.get("password") or "")
    curl = str(payload.get("curl") or "").strip()
    g = global_cfg()

    activity = ""
    dewu_uid = None
    if curl:
        token = DW.token_from_curl(curl)
        if not token:
            return {"ok": False, "msg": "这段 curl 里没找到 x-auth-token，"
                                        "请复制得物「金币兑换」列表接口那一条（含 Cookie 的那条）"}
        activity = DW.activity_from_curl(curl)
        if not phone:
            phone = "curl-" + str(abs(hash(token)) % 10 ** 10)
    else:
        if not password:
            return {"ok": False, "msg": "请输入密码"}
        r = DW.login(phone, password)
        if not r.get("ok"):
            return {"ok": False, "msg": r.get("msg") or "登录失败"}
        token = r["token"]
        dewu_uid = r.get("user_id")
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
        if u.status != "active":
            return {"ok": False, "msg": "该账号已被管理员禁用"}
        u.token = token
        u.dewu_user_id = str(dewu_uid or u.dewu_user_id or "")
        if activity:
            u.activity = activity
        u.last_login_at = datetime.datetime.now()
        uid = u.id
        phone_show = u.phone

    tok = create_session("user", request=request, user_id=uid)
    set_cookie(response, "user", tok)
    rt = runtime_for(uid)
    rt.log("登录成功（%s）" % _mask(phone_show))
    rt.refresh()
    return {"ok": True, "user": {"id": uid, "phone": _mask(phone_show)}}


@router.post("/logout")
def logout(request: Request, response: Response):
    drop_session(request.cookies.get(COOKIE_USER))
    clear_cookie(response, "user")
    return {"ok": True}


@router.get("/me")
def me(request: Request):
    u = current_user(request)
    g = global_cfg()
    return {
        "ok": True,
        "user": {"id": u.id, "phone": _mask(u.phone), "remark": u.remark or "",
                 "activity": u.activity or g.get("dewu_activity"),
                 "dewu_user_id": u.dewu_user_id or "",
                 "created_at": u.created_at.strftime("%Y-%m-%d %H:%M") if u.created_at else ""},
        "settings": u.st(),
        "proxy": runtime_for(u.id).proxy_info(),
        "global": {"activity": g.get("dewu_activity"),
                   "require_code": g.get("require_code_for_task"),
                   "proxy_enabled": g.get("proxy_enabled"),
                   "proxy_required": g.get("proxy_required")},
    }


# ==================================================================== 状态
@router.get("/state")
def state(request: Request, logs: int = 120):
    u = current_user(request)
    rt = runtime_for(u.id)
    snap = rt.snapshot()
    with db_session() as s:
        # 「已删除」只是逻辑删除（保留历史），不该再出现在用户的列表里
        tasks = [t.brief() for t in s.scalars(
            select(Task).where(Task.user_id == u.id, Task.status != ST_DELETED)
            .order_by(Task.id.desc()))]
    snap["tasks"] = tasks
    snap["logs"] = rt.logs_snapshot(logs)
    snap["server_time"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    snap["push_ready"] = rt.push_ready()
    return snap


@router.post("/products/refresh")
def refresh(request: Request):
    u = current_user(request)
    rt = runtime_for(u.id)
    ok, msg = rt.refresh()
    return {"ok": ok, "msg": msg}


# ==================================================================== 兑换码
def _consume_code(s, code_text, user_id, task_id):
    """在同一个事务里核销兑换码。返回 (ok, msg)。"""
    code_text = str(code_text or "").strip().upper()
    if not code_text:
        return False, "请输入兑换码"
    c = s.scalars(select(RedeemCode).where(RedeemCode.code == code_text)).first()
    if c is None:
        return False, "兑换码不存在"
    if c.status == "disabled":
        return False, "这个兑换码已被管理员作废"
    if int(c.used or 0) >= int(c.quota or 1):
        return False, "这个兑换码已经用过了（一个兑换码只能创建 %d 个任务）" % (c.quota or 1)
    if c.bound_user_id and c.bound_user_id != user_id:
        return False, "这个兑换码已经被其他用户使用了"
    c.used = int(c.used or 0) + 1
    c.bound_user_id = user_id
    c.bound_task_id = task_id
    c.used_at = datetime.datetime.now()
    if c.used >= int(c.quota or 1):
        c.status = "used"
    return True, "ok"


# ==================================================================== 任务
@router.post("/tasks")
def create_task(payload: dict, request: Request):
    u = current_user(request)
    rt = runtime_for(u.id)
    g = global_cfg()

    cid = payload.get("cId")
    code_text = payload.get("code") or ""
    if g.get("require_code_for_task") and not code_text:
        return {"ok": False, "msg": "请输入兑换码（一个兑换码只能创建一个任务）"}

    snap = rt.snapshot()
    prize = next((p for p in snap["products"] if p.get("cId") == cid), None)
    if prize is None:
        return {"ok": False, "msg": "商品不在当前列表里，请先刷新列表再选"}

    st = u.st()
    td = st.get("task_defaults") or {}
    try:
        tstr = str(payload.get("time") or td.get("time") or "10:00:00").strip()
        hh, mm, ss = [int(x) for x in tstr.split(":")]
        assert 0 <= hh < 24 and 0 <= mm < 60 and 0 <= ss < 60
        lead = max(0, int(payload.get("lead_ms") or td.get("lead_ms") or 300))
        interval = max(30, int(payload.get("interval_ms") or td.get("interval_ms") or 200))
        max_attempts = max(1, int(payload.get("max_attempts") or td.get("max_attempts") or 600))
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
        if code_text:
            ok, msg = _consume_code(s, code_text, u.id, tid)
            if not ok:
                s.rollback()
                return {"ok": False, "msg": msg}
            task.code_id = None
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


# ==================================================================== 库存监听
@router.post("/watch/start")
def watch_start(payload: dict, request: Request):
    u = current_user(request)
    rt = runtime_for(u.id)
    ok, msg = rt.watch_start(interval_sec=(payload or {}).get("interval_sec"))
    return {"ok": ok, "msg": msg}


@router.post("/watch/stop")
def watch_stop(request: Request):
    u = current_user(request)
    ok, msg = runtime_for(u.id).watch_stop_now()
    return {"ok": ok, "msg": msg}


@router.post("/watch/once")
def watch_once(request: Request):
    u = current_user(request)
    rt = runtime_for(u.id)
    rt._watch_tick()
    info = rt.watch_info()
    if info.get("last_error"):
        return {"ok": False, "msg": "检查失败：%s" % info["last_error"]}
    return {"ok": True, "msg": "检查完成 · 已监听 %s 个商品" % info.get("tracked", 0)}


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
    snap = rt.snapshot()
    sess = rt.session()
    if sess is None:
        return {"ok": False, "msg": "登录态丢失，请重新登录"}
    ok, msg = sess.probe_chain(snap["products"], snap["balance"])
    rt.log("[链路诊断] %s" % msg, "ok" if ok else "error")
    return {"ok": bool(ok), "msg": msg}


# ==================================================================== 每日答题
@router.get("/answer/today")
def answer_today(request: Request):
    u = current_user(request)
    sess = runtime_for(u.id).session()
    if sess is None:
        return {"ok": False, "msg": "登录态丢失，请重新登录"}
    a = (u.st().get("answer") or {})
    info, err = sess.answer_today(biz=a.get("biz_activity") or 2)
    if err:
        return {"ok": False, "msg": err}
    return {"ok": True, "info": info, "hint": DW.answer_hint(info)}


@router.post("/answer/submit")
def answer_submit(payload: dict, request: Request):
    u = current_user(request)
    rt = runtime_for(u.id)
    sess = rt.session()
    if sess is None:
        return {"ok": False, "msg": "登录态丢失，请重新登录"}
    a = (u.st().get("answer") or {})
    ans = str(payload.get("answer") or "").strip()
    if not ans:
        return {"ok": False, "msg": "答案不能为空"}
    info, err = sess.answer_today(biz=a.get("biz_activity") or 2)
    if err:
        return {"ok": False, "msg": err}
    if info.get("answered"):
        return {"ok": True, "kind": "done", "msg": "今日已答对", "info": info}
    if info.get("remain") is not None and info["remain"] <= 0:
        return {"ok": True, "kind": "done", "msg": "今日次数已用完", "info": info}
    j, err = sess.answer_submit(info["question_id"], ans,
                                biz=a.get("biz_activity") or 2, sign=a.get("sign"))
    if err:
        return {"ok": False, "msg": err}
    kind, text = DW.answer_classify(j)
    rt.log("[答题] 提交「%s」→ %s" % (ans, text), "ok" if kind == "ok" else "warn")
    info2, _ = sess.answer_today(biz=a.get("biz_activity") or 2)
    return {"ok": True, "kind": kind, "msg": text, "info": info2 or info}
