# -*- coding: utf-8 -*-
"""「商品已不在列表里还硬刷 200 多次」的回归测试。

真实 bug(用户 10-02 反馈):
    刷新了商品后, 配置的商品不存在了, 接口一直返回 code=110000003 msg=商品不存在,
    旧逻辑一路刷到 max_attempts(日志里是第 200/220 次)才停, 把当天的机会全耗光。

修法(两条防线):
    ① 开抢前: 用刷新后的列表校正商品 → 已不在列表且查不到同名 → 一次请求都不发, 直接停
    ② 抢的过程中: 连续 2 次命中「永久性错误」→ 立刻收手

跑法: python tools/test_gone.py
"""
import datetime
import os
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dewu_sniper as S  # noqa: E402

ok, bad = [], []


def chk(name, cond, extra=""):
    (ok if cond else bad).append(name)
    print("%s %s%s" % ("[PASS]" if cond else "[FAIL]", name, ("  " + extra) if extra else ""))


def bare_manager():
    """不跑 __init__(避免读真实文件/起真实线程), 手搓一个干净的 Manager。"""
    m = S.Manager.__new__(S.Manager)
    m.lock = threading.RLock()
    m.accounts = [{"id": 1, "name": "测试号", "list_curl": "curl x", "fp": "abcd1234"}]
    m.tasks = []
    m.acct_state = {}
    m.logs = []
    m.last_diag = None
    m.diag_seq = 0
    m.cfg = dict(S.DEFAULT_CONFIG)
    m._next_account_id = 2
    m._next_task_id = 2
    m.log = lambda msg: m.logs.append(str(msg))
    m._push_success = lambda *a, **k: None      # 别真发微信
    m._push_fail = lambda *a, **k: None
    m._activity_for = lambda acc: "20260917"
    m._headers_for = lambda acc: {}
    return m


def prize(cid=111, name="音箱"):
    return {"cId": cid, "pId": 9, "skuId": 8, "cName": name, "cost": 100, "stock": 5}


# ---------------- 1. _is_fatal_gone ----------------
print("== 1. 永久性错误判定 ==")
m = bare_manager()
for msg, want in [("商品不存在", True), ("商品已下架", True), ("活动已结束", True),
                  ("活动不存在", True), ("该活动已失效", True), ("链接已失效", True),
                  ("库存不足", False), ("已售罄", False), ("code=700 请先登录", False),
                  ("", False), (None, False), ("网络异常", False)]:
    chk("「%s」-> %s" % (msg, "永久" if want else "可重试"), m._is_fatal_gone(msg) is want)

# ---------------- 2. _resolve_prize ----------------
print("\n== 2. 开抢前用最新列表校正商品 ==")


class T(dict):
    pass


def task(cid=111, name="音箱"):
    return {"id": 1, "prize": prize(cid, name), "attempts": 0, "status": "等待"}


# ① cId 命中
f, g = m._resolve_prize(task(), {"prizes": [prize(111), prize(222)], "error": None})
chk("cId 命中 -> 用最新那条, 不算失效", f is not None and f["cId"] == 111 and g is False)

# ② cId 变了但商品还在(同名) -> 纠正
m.logs.clear()
f, g = m._resolve_prize(task(111, "音箱"), {"prizes": [prize(999, "音箱")], "error": None})
chk("cId 变了但同名 -> 自动重新匹配, 不算失效",
    f is not None and f["cId"] == 999 and g is False,
    "fresh cId=%s" % (f or {}).get("cId"))
chk("重新匹配有日志", any("按名称重新匹配" in x for x in m.logs))

# ③ 列表刷新成功、商品确实没了 -> gone
f, g = m._resolve_prize(task(111, "音箱"), {"prizes": [prize(222, "耳机")], "error": None})
chk("刷新成功但商品没了 -> gone=True", f is None and g is True)

# ④ 列表刷新失败 -> 不能断定, 仍按原配置抢
f, g = m._resolve_prize(task(111, "音箱"),
                        {"prizes": [prize(222, "耳机")], "error": "code=700 请先登录"})
chk("列表刷新失败 -> 不判 gone(不能误杀)", f is None and g is False)

# ⑤ 列表还没数据 -> 沿用原配置
f, g = m._resolve_prize(task(), {"prizes": [], "error": None})
chk("列表为空 -> 不判 gone", f is None and g is False)

# ---------------- 3. _fire_loop: 永久错误立刻停 ----------------
print("\n== 3. 抢的过程中命中永久错误 ==")


class FakeResp:
    def __init__(self, payload):
        self._p = payload

    def json(self):
        return self._p


class FakeSession:
    """每次都返回「商品不存在」, 并记录被调用了多少次。"""
    calls = 0

    def __init__(self, *a, **k):
        pass

    def post(self, *a, **k):
        FakeSession.calls += 1
        return FakeResp({"code": 110000003, "msg": "商品不存在"})


real_session = S.requests.Session
S.requests.Session = FakeSession
try:
    m = bare_manager()
    tk = {"id": 7, "account_id": 1, "account_name": "测试号", "prize": prize(),
          "status": "兑换中", "attempts": 0, "max_attempts": 600,
          "interval_ms": 5, "repeat_daily": True, "_fatal_n": 0, "_fatal": False}
    FakeSession.calls = 0
    t0 = time.time()
    r = m._fire_loop(tk, m.accounts[0])
    dt = time.time() - t0
    chk("返回 False(未成功)", r is False)
    chk("状态=失败", tk["status"] == "失败", tk["status"])
    chk("标记 _fatal", tk.get("_fatal") is True)
    chk("★ 只试了 %d 次(旧逻辑会刷满 600 次)" % FakeSession.calls,
        FakeSession.calls == S.FATAL_STRIKES, "calls=%d" % FakeSession.calls)
    chk("很快收手(%.2fs, 不是刷满 180s)" % dt, dt < 3)
    chk("日志说明是永久失效", any("判定商品/活动已失效" in x for x in m.logs),
        m.logs[-1] if m.logs else "")

    # 对照: 可重试的错误不该提前停(会一直刷到 max_attempts)
    class RetrySession(FakeSession):
        def post(self, *a, **k):
            FakeSession.calls += 1
            return FakeResp({"code": 12345, "msg": "服务繁忙"})

    S.requests.Session = RetrySession
    m2 = bare_manager()
    tk2 = dict(tk, attempts=0, _fatal_n=0, _fatal=False, status="兑换中", max_attempts=6)
    FakeSession.calls = 0
    r2 = m2._fire_loop(tk2, m2.accounts[0])
    chk("可重试错误仍然刷满 max_attempts(6 次)", r2 is False and FakeSession.calls == 6,
        "calls=%d" % FakeSession.calls)
    chk("可重试错误不标记 _fatal", not tk2.get("_fatal"))
finally:
    S.requests.Session = real_session

# ---------------- 4. _task_worker: 开抢前就发现商品没了 ----------------
print("\n== 4. 到点后发现商品已不在列表 -> 一次都不发 ==")
m = bare_manager()
m._next_target = lambda tstr: datetime.datetime.now() + datetime.timedelta(seconds=1)
fired = {"n": 0}


def fake_fire(task, acc):
    fired["n"] += 1
    return False


m._fire_loop = fake_fire
m.refresh_account = lambda acc_id: m.acct_state.__setitem__(
    acc_id, {"balance": 60, "prizes": [prize(222, "耳机")], "error": None})

tk = {"id": 7, "account_id": 1, "account_name": "测试号", "prize": prize(111, "音箱"),
      "time": "10:00:00", "lead_ms": 0, "interval_ms": 5, "max_attempts": 600,
      "repeat_daily": True, "status": "等待", "detail": "", "attempts": 0}
m.tasks = [tk]
th = threading.Thread(target=m._task_worker, args=(tk,), daemon=True)
th.start()
th.join(timeout=15)
chk("线程已结束(没有卡住)", not th.is_alive())
chk("★ 一次兑换请求都没发", fired["n"] == 0, "fired=%d" % fired["n"])
chk("状态=失败", tk["status"] == "失败", tk["status"])
chk("提示写清了原因", "不在列表中" in (tk.get("detail") or ""), tk.get("detail"))
chk("日志提示去重新选商品", any("重新选择商品" in x for x in m.logs),
    next((x for x in m.logs if "重新选择商品" in x), ""))

# ---------------- 5. stop_on_gone=False 时仍然每日重试 ----------------
print("\n== 5. 关掉 stop_on_gone -> 回到等待, 明天再来 ==")
m = bare_manager()
m.cfg["stop_on_gone"] = False
# 第一次开抢给个"马上就到的点", 之后就推到 6 小时后, 免得线程不停地循环
n_target = {"n": 0}


def nt(tstr, _n=n_target):
    _n["n"] += 1
    if _n["n"] == 1:
        return datetime.datetime.now() + datetime.timedelta(seconds=1)
    return datetime.datetime.now() + datetime.timedelta(hours=6)


m._next_target = nt
m._fire_loop = fake_fire
m.refresh_account = lambda acc_id: m.acct_state.__setitem__(
    acc_id, {"balance": 60, "prizes": [prize(222, "耳机")], "error": None})
fired["n"] = 0
tk = {"id": 8, "account_id": 1, "account_name": "测试号", "prize": prize(111, "音箱"),
      "time": "10:00:00", "lead_ms": 0, "interval_ms": 5, "max_attempts": 600,
      "repeat_daily": True, "status": "等待", "detail": "", "attempts": 0}
m.tasks = [tk]
th = threading.Thread(target=m._task_worker, args=(tk,), daemon=True)
th.start()
t_end = time.time() + 8
while time.time() < t_end and not any("等待明天同一时间再试" in x for x in m.logs):
    time.sleep(0.05)
chk("没有发兑换请求", fired["n"] == 0, "fired=%d" % fired["n"])
chk("状态回到等待(明天再试)", tk["status"] == "等待", tk["status"])
tk["status"] = "已删除"      # 让这条 daemon 线程退出倒计时
time.sleep(0.3)
sys.stdout.flush()

print("\n" + "=" * 48)
print("通过 %d 项, 失败 %d 项" % (len(ok), len(bad)))
for b in bad:
    print("  失败:", b)
sys.exit(1 if bad else 0)
