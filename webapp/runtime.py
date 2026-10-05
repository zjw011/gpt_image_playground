# -*- coding: utf-8 -*-
"""每用户运行时。

隔离策略
--------
每个用户一个 ``UserRuntime`` 实例，注册表按 user_id 索引。
实例内部持有：商品缓存、日志环形缓冲、定时任务线程、库存监听线程。
所有跨用户的共享只有注册表本身（一把锁），用户之间**没有任何共享状态**。

为什么是「一个进程内的线程」而不是「交给外部任务队列」：
    定时抢兑需要在毫秒级准时发请求，而且要连续重试几百次（每秒 5~30 次）。
    线程是最贴近桌面版、也最省事的做法，FIFO 队列的开销在这个场景下反而不可控。
    代价：uvicorn 只能起 **单 worker**（多 worker 会各自跑一份任务，重复抢）。
"""
import datetime
import threading
import time
import traceback
from collections import deque

import dewu_push as PUSH
from sqlalchemy import func, or_, select

from .security import redact_message
from .db import db_session
from .dewu_client import DewuSession, diff_stock
from . import proxies as PX

MAX_LOGS = 400

# 任务状态
ST_WAIT = "等待"
ST_RUN = "兑换中"
ST_OK = "成功"
ST_FAIL = "失败"
ST_CANCEL = "已取消"
ST_DELETED = "已删除"

# ★ 懒登录：开抢前多久开始「提 IP + 登录」。
#   为什么是 2 分钟 —— 用户要的节奏：一个号只用一个 IP，
#   登录和兑换走同一个出口，最像真人。3 分钟的 IP 够覆盖「登录 + 等开抢 + 重试」。
LEAD_LOGIN_SEC = 120


def _now_str():
    return datetime.datetime.now().strftime("%m-%d %H:%M:%S")


def _next_target(tstr):
    """目标时间 → 下一个还没到的 datetime（今天过了就明天）。"""
    hh, mm, ss = [int(x) for x in str(tstr).split(":")]
    now = datetime.datetime.now()
    tgt = now.replace(hour=hh, minute=mm, second=ss, microsecond=0)
    if tgt <= now:
        tgt += datetime.timedelta(days=1)
    return tgt


class UserRuntime:
    def __init__(self, user_id):
        self.user_id = user_id
        self.lock = threading.RLock()
        self.login_lock = threading.Lock()
        self.login_lease = None

        self.products = []
        self.balance = None
        self.list_error = None
        self.refreshed_at = None

        self.logs = deque(maxlen=MAX_LOGS)
        self.task_threads = {}          # task_id -> Thread
        self.task_stop = {}             # task_id -> Event（手动停止）
        self.watch_thread = None
        self.watch_stop = threading.Event()

    # ------------------------------------------------------------------ 日志
    def log(self, msg, level="info"):
        msg = redact_message(msg)
        line = "%s  %s" % (datetime.datetime.now().strftime("%H:%M:%S"), msg)
        with self.lock:
            self.logs.append({"ts": _now_str(), "level": level, "msg": msg, "line": line})

    def logs_snapshot(self, limit=200):
        with self.lock:
            return list(self.logs)[-limit:]

    # ------------------------------------------------------------------ 用户
    def _fresh_user(self):
        """从数据库读一份最新的用户行（token/设置可能刚被改过）。"""
        from .models import User
        with db_session() as s:
            return s.get(User, self.user_id)

    def settings(self):
        u = self._fresh_user()
        return u.st() if u else {}

    def session(self, proxy_url=None, token=None):
        """按用户当前 token 造一个 DewuSession（带上这个用户的代理）。

        ``proxy_url`` 给了就**只用这一个出口**（不给就按原来的代理池逻辑选）——
        抢兑前的懒登录要「同一个 IP 登录 + 兑换」，走的正是这条。
        """
        u = self._fresh_user()
        if not u or not (token or u.token):
            return None
        s = self.settings()
        from .db import global_cfg
        act = u.activity or global_cfg().get("dewu_activity")
        pc = dict(s.get("proxy") or {})
        if proxy_url:
            # 现提现用的短效 IP：列表也走它，整个流程从头到尾一个出口
            px = PX.provider_from_rows([{"id": 0, "url": proxy_url}], mode="sticky")
            also = True
        else:
            px = self.proxy_provider()
            also = bool(pc.get("also_list"))
        return DewuSession(token or u.token, activity=act, device=u.device or {},
                           sign=global_cfg().get("dewu_sign"),
                           proxy=px, also_list=also)

    # ------------------------------------------------------------------ 登录
    def creds(self):
        """这个用户的登录凭据 ``(phone, 明文密码, token)``。密码解不开就是空串。"""
        from .secret_store import decrypt
        u = self._fresh_user()
        if not u:
            return "", "", ""
        return u.phone, decrypt(u.pw_enc), (u.token or "")

    def login_info(self):
        """给界面看的登录状态（账号后面要显示这次登录用的 IP 归属地）。"""
        u = self._fresh_user()
        if not u:
            return {}
        from .secret_store import decrypt
        return {
            "has_password": bool(decrypt(u.pw_enc)),
            "logged_in": bool(u.token),
            "ip": u.login_ip or "",
            "where": u.login_where or "",
            "at": u.login_at.strftime("%m-%d %H:%M:%S") if u.login_at else "",
        }

    def do_login(self, use_ip=False, life=None, why=""):
        # 同账号的同期任务共享一次提取与登录，避免重复购买并覆盖 token。
        with self.login_lock:
            lease = self.login_lease
            if use_ip and lease and lease.get("expire_at", 0) - time.time() > 130 and self.creds()[2] == lease.get("token"):
                return True, "复用本轮登录和代理", dict(lease)
            result = self._do_login(use_ip=use_ip, life=life, why=why)
            if result[0] and result[2].get("via_ip"):
                self.login_lease = dict(result[2], token=self.creds()[2])
            return result

    def _do_login(self, use_ip=False, life=None, why=""):
        """登录一次并把结果落库。返回 ``(ok, msg, info)``。

        ``use_ip=True``  → 先提一个短效 IP，用**同一个出口**登录（开抢前 2 分钟走这条）
        ``use_ip=False`` → 直连登录（用户手动点「答题 / 链路诊断」时走这条，快）
        """
        from . import dewu_client as DW
        from . import tianqi as TQ
        from .models import User

        phone, pw, _tok = self.creds()
        if not pw:
            return False, "没有可用的账号密码，请重新提交一次得物账号密码", {}
        tag = ("[任务%s]" % why) if why else "[登录]"

        info = {"ip": "", "where": "", "via_ip": False, "proxy_url": ""}
        proxies = None
        if use_ip:
            if not TQ.ready():
                return False, "管理员尚未启用并配置天启代理，本轮停止", info
            d, err = TQ.one_proxy(life=life or TQ.DEFAULT_LIFE)
            if d:
                proxies = TQ.proxies_map(d["url"])
                info.update({"ip": d.get("ip") or "", "where": d.get("where") or "",
                             "via_ip": True, "proxy_url": d.get("url") or "",
                             "expire_at": d.get("expire_at") or (time.time() + 180)})
                self.log("%s 已提短效 IP %s（%s），用它登录"
                         % (tag, d.get("ip"), info["where"] or "未知"))
            else:
                self.log("%s 提 IP 失败，停止本轮：%s" % (tag, err), "error")
                return False, "提 IP 失败：%s" % err, info

        r = DW.login(phone, pw, proxies=proxies)
        if not r.get("ok"):
            msg = redact_message(r.get("msg") or "登录失败")
            self.log("%s 登录失败：%s" % (tag, msg), "error")
            return False, msg, info

        with db_session() as s:
            u = s.get(User, self.user_id)
            if u:
                u.token = r.get("token") or ""
                u.login_ip = info["ip"]
                u.login_where = info["where"]
                u.login_at = datetime.datetime.now()
        info["token"] = r.get("token") or ""
        self.log("%s 登录成功%s" % (tag, "（出口 %s）" % info["where"]
                                   if info["via_ip"] else "（直连）"), "ok")
        return True, "登录成功", info

    def ensure_login(self, use_ip=False):
        """要 token 的功能（答题 / 诊断 / 库存监听）在没登录时按需登一次。

        有 token 就直接复用；没有才真登录 —— 用户手动点按钮时走这条，
        所以默认 ``use_ip=False``（直连最快）。
        """
        u = self._fresh_user()
        if u and u.token:
            return True, "已有登录态"
        ok, msg, _info = self.do_login(use_ip=use_ip)
        return ok, msg

    # ------------------------------------------------------------------ 代理
    def proxy_rows(self):
        """这个用户能用的代理：先看有没有专门绑给他的，没有就退回公共池。"""
        from .models import Proxy
        with db_session() as s:
            mine = list(s.scalars(select(Proxy).where(
                Proxy.bound_user_id == self.user_id, Proxy.enabled.is_(True))))
            if mine:
                return [{"id": p.id, "url": p.url} for p in mine]
            shared = list(s.scalars(select(Proxy).where(
                Proxy.enabled.is_(True), Proxy.bound_user_id.is_(None))))
        return [{"id": p.id, "url": p.url} for p in shared]

    def proxy_provider(self):
        """造一个本轮抢兑用的代理选择器（没开或没配就返回 None）。"""
        from .db import global_cfg
        g = global_cfg()
        if not g.get("proxy_enabled"):        # 管理员总开关
            return None
        pc = dict((self.settings().get("proxy") or {}))
        if not pc.get("enabled") and not g.get("proxy_required"):
            return None
        rows = self.proxy_rows()
        if not rows:
            return None
        return PX.provider_from_rows(
            rows, mode=pc.get("mode") or "sticky",
            rotate_n=pc.get("rotate_n") or 0, user_id=self.user_id)

    def proxy_info(self):
        """给界面看的代理状态。"""
        from .db import global_cfg
        from .models import Proxy
        g = global_cfg()
        pc = dict((self.settings().get("proxy") or {}))
        with db_session() as s:
            mine = s.scalars(select(Proxy).where(
                Proxy.bound_user_id == self.user_id)).first()
            total = s.scalar(select(func.count(Proxy.id))) or 0
            alive = s.scalar(select(func.count(Proxy.id)).where(
                Proxy.enabled.is_(True))) or 0
            good = s.scalar(select(func.count(Proxy.id)).where(
                Proxy.enabled.is_(True), Proxy.status == "ok")) or 0
        out = dict(pc)
        out.update({
            "assigned": bool(mine),
            "assigned_id": mine.id if mine else None,
            "assigned_label": (mine.label or "") if mine else "",
            "current": PX.mask(mine.url) if mine else "",
            "exit_ip": (mine.exit_ip or "") if mine else "",
            "latency_ms": (mine.latency_ms or 0) if mine else 0,
            "pool_total": total,
            "pool_alive": alive,
            "pool_ok": good,
            "master": bool(g.get("proxy_enabled")),
            "required": bool(g.get("proxy_required")),
            # 「真的会走代理吗」——界面就靠这个给结论
            "ready": bool(g.get("proxy_enabled")
                          and (pc.get("enabled") or g.get("proxy_required"))
                          and (mine or alive)),
        })
        return out

    def proxy_note_result(self, url, ok, err=""):
        """把一次抢兑的成败记到这个代理头上（哪个 IP 好使一目了然）。"""
        if not url:
            return
        from .models import Proxy
        with db_session() as s:
            p = s.scalars(select(Proxy).where(Proxy.url == url)).first()
            if p is None:
                return
            if ok:
                p.ok_count = int(p.ok_count or 0) + 1
                p.fail_streak = 0
                p.status = "ok"
                p.last_ok_at = datetime.datetime.now()
                p.last_error = ""
            else:
                p.fail_count = int(p.fail_count or 0) + 1
                p.fail_streak = int(p.fail_streak or 0) + 1
                if err:
                    p.last_error = str(err)[:300]
                if p.fail_streak >= 3 and p.status != "ok":
                    p.status = "bad"

    def _log_proxy_result(self, res):
        """抢兑收尾时把代理结果写库 + 写日志。"""
        used = res.get("proxy_used")
        if not used:
            return
        errs = int(res.get("proxy_errors") or 0)
        switched = res.get("proxy_switched") or []
        self.proxy_note_result(used, bool(res.get("ok")) and not errs,
                               "代理错误 x%d" % errs if errs else "")
        for u2 in switched:
            if u2 != used:
                self.proxy_note_result(u2, False, "中途被换掉")
        if errs or switched:
            self.log("[代理] 本轮出口 %s%s%s"
                     % (PX.mask(used),
                        "，换过 %d 次：%s" % (len(switched), "、".join(
                            PX.mask(x) for x in switched)) if switched else "",
                        "，代理层报错 %d 次" % errs if errs else ""),
                     "warn" if errs else "info")

    def proxy_rotate(self, prefer_id=None):
        """换一个出口 IP（把绑定改到池子里的下一个）。"""
        from .models import Proxy
        with db_session() as s:
            cur = s.scalars(select(Proxy).where(
                Proxy.bound_user_id == self.user_id)).first()
            cur_url = cur.url if cur else None
            pool = list(s.scalars(select(Proxy).where(
                Proxy.enabled.is_(True),
                or_(Proxy.bound_user_id.is_(None),
                    Proxy.bound_user_id == self.user_id)
            ).order_by(Proxy.latency_ms.asc(), Proxy.id.asc())))
            if prefer_id:
                pool.sort(key=lambda p: 0 if p.id == int(prefer_id) else 1)
            nxt = next((p for p in pool if p.url != cur_url), None)
            if nxt is None:
                return False, "池子里没有别的可用代理了（只有一个，或者都是同一个出口）"
            if cur is not None:
                cur.bound_user_id = None
            nxt.bound_user_id = self.user_id
            show = nxt.exit_ip or PX.hostport(nxt.url)
            lat = nxt.latency_ms or 0
        self.log("[代理] 手动换出口 → %s%s"
                 % (show, "（%dms）" % lat if lat else ""))
        return True, "已换到 %s%s" % (show, "（%d ms）" % lat if lat else "")

    def proxy_test(self, proxy_id=None):
        """探一次这个用户当前的代理。返回 (ok, msg)。"""
        from .models import Proxy
        with db_session() as s:
            row = None
            if proxy_id:
                row = s.get(Proxy, int(proxy_id))
            if row is None:
                row = s.scalars(select(Proxy).where(
                    Proxy.bound_user_id == self.user_id)).first()
            if row is None:
                return False, "这个账号还没分配代理 IP（让管理员导入并分配一个）"
            pid, url, host_show = row.id, row.url, PX.hostport(row.url)
        ok, ip, ms, err = PX.check(url)
        with db_session() as s:
            p = s.get(Proxy, pid)
            if p is not None:
                p.latency_ms = ms
                p.exit_ip = ip or ""
                if ok:
                    p.status = "ok"
                    p.last_ok_at = datetime.datetime.now()
                    p.last_error = ""
                    p.fail_streak = 0
                else:
                    p.status = "bad"
                    p.last_error = str(err or "")[:300]
                    p.fail_streak = int(p.fail_streak or 0) + 1
        if ok:
            msg = "代理可用：%s 出口 IP %s，延迟 %d ms" % (host_show, ip or "未回显", ms)
            self.log("[代理] %s" % msg, "ok")
            return True, msg
        msg = "代理不通：%s → %s" % (host_show, err)
        self.log("[代理] %s" % msg, "error")
        return False, msg

    # ------------------------------------------------------------------ 列表
    def refresh(self):
        """刷新商品列表。返回 (ok, msg)。"""
        sess = self.session()
        if self.creds()[1]:
            return False, "请让管理员配置公共商品账号；浏览商品不会登录你的得物账号"
        if sess is None:
            # 抓包 token 模式使用自己的登录态。
            ok, msg = self.ensure_login()
            if not ok:
                return False, msg
            sess = self.session()
            if sess is None:
                return False, "还没有登录态，请重新提交账号密码"
        ok, data = sess.fetch_list()
        if not ok:
            err = data.get("_err") or ("code=%s %s" % (data.get("code"), data.get("msg")))
            with self.lock:
                self.list_error = err
            self.log("拉取商品列表失败：%s" % err, "error")
            self._persist_sync()
            return False, err
        with self.lock:
            self.products = data["prizes"]
            self.balance = data["balance"]
            self.list_error = None
            self.refreshed_at = _now_str()
        self.log("列表刷新成功：%d 个商品，余额 %s" % (len(data["prizes"]), data["balance"]))
        self._persist_sync()
        return True, "已更新 %d 个商品" % len(data["prizes"])

    def _persist_sync(self):
        from .models import User
        with db_session() as s:
            u = s.get(User, self.user_id)
            if u:
                u.last_sync_at = datetime.datetime.now()

    # ------------------------------------------------------------------ 快照
    def snapshot(self):
        with self.lock:
            return {
                "balance": self.balance,
                "products": list(self.products),
                "list_error": self.list_error,
                "refreshed_at": self.refreshed_at,
                "watch": dict(self.watch_info()),
                "running_tasks": [tid for tid, t in self.task_threads.items()
                                  if t and t.is_alive()],
            }

    # ================================================================== 库存监听
    def watch_info(self):
        u = self._fresh_user()
        st = (u.st() if u else {}) or {}
        w = dict(st.get("watch") or {})
        ws = (u.watch_state or {}) if u else {}
        w.update({
            "running": bool(self.watch_thread and self.watch_thread.is_alive()),
            "tracked": len((ws.get("seen") or {})),
            "baseline": bool(ws.get("baseline")),
            "checked_at": ws.get("checked_at"),
            "notified": ws.get("notified", 0),
            "errors": ws.get("errors", 0),
            "last_error": ws.get("last_error"),
        })
        return w

    def watch_start(self, interval_sec=None):
        u = self._fresh_user()
        if not u:
            return False, "用户不存在"
        st = u.st()
        w = st["watch"]
        if interval_sec:
            w["interval_sec"] = max(5, min(3600, int(interval_sec)))
        w["enabled"] = True
        self._save_settings(st)
        if self.watch_thread and self.watch_thread.is_alive():
            return True, "监听已在运行"
        self.watch_stop.clear()
        self.watch_thread = threading.Thread(target=self._watch_loop, daemon=True,
                                             name="watch-%d" % self.user_id)
        self.watch_thread.start()
        self.log("[库存监听] 已开启（间隔 %d 秒）" % w["interval_sec"])
        return True, "已开启"

    def watch_stop_now(self):
        st = self.settings() or {}
        if st.get("watch"):
            st["watch"]["enabled"] = False
            self._save_settings(st)
        self.watch_stop.set()
        self.log("[库存监听] 已关闭")
        return True, "已关闭"

    def _watch_loop(self):
        self.log("[库存监听] 线程启动")
        while not self.watch_stop.is_set():
            try:
                self._watch_tick()
            except Exception as e:
                self.log("[库存监听] 本轮异常：%r" % (e,), "error")
            try:
                iv = int((self.settings().get("watch") or {}).get("interval_sec") or 30)
            except Exception:
                iv = 30
            self.watch_stop.wait(max(5, min(3600, iv)))
        self.log("[库存监听] 线程已退出")

    def _watch_tick(self):
        sess = self.session()
        if sess is None:
            # 懒登录模式下还没登录过 → 监听没法跑。别在这里自动登录：
            # 监听间隔可能只有 30 秒，每轮登一次会把登录接口打到风控。
            self.log("[库存监听] 还没有登录态，跳过这一轮（抢兑前 %d 秒会自动登录）"
                     % LEAD_LOGIN_SEC, "warn")
            return
        ok, data = sess.fetch_list()
        u = self._fresh_user()
        ws = dict((u.watch_state or {}) if u else {})
        st = self.settings()
        w = st.get("watch") or {}
        if not ok:
            ws["last_error"] = data.get("_err") or "code=%s" % data.get("code")
            ws["errors"] = int(ws.get("errors") or 0) + 1
            ws["checked_at"] = _now_str()
            self._save_watch_state(ws)
            self.log("[库存监听] 检查失败：%s" % ws["last_error"], "error")
            return
        with self.lock:
            self.products = data["prizes"]
            self.balance = data["balance"]
            self.list_error = None
            self.refreshed_at = _now_str()

        changes, seen, baseline = diff_stock(
            ws.get("seen") or {}, data["prizes"],
            notify_new=bool(w.get("notify_new", True)),
            notify_restock=bool(w.get("notify_restock", True)))
        ws["seen"] = seen
        ws["baseline"] = baseline
        ws["checked_at"] = _now_str()
        ws["last_error"] = None
        if not baseline and changes:
            ws["notified"] = int(ws.get("notified") or 0) + 1
            names = "、".join((c.get("cName") or "")[:18] for c in changes[:3])
            self.log("[库存监听] 发现 %d 个变化：%s%s"
                     % (len(changes), names, "…" if len(changes) > 3 else ""), "ok")
            self.push_stock(changes)
        elif baseline:
            self.log("[库存监听] 已建立基线快照（%d 个商品），之后的变化才会通知" % len(seen))
        self._save_watch_state(ws)

    def _save_watch_state(self, ws):
        from .models import User
        with db_session() as s:
            u = s.get(User, self.user_id)
            if u:
                u.watch_state = ws

    # ================================================================== 推送
    def _send_async(self, title, html, topic=None, tag=""):
        token = (self.settings().get("push") or {}).get("token")
        """自己起线程发，不走 dewu_push.send_async（那个会 import dewu_sniper 触发单例）。"""
        def _run():
            try:
                ok, msg = PUSH.send(title, html, token=token, topic=topic)
                self.log("[推送] %s%s · %s · %s"
                         % ("✓ " if ok else "✗ ", msg, tag or "-", title),
                         "ok" if ok else "error")
            except Exception as e:
                self.log("[推送] 异常：%r" % (e,), "error")
        threading.Thread(target=_run, daemon=True, name="push-%d" % self.user_id).start()

    def push_ready(self):
        p = (self.settings().get("push") or {})
        return bool(p.get("enabled") and p.get("token"))

    def push_task(self, kind, prize, cost, balance, task_id, attempts=None, note=""):
        """抢兑结果推送（kind: success / fail）。永不群发 —— 卡片里有账号信息。"""
        p = (self.settings().get("push") or {})
        if not p.get("enabled") or not p.get("token"):
            return
        if kind == "fail" and not p.get("on_fail"):
            return
        u = self._fresh_user()
        card = PUSH.build_card(kind, u.remark or u.phone if u else "", prize, cost,
                               balance, _now_str(), task_id=task_id,
                               attempts=attempts, note=note)
        head = "🎉 抢兑成功" if kind == "success" else "⚠️ 抢兑失败"
        self._send_async("%s | %s" % (head, (prize or "")[:40]), card, tag="私发")

    def push_stock(self, items):
        """库存变化推送：群里「也」推一份（用户要的），抢兑结果不走这里。"""
        p = (self.settings().get("push") or {})
        if not p.get("enabled") or not p.get("token"):
            return
        items = [{"cName": i.get("cName"), "cost": i.get("cost"),
                  "stock": i.get("stock"), "kind": i.get("kind")} for i in items]
        kinds = set(i.get("kind") for i in items)
        head = ("🔔 有货了" if kinds == {"restock"} else
                "🆕 新品上架" if kinds == {"new"} else "🔔 库存变化")
        names = [i.get("cName") or "商品" for i in items]
        title = ("%s | %s" % (head, names[0][:40]) if len(names) == 1
                 else "%s | %d 件（%s 等）" % (head, len(items), names[0][:24]))
        u = self._fresh_user()
        card = PUSH.build_stock_card(items, (u.remark or u.phone) if u else "",
                                     _now_str(), interval_sec=(self.settings().get("watch") or {}).get("interval_sec"))

        # 私发一份 + （配了群组且勾了）群发一份
        topic = (PUSH.clean_topic(p.get("topic")) if p.get("topic") else "")
        if topic and p.get("group_stock", True):
            self._send_async(title, card, topic=topic, tag="群发「%s」" % topic)
        if not topic or p.get("group_self_too", True):
            self._send_async(title, card, tag="私发")

    # ================================================================== 任务
    def schedule(self, task_id, run_now=False):
        """把任务挂到一个线程上跑（重复调用不会重复起线程）。"""
        with self.lock:
            t = self.task_threads.get(task_id)
            if t and t.is_alive():
                return False, "这个任务已经在跑了"
            ev = threading.Event()
            self.task_stop[task_id] = ev
            th = threading.Thread(target=self._task_worker, args=(task_id, ev, run_now),
                                  daemon=True, name="task-%d-%d" % (self.user_id, task_id))
            self.task_threads[task_id] = th
            th.start()
        return True, "已开始"

    def stop_task(self, task_id):
        ev = self.task_stop.get(task_id)
        if ev:
            ev.set()
            return True, "已请求停止"
        return False, "这个任务没在跑"

    def _task_worker(self, task_id, stop_ev, run_now):
        from .models import Task
        try:
            while True:
                with db_session() as s:
                    task = s.get(Task, task_id)
                    if task is None or task.status in (ST_DELETED, ST_CANCEL):
                        return
                    if task.status in (ST_OK, ST_FAIL) and not task.repeat_daily:
                        return
                    # 只允许「活着的」状态被写回等待。已删除/已取消是终态，
                    # 后台线程不许覆盖它们 —— 否则用户刚删掉的任务会从列表里冒出来。
                    if task.status not in (ST_WAIT, ST_RUN, ST_OK, ST_FAIL):
                        return
                    tstr = task.target_time
                    lead = int(task.lead_ms or 0)
                    repeat = bool(task.repeat_daily)
                    tname = (task.prize or {}).get("cName")
                    task.status = ST_WAIT
                    task.updated_at = datetime.datetime.now()
                    s.commit()

                if run_now:
                    target = datetime.datetime.now()
                    fire_at = target
                    run_now = False
                    self.log("[任务#%d] 手动立即执行：%s" % (task_id, tname))
                else:
                    target = _next_target(tstr)
                    fire_at = target - datetime.timedelta(milliseconds=lead)
                    self.log("[任务#%d] 已排定：%s 开抢「%s」（提前 %d ms）"
                             % (task_id, target.strftime("%m-%d %H:%M:%S"), tname, lead))

                # ---- ① 先等到「登录点」：开抢前 2 分钟 ----
                # 懒登录模式（用户存了密码、后台还没登录）才需要在开抢前先登一次。
                # curl 登录那种已经有现成 token，直接略过这一段。
                need_lazy = bool(self.creds()[1])
                login_at = (target - datetime.timedelta(seconds=LEAD_LOGIN_SEC)
                            if need_lazy else fire_at)
                if need_lazy and login_at > datetime.datetime.now():
                    self.log("[任务#%d] %s 自动登录（提前 %d 秒提一个短效 IP）"
                             % (task_id, login_at.strftime("%H:%M:%S"), LEAD_LOGIN_SEC))
                while True:
                    if stop_ev.is_set():
                        self._finish(task_id, ST_CANCEL, "已手动停止")
                        self.log("[任务#%d] 已手动停止" % task_id, "warn")
                        return
                    left = (login_at - datetime.datetime.now()).total_seconds()
                    if left <= 0:
                        break
                    stop_ev.wait(min(left, 1.0))

                # ---- ② 懒登录：提 IP + 登录（一个号一个 IP）----
                proxy_url = None
                info = {}
                if need_lazy:
                    from . import tianqi as TQ
                    ok, _msg, info = self.do_login(use_ip=True, life=3, why="#%d" % task_id)
                    proxy_url = info.get("proxy_url") or None
                    if not ok:
                        self._finish(task_id, ST_FAIL, _msg)
                        self.push_task("fail", tname, None, None, task_id, 0, _msg)
                        if self._next_round(task_id, repeat, target, stop_ev):
                            continue
                        return

                # 列表校正在等待阶段完成，不占整点窗口。
                prepared_session = self.session(proxy_url=proxy_url, token=info.get("token"))
                if prepared_session is None:
                    self._finish(task_id, ST_FAIL, "没有有效登录态")
                    if self._next_round(task_id, repeat, target, stop_ev):
                        continue
                    return
                prepared_list = prepared_session.fetch_list()

                # ---- ③ 再等到开抢点 ----
                while True:
                    if stop_ev.is_set():
                        self._finish(task_id, ST_CANCEL, "已手动停止")
                        self.log("[任务#%d] 已手动停止" % task_id, "warn")
                        return
                    left = (fire_at - datetime.datetime.now()).total_seconds()
                    if left <= 0:
                        break
                    stop_ev.wait(min(left, 1.0))

                # ---- 开抢 ----
                deadline = info.get("expire_at")
                if deadline and deadline - time.time() <= 10:
                    self._finish(task_id, ST_FAIL, "代理已过期或剩余不足 10 秒，本轮停止")
                    self.push_task("fail", tname, None, None, task_id, 0, "代理有效期不足")
                    if self._next_round(task_id, repeat, target, stop_ev):
                        continue
                    return
                sess = prepared_session
                if sess is None:
                    self._finish(task_id, ST_FAIL, "登录态丢失，请重新提交账号密码")
                    return
                with db_session() as s:
                    task = s.get(Task, task_id)
                    if task is None or task.status == ST_DELETED:
                        return          # 用户在这次抢兑期间把它删了 → 结果不落库
                    task.status = ST_RUN
                    task.last_run_at = datetime.datetime.now()
                    task.attempts = 0
                    task.detail = "正在开抢…"
                    prize = dict(task.prize or {})
                    fb_on = bool(task.fallback_enabled)
                    cfg = {"interval_ms": task.interval_ms, "max_attempts": task.max_attempts,
                           "max_duration_sec": 50,
                           "prepared_list": prepared_list,
                           "deadline": min(time.time() + 50, deadline - 8) if deadline else time.time() + 50,
                           "fallback": dict((self.settings().get("fallback") or {}))}
                    cfg["fallback"]["enabled"] = fb_on
                    s.commit()

                t0 = time.time()
                res = sess.run_task(prize, cfg, on_event=self._task_logger(task_id),
                                    should_stop=stop_ev.is_set)
                cost = (res["prize"] or {}).get("cost")
                self.log("[任务#%d] %s（用时 %.1fs，%d 次）"
                         % (task_id, res["detail"], time.time() - t0, res["attempts"]),
                         "ok" if res["ok"] else "warn")
                self._log_proxy_result(res)

                # 抢到的商品可能被降级换过 → 落库
                with db_session() as s:
                    task = s.get(Task, task_id)
                    if task is None or task.status == ST_DELETED:
                        return          # 同上：删了就别写回来了
                    old_name = (task.prize or {}).get("cName")
                    task.prize = res["prize"]
                    task.status = ST_OK if res["ok"] else ST_FAIL
                    task.attempts = res["attempts"]
                    task.detail = res["detail"]
                    task.finished_at = datetime.datetime.now()
                    task.updated_at = datetime.datetime.now()
                    fb_note = ""
                    if res["fell_back"]:
                        task.detail = "%s（原商品「%s」已失效/抢不到，自动降级抢到的）" % (
                            res["detail"], (task.orig_prize or {}).get("cName") or old_name)
                        fb_note = ("⚠ 原配置的「%s」已失效或抢不到，本单是【自动降级】后换商品抢到的。"
                                   "不想要就去任务列表关掉「自动降级」。"
                                   % ((task.orig_prize or {}).get("cName") or old_name))
                    new_name = (task.prize or {}).get("cName")
                    s.commit()

                self.push_task("success" if res["ok"] else "fail", new_name, cost,
                               res.get("balance"), task_id, res["attempts"], fb_note)

                if stop_ev.is_set():
                    self._finish(task_id, ST_CANCEL, "已手动停止")
                    return
                if not self._next_round(task_id, repeat, target, stop_ev):
                    return
                self.log("[任务#%d] 每日重复已开，等下一个 %s" % (task_id, tstr))
        except Exception:
            self.log("[任务#%d] 线程异常：\n%s" % (task_id, traceback.format_exc()), "error")
            self._finish(task_id, ST_FAIL, "内部异常，详见日志")
        finally:
            with self.lock:
                self.task_threads.pop(task_id, None)
                self.task_stop.pop(task_id, None)

    def _next_round(self, task_id, repeat, target, stop_ev):
        if not repeat:
            return False
        # 越过本次整点后才允许进入下一轮，包括提前成功或准备失败。
        while datetime.datetime.now() <= target:
            if stop_ev.wait(min(1.0, max(0.01, (target - datetime.datetime.now()).total_seconds()))):
                self._finish(task_id, ST_CANCEL, "已手动停止")
                return False
        if stop_ev.is_set():
            self._finish(task_id, ST_CANCEL, "已手动停止")
            return False
        return True

    def _task_logger(self, task_id):
        def cb(level, msg):
            self.log("[任务#%d] %s" % (task_id, msg), level)
        return cb

    def _finish(self, task_id, status, detail):
        """落终态。

        已经「已删除」的任务不再改动 —— 删任务是「stop_task() 先置停止位、再写已删除」，
        线程被叫醒后会走到这里的「已手动停止」分支；如果这里不设防，它就会把
        用户刚删掉的任务又写回「已取消」，任务列表里当场冒出一张卡。
        """
        from .models import Task
        with db_session() as s:
            t = s.get(Task, task_id)
            if t is None or t.status == ST_DELETED:
                return
            t.status = status
            t.detail = detail
            t.finished_at = datetime.datetime.now()

    # ------------------------------------------------------------------ 设置
    def _save_settings(self, st):
        from .models import User
        with db_session() as s:
            u = s.get(User, self.user_id)
            if u:
                u.settings = st


# ====================================================================== 注册表
_RUNTIMES = {}
_RT_LOCK = threading.Lock()


def runtime_for(user_id):
    with _RT_LOCK:
        rt = _RUNTIMES.get(user_id)
        if rt is None:
            rt = UserRuntime(user_id)
            _RUNTIMES[user_id] = rt
        return rt


def all_runtimes():
    with _RT_LOCK:
        return dict(_RUNTIMES)


def boot_all():
    """进程启动时恢复：每日重复的未完成任务。

    ★ 库存监听**不在用户侧恢复**：监听统一由服务端用后台配置的「公共账号」拉商品
      （见 global_list），客户账号只在开抢前 LEAD_LOGIN_SEC 秒被用到。
      历史用户设置里残留的 watch.enabled 一律不再启动 —— 否则等于拿客户账号去轮询商品。
    """
    from sqlalchemy import select

    from .models import Task, User
    with db_session() as s:
        users = list(s.scalars(select(User)))
        tasks = list(s.scalars(select(Task)))
    for t in tasks:
        if t.status in (ST_WAIT, ST_RUN) or (t.repeat_daily and t.status in (ST_OK, ST_FAIL)):
            rt = runtime_for(t.user_id)
            rt.schedule(t.id)
    return {"users": len(users), "tasks": len(tasks)}
