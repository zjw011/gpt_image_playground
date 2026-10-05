# -*- coding: utf-8 -*-
"""全局商品列表 —— 由**公共账号**拉一次，所有用户共享同一份。

为什么要有它
------------
原先每个用户都用自己的 token 去拉商品列表，所以「用户必须先登录」。但新流程是：

    · 用户提交账号密码后**后台不登录**；
    · 只有在**抢兑前 2 分钟**才提一个短效 IP、用**那个 IP** 登录拿 token、然后兑换。

那商品列表谁拉？答案是管理员在后台配一个**自己的号**（公共账号），
由它统一拉取、缓存在内存 + 落库，所有用户读同一份 —— 用户端不登录也能看商品。

★ 公共账号走**直连**，不占代理/IP 额度：它只是拉公开的商品数据，
  不需要独立出口 IP，也不需要跟谁的登录态保持一致。
"""
import datetime
import threading
import time

__all__ = ["GlobalList", "GLOBAL", "snapshot", "refresh", "ensure_fresh",
           "save_cfg", "cfg", "configured", "start", "stop", "test_login"]

KEY = "public_account"          # Setting 表里的 key
MIN_INTERVAL = 20               # 后台刷新最快 20 秒一次，别把接口拉崩
DEFAULT_INTERVAL = 60


def cfg():
    """读公共账号配置（密码不往外给的地方会打码，见 :func:`public_view`）。"""
    from .db import get_setting
    v = get_setting(KEY) or {}
    if not isinstance(v, dict):
        v = {}
    out = {
        "phone": str(v.get("phone") or "").strip(),
        "password": str(v.get("password") or ""),
        "enabled": bool(v.get("enabled")),
        "interval_sec": max(MIN_INTERVAL, int(v.get("interval_sec") or DEFAULT_INTERVAL)),
        "token": str(v.get("token") or ""),
        "remark": str(v.get("remark") or ""),
        "last_ok_at": v.get("last_ok_at") or "",
        "last_error": v.get("last_error") or "",
    }
    return out


def save_cfg(**kw):
    """保存公共账号配置。只更新传进来的键，其余保持原样。"""
    from .db import get_setting, put_setting
    cur = cfg()
    for k in ("phone", "password", "remark", "token", "last_ok_at", "last_error"):
        if k in kw and kw[k] is not None:
            cur[k] = str(kw[k])
    if "enabled" in kw and kw["enabled"] is not None:
        cur["enabled"] = bool(kw["enabled"])
    if "interval_sec" in kw and kw["interval_sec"]:
        try:
            cur["interval_sec"] = max(MIN_INTERVAL, int(kw["interval_sec"]))
        except (TypeError, ValueError):
            pass
    put_setting(KEY, cur)
    return cur


def configured():
    """配没配好。有 token 也算（密码可以后补）。"""
    c = cfg()
    return bool(c["phone"] and (c["password"] or c["token"]))


def public_view():
    """给界面看的配置（**密码打码**，绝不回明文）。"""
    c = cfg()
    pw = c["password"]
    return {
        "phone": c["phone"],
        "has_password": bool(pw),
        "password_mask": (pw[0] + "*" * max(0, len(pw) - 1)) if pw else "",
        "enabled": c["enabled"],
        "interval_sec": c["interval_sec"],
        "remark": c["remark"],
        "has_token": bool(c["token"]),
        "configured": bool(c["phone"] and (pw or c["token"])),
    }


# ====================================================================== 单例
class GlobalList:
    """公共账号 + 它拉到的商品列表。进程内单例。"""

    def __init__(self):
        self.lock = threading.RLock()
        self.products = []
        self.balance = None
        self.at = ""                  # 最近一次成功刷新的时间
        self.err = ""                 # 最近一次失败的原因
        self.logs = []                # 最近几条动作，给界面看
        self._thread = None
        self._stop = threading.Event()
        self._fetch_lock = threading.Lock()      # 同一时刻只允许一个人在拉
        self.last_attempt = 0.0

    # ---------------------------------------------------------------- 状态
    def log(self, msg):
        line = "%s  %s" % (datetime.datetime.now().strftime("%H:%M:%S"), msg)
        with self.lock:
            self.logs.append(line)
            del self.logs[:-60]

    def snapshot(self):
        c = cfg()
        with self.lock:
            return {
                "ok": bool(self.products) and not self.err,
                "count": len(self.products),
                "balance": self.balance,
                "at": self.at,
                "err": self.err,
                "products": list(self.products),
                "running": bool(self._thread and self._thread.is_alive()),
                "logs": list(self.logs)[-20:],
                "config": public_view(),
                "phone": c["phone"],
            }

    # ---------------------------------------------------------------- 登录
    def login(self, force=False):
        """用公共账号登录拿 token。返回 ``(ok, msg)``。

        直连，不走代理 —— 它不需要独立出口 IP。
        """
        from . import dewu_client as DW
        c = cfg()
        if not c["phone"] or not c["password"]:
            return False, "还没填公共账号的手机号和密码"
        if c["token"] and not force:
            return True, "已有登录态"
        r = DW.login(c["phone"], c["password"])
        if not r.get("ok"):
            msg = r.get("msg") or "登录失败"
            save_cfg(last_error=msg)
            self.log("公共账号登录失败：%s" % msg)
            return False, msg
        tok = r.get("token") or ""
        save_cfg(token=tok, last_error="")
        self.log("公共账号登录成功（%s）" % c["phone"])
        return True, "登录成功"

    def session(self):
        from . import dewu_client as DW
        from .db import global_cfg
        c = cfg()
        if not c["token"]:
            return None
        g = global_cfg()
        return DW.DewuSession(c["token"], activity=g.get("dewu_activity"),
                              sign=g.get("dewu_sign"))

    # ---------------------------------------------------------------- 拉列表
    def refresh(self, force_login=False):
        """拉一次商品列表并缓存。返回 ``(ok, msg)``。

        加了锁：多人同时点「刷新」也只真正拉一次，不会把接口打爆。
        """
        if not self._fetch_lock.acquire(blocking=False):
            return False, "正在刷新中，稍等一下"
        try:
            self.last_attempt = time.time()
            ok, msg = self.login(force=force_login)
            if not ok:
                with self.lock:
                    self.err = msg
                return False, msg
            sess = self.session()
            if sess is None:
                return False, "公共账号还没有登录态"
            ok, data = sess.fetch_list()
            if not ok:
                err = (data or {}).get("_err") or ("code=%s %s" % (
                    (data or {}).get("code"), (data or {}).get("msg")))
                with self.lock:
                    self.err = err
                save_cfg(last_error=err)
                self.log("拉取商品列表失败：%s" % err)
                return False, err
            prizes = data.get("prizes") or []
            with self.lock:
                self.products = list(prizes)
                self.balance = data.get("balance")
                self.at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                self.err = ""
            save_cfg(last_ok_at=self.at, last_error="")
            self.log("列表刷新成功：%d 个商品，余额 %s" % (len(prizes), data.get("balance")))
            return True, "已更新 %d 个商品" % len(prizes)
        finally:
            self._fetch_lock.release()

    def ensure_fresh(self, max_age=120, need_count=True):
        """列表太旧（或还没有）就顺手刷一次。返回 ``(ok, msg)``。

        给用户点「刷新商品」用的 —— 不做严格节流，但同一秒内的重复调用会被
        :meth:`refresh` 的锁挡掉。
        """
        with self.lock:
            have = len(self.products)
            at = self.at
        if at and (not need_count or have):
            try:
                t = datetime.datetime.strptime(at, "%Y-%m-%d %H:%M:%S")
                if (datetime.datetime.now() - t).total_seconds() < max_age:
                    return True, "刚刚才更新过"
            except ValueError:
                pass
        return self.refresh()

    # ---------------------------------------------------------------- 后台
    def start(self):
        """起后台定时刷新线程（已起或没配好就不动）。"""
        if not configured():
            return False, "还没配公共账号"
        with self.lock:
            if self._thread and self._thread.is_alive():
                return True, "已经在跑了"
            self._stop.clear()
            t = threading.Thread(target=self._loop, name="global-list", daemon=True)
            self._thread = t
        t.start()
        return True, "已启动"

    def stop(self):
        """停后台刷新。**等线程真的退出去**再返回，否则紧接着 start() 会被
        「已经在跑了」挡掉，看起来像开关失效。"""
        self._stop.set()
        t = self._thread
        if t is not None and t.is_alive() and t is not threading.current_thread():
            t.join(timeout=3.0)
        self._thread = None
        self.log("后台刷新已停止")

    def _loop(self):
        self.log("后台刷新已启动")
        # 先拉一次，让用户端立刻有东西可看
        try:
            self.refresh()
        except Exception as e:      # noqa: BLE001
            self.log("首次刷新异常：%r" % (e,))
        while not self._stop.is_set():
            iv = cfg()["interval_sec"]
            if self._stop.wait(iv):
                break
            try:
                self.refresh()
            except Exception as e:  # noqa: BLE001
                self.log("刷新异常：%r" % (e,))
        self.log("后台刷新线程退出")


GLOBAL = GlobalList()


# ====================================================================== 便捷
def snapshot():
    return GLOBAL.snapshot()


def refresh(force_login=False):
    return GLOBAL.refresh(force_login=force_login)


def ensure_fresh(max_age=120):
    return GLOBAL.ensure_fresh(max_age=max_age)


def start():
    return GLOBAL.start()


def stop():
    return GLOBAL.stop()


def test_login():
    """管理员点「测试」用：强制重新登录 + 拉一次列表。"""
    ok, msg = GLOBAL.login(force=True)
    if not ok:
        return False, msg
    ok, msg = GLOBAL.refresh()
    return ok, msg
