# -*- coding: utf-8 -*-
"""自动降级兜底的回归测试。

需求(用户 10-02):
    活动快结束时商品会一批批下架, 守着已经没了的商品最亏。
    所以: 配置的商品失效/抢不到时, 自动改抢一个「有货且买得起」的替代品。
    例: 号上 110 币, 配置的商品没了 → 自动换成 108 币的那个;
        有多个 108 的 → 取商品列表顺序第一个。

规则(用户拍板):
    · 三个触发条件独立可勾: 下架就换 / 抢不到也换 (默认开) · 买不起也换 (默认关)
    · 价格不设门槛 (min_ratio = 0)
    · 同价取列表顺序第一个
    · 新任务默认开启
    · ★ 每个任务最多降级一次 —— 否则会一路换到最便宜那个, 变成"清空金币"

跑法: python tools/test_fallback.py
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
    print("%s %s%s" % ("[PASS]" if cond else "[FAIL]", name,
                       ("  " + str(extra)) if extra else ""))


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
    # ★ 深拷一份, 否则改 m.cfg["fallback"] 会污染 DEFAULT_CONFIG, 后面的用例全跟着变
    m.cfg = dict(S.DEFAULT_CONFIG)
    m.cfg["fallback"] = dict(S.DEFAULT_CONFIG["fallback"])
    m._next_account_id = 2
    m._next_task_id = 2
    m.log = lambda msg: m.logs.append(str(msg))
    m._push_success = lambda *a, **k: None      # 默认别真发微信
    m._push_fail = lambda *a, **k: None
    m._task_worker = lambda task: None          # add_task 会起线程, 测试里别真跑
    m._activity_for = lambda acc: "20260917"
    m._headers_for = lambda acc: {}
    return m


def prize(cid, name, cost, stock=5, out=False):
    return {"cId": cid, "pId": 9, "skuId": 8, "cName": name, "cost": cost,
            "stock": stock, "outOfStock": out}


def mk_task(cid=111, name="音箱", cost=120, **over):
    """建一个「原配置是音箱」的任务。"""
    t = {"id": 1, "account_id": 1, "account_name": "测试号",
         "prize": prize(cid, name, cost), "_orig_prize": prize(cid, name, cost),
         "fb": dict(S.DEFAULT_CONFIG["fallback"]),
         "time": "10:00:00", "lead_ms": 0, "interval_ms": 5, "max_attempts": 600,
         "repeat_daily": False, "status": "等待", "detail": "", "attempts": 0}
    t.update(over)
    return t


def fresh(cid=111, cost=120, **fb):
    """一个只等着被降级的任务（fb 可覆盖单项）。"""
    t = mk_task(cid, "音箱", cost)
    t["fb"] = dict(S.DEFAULT_CONFIG["fallback"], **fb)
    t["detail"] = ""
    return t


# ---------------- 1. 全局策略 ----------------
print("== 1. fb_cfg / fb_save_cfg ==")
m = bare_manager()
c = m.fb_cfg()
chk("默认 开关=开", c["enabled"] is True)
chk("默认 下架就换=开", c["on_gone"] is True)
chk("默认 抢不到也换=开", c["on_soldout"] is True)
chk("默认 买不起也换=关（免得不知情就把币花掉）", c["on_poor"] is False)
chk("默认 价格门槛=0（不设门槛）", c["min_ratio"] == 0.0)

m.cfg["fallback"] = {"enabled": False}
c = m.fb_cfg()
chk("config 里只写了 enabled -> 其余键自动补齐", len(c) == 5 and c["on_gone"] is True,
    sorted(c))

for raw, want in [("0.5", 0.5), (0.8, 0.8), (1.5, 1.0), (-3, 0.0), ("abc", 0.0), (None, 0.0)]:
    m.cfg["fallback"] = {"min_ratio": raw}
    chk("min_ratio=%r -> %s（夹到 0~1）" % (raw, want), m.fb_cfg()["min_ratio"] == want)

saved = {}
S.save_json = lambda p, d: saved.update({"p": p, "d": d})
m.cfg["fallback"] = dict(S.DEFAULT_CONFIG["fallback"])
m.fb_save_cfg(on_poor=True, min_ratio=0.5)
chk("fb_save_cfg 写回内存", m.cfg["fallback"]["on_poor"] is True
    and m.cfg["fallback"]["min_ratio"] == 0.5)
chk("fb_save_cfg 落了盘", saved.get("p") == S.CONFIG_PATH)

# ---------------- 2. fb_of: 任务覆盖全局 ----------------
print("\n== 2. fb_of 任务级覆盖 ==")
m = bare_manager()
t = mk_task()
t["fb"] = {"enabled": False}
chk("任务自己关了 -> 全局开着也没用", m.fb_of(t)["enabled"] is False)
t2 = mk_task()
t2["fb"] = {"on_poor": True}
chk("任务只覆盖一项 -> 其余继承全局", m.fb_of(t2)["on_poor"] is True
    and m.fb_of(t2)["on_gone"] is True)
t3 = mk_task()
t3.pop("fb")
chk("老任务没存 fb -> 用全局默认", m.fb_of(t3)["enabled"] is True)

# ---------------- 3. pick_fallback: 挑哪个 ----------------
print("\n== 3. 挑替代品：买得起里最贵 · 同价取列表第一个 ==")
m = bare_manager()
state = {"balance": 110, "error": None, "prizes": [
    prize(901, "贴纸", 10),
    prize(111, "音箱", 120),           # 就是原商品, 要排除
    prize(902, "咖啡券", 108),         # ← 应该挑中这个(第一个 108)
    prize(903, "耳机", 108),           # 同价但排后面, 不选
    prize(904, "手表", 999),           # 买不起
    prize(905, "抱枕", 90, out=True),  # 缺货
]}
p, tip = m.pick_fallback(mk_task(111, "音箱", 120), state)
chk("★ 挑中「买得起里最贵的」= 咖啡券 108", p and p["cId"] == 902, p and p["cName"])
chk("★ 同价取列表顺序第一个（不是耳机）", p and p["cName"] == "咖啡券")
chk("挑中的一定有货", p and not p["outOfStock"])
chk("不会挑中买不起的", p and p["cost"] <= 110)

state2 = {"balance": 110, "error": None, "prizes": [
    prize(901, "贴纸", 10), prize(902, "咖啡券", 50), prize(903, "耳机", 100)]}
p, _ = m.pick_fallback(mk_task(111, "音箱", 120), state2)
chk("价格不同 -> 挑最贵的 耳机 100", p and p["cName"] == "耳机", p and p["cName"])

p, tip = m.pick_fallback(mk_task(), {"balance": 110, "prizes": []})
chk("列表空 -> 挑不出来 + 说明", p is None and "空" in tip, tip)
p, tip = m.pick_fallback(mk_task(), {"balance": None, "prizes": [prize(902, "咖啡券", 50)]})
chk("余额未知 -> 不猜, 挑不出来", p is None and "余额" in tip, tip)
p, tip = m.pick_fallback(mk_task(), {"balance": 5, "prizes": [prize(902, "咖啡券", 50)]})
chk("全都买不起 -> 挑不出来, 说明里有数字", p is None and "买不起 1" in tip, tip)
p, tip = m.pick_fallback(mk_task(), {"balance": 110, "prizes": [prize(111, "音箱", 100)]})
chk("只剩原商品自己 -> 挑不出来（换回它没意义）", p is None, tip)
p, tip = m.pick_fallback(mk_task(), {"balance": 110, "prizes": [prize(901, "贴纸", 10, out=True)]})
chk("有货的都是缺货 -> 挑不出来, 说明带缺货计数", p is None and "缺货 1" in tip, tip)
p, tip = m.pick_fallback(mk_task(), {"balance": 110, "prizes": [
    prize(901, "贴纸", 0), prize(902, "坏数据", None)]})
chk("价格非法 / <=0 的商品直接跳过", p is None, tip)

# ---------------- 4. 价格门槛 ----------------
print("\n== 4. 价格门槛 min_ratio（默认 0 = 不设门槛） ==")
t = fresh(111, 108)
t["fb"] = {"min_ratio": 0.5}
p, tip = m.pick_fallback(t, {"balance": 110, "prizes": [
    prize(901, "贴纸", 20), prize(902, "咖啡券", 108)]})
chk("原价 108 · 门槛 50%(=54) -> 20 币的贴纸被挡掉, 挑 108",
    p and p["cName"] == "咖啡券", p and p["cName"])
p, tip = m.pick_fallback(t, {"balance": 110, "prizes": [prize(901, "贴纸", 20)]})
chk("只剩低于门槛的 -> 挑不出来, 说明带门槛计数",
    p is None and "低于门槛 1" in tip, tip)
p, _ = m.pick_fallback(fresh(111, 108), {"balance": 110, "prizes": [prize(901, "贴纸", 20)]})
chk("★ 门槛=0（用户选的）-> 20 币的也换, 最大程度不空手", p and p["cName"] == "贴纸")

# ---------------- 5. _try_fallback 触发条件 ----------------
print("\n== 5. _try_fallback 触发条件 ==")
m = bare_manager()
acc = m.accounts[0]
m.acct_state[1] = {"balance": 110, "error": None,
                   "prizes": [prize(902, "咖啡券", 108), prize(903, "耳机", 50)]}

chk("总开关关 -> 不降级", m._try_fallback(fresh(enabled=False), acc, True) is False)

t = fresh()
t["_fell_back"] = True
chk("已经降级过 -> 不二次降级", m._try_fallback(t, acc, True) is False)

chk("商品没了 + 没勾「下架就换」-> 不降级",
    m._try_fallback(fresh(on_gone=False), acc, True) is False)

t = fresh()
m.logs.clear()
r = m._try_fallback(t, acc, True)
chk("★ 商品没了 + 勾了「下架就换」-> 降级", r is True)
chk("prize 换成替代品 咖啡券", t["prize"]["cId"] == 902, t["prize"]["cName"])
chk("打上 _fell_back 标记", t.get("_fell_back") is True)
chk("日志写清原商品和替代品",
    any("自动降级换商品" in x and "音箱" in x and "咖啡券" in x for x in m.logs),
    next((x for x in m.logs if "自动降级换商品" in x), ""))

t = fresh()
t["_fatal"] = True
r = m._try_fallback(t, acc, False)
chk("抢的过程中被判永久失效(_fatal) -> 也算「商品没了」，会降级", r is True)
chk("降级时把 _fatal 清掉（换了商品重新算）", t.get("_fatal") is False)
chk("顺带清掉失效计数和风控计数", t.get("_fatal_n") == 0 and t.get("_c700") == 0)

chk("买不起原商品 + 没勾「买不起也换」-> 不降级",
    m._try_fallback(dict(fresh(on_poor=False), detail="余额不足"), acc, False) is False)

t = fresh(on_poor=True)
t["detail"] = "余额不足"
m.logs.clear()
chk("★ 买不起原商品 + 勾了「买不起也换」-> 降级",
    m._try_fallback(t, acc, False) is True)
chk("日志写的是「余额买不起原商品」",
    any("余额买不起原商品" in x for x in m.logs),
    next((x for x in m.logs if "余额买不起原商品" in x), ""))

t = fresh(on_soldout=True)
t["detail"] = "尝试 600 次未成功"
m.logs.clear()
chk("★ 抢不到 + 勾了「抢不到也换」-> 降级", m._try_fallback(t, acc, False) is True)
chk("日志写的是「原商品一直没抢到」",
    any("原商品一直没抢到" in x for x in m.logs),
    next((x for x in m.logs if "原商品一直没抢到" in x), ""))

chk("抢不到 + 没勾「抢不到也换」-> 不降级",
    m._try_fallback(dict(fresh(on_soldout=False), detail="尝试 600 次未成功"),
                    acc, False) is False)

# 挑不出来时要说清为什么, 而且不能偷偷改任务
m.acct_state[1] = {"balance": 3, "error": None, "prizes": [prize(902, "咖啡券", 108)]}
t = fresh()
m.logs.clear()
bef = dict(t["prize"])
chk("挑不出替代品 -> 不降级", m._try_fallback(t, acc, True) is False)
chk("挑不出来时不动 task 的商品", t["prize"] == bef)
chk("也没打 _fell_back（下次还能降级）", not t.get("_fell_back"))
chk("日志写清为什么挑不出来（方便排查）",
    any("本想自动降级，但" in x for x in m.logs),
    next((x for x in m.logs if "本想自动降级" in x), ""))

# ---------------- 6. _task_worker 端到端 ----------------
print("\n== 6. 到点后的完整流程 ==")


def run_worker(m, tk, fired_seq, refresh_prizes, balance=110, nt_fn=None, timeout=15):
    """fired_seq: 每次 _fire_loop 依次返回的 (成功?, detail)。"""
    seq = list(fired_seq)
    calls = []

    def fire(task, acc):
        i = len(calls)
        calls.append(task["prize"]["cName"])
        ok_, detail = seq[i] if i < len(seq) else (False, "尝试 600 次未成功")
        task["detail"] = detail
        task["attempts"] = task.get("attempts", 0) + 5
        return ok_

    m._fire_loop = fire
    m._next_target = nt_fn or (lambda tstr: datetime.datetime.now()
                               + datetime.timedelta(seconds=1))
    m.refresh_account = lambda acc_id: m.acct_state.__setitem__(
        acc_id, {"balance": balance, "prizes": list(refresh_prizes), "error": None})
    m.tasks = [tk]
    # ★ 必须走真方法 —— bare_manager 为了 add_task 把 m._task_worker 打桩成空函数了
    th = threading.Thread(target=S.Manager._task_worker, args=(m, tk), daemon=True)
    th.start()
    th.join(timeout=timeout)
    return calls, th


# ① 商品下架 + 降级开 -> 换商品抢到
m = bare_manager()
tk = mk_task(111, "音箱", 120)
calls, th = run_worker(m, tk, [(True, "")],
                       [prize(902, "咖啡券", 108), prize(903, "耳机", 50)])
chk("线程已结束", not th.is_alive())
chk("★ 商品下架 -> 降级后抢到（只调了 1 次 fire_loop）", len(calls) == 1, calls)
chk("抢的是替代品 咖啡券", calls and calls[0] == "咖啡券", calls)
chk("状态=成功", tk["status"] == "成功", tk["status"])
chk("详情写明已自动降级", "已自动降级" in (tk.get("detail") or ""), tk.get("detail"))
chk("日志有「自动降级换商品」", any("自动降级换商品" in x for x in m.logs),
    next((x for x in m.logs if "自动降级换商品" in x), ""))

# ② 商品下架 + 降级关 -> 一次都不发
m = bare_manager()
tk = mk_task(111, "音箱", 120)
tk["fb"] = dict(S.DEFAULT_CONFIG["fallback"], enabled=False)
calls, th = run_worker(m, tk, [], [prize(902, "咖啡券", 108)])
chk("降级关掉 -> 一次 fire_loop 都不调（老行为不变）", len(calls) == 0, calls)
chk("状态=失败", tk["status"] == "失败", tk["status"])

# ③ 抢不到 -> 降级后再抢一轮
m = bare_manager()
tk = mk_task(111, "音箱", 120)
calls, th = run_worker(m, tk, [(False, "尝试 600 次未成功"), (True, "")],
                       [prize(111, "音箱", 120), prize(902, "咖啡券", 108),
                        prize(903, "耳机", 50)])
chk("★ 抢不到 -> 降级后共调 2 次 fire_loop", len(calls) == 2, calls)
chk("第一次抢原商品", calls and calls[0] == "音箱", calls)
chk("第二次抢替代品", len(calls) > 1 and calls[1] == "咖啡券", calls)
chk("状态=成功", tk["status"] == "成功", tk["status"])
chk("attempts 重置后重新计数（不是累加到 10）", tk["attempts"] == 5, tk["attempts"])

# ④ ★ 只降级一次
m = bare_manager()
tk = mk_task(111, "音箱", 120)
calls, th = run_worker(m, tk, [(False, "尝试 600 次未成功"), (False, "尝试 600 次未成功")],
                       [prize(111, "音箱", 120), prize(902, "咖啡券", 108),
                        prize(903, "耳机", 50), prize(904, "手表", 30)])
chk("★ 只降级一次：一共只调 2 次 fire_loop（没有一路换到 30 币的手表）",
    len(calls) == 2, calls)
chk("第二次之后没有再降级（没有第三次）", len(calls) == 2 and "手表" not in calls, calls)
chk("降级后仍失败 -> 状态=失败", tk["status"] == "失败", tk["status"])
chk("补货机会已经用掉了（失败原因记在详情里）",
    "尝试 600 次未成功" in (tk.get("detail") or ""), tk.get("detail"))

# ⑤ 想降级但买不起任何替代品
m = bare_manager()
tk = mk_task(111, "音箱", 120)
calls, th = run_worker(m, tk, [], [prize(902, "咖啡券", 108)], balance=3)
chk("余额买不起任何替代品 -> 不降级", len(calls) == 0, calls)
chk("状态=失败", tk["status"] == "失败", tk["status"])

# ⑥ 每日重复: 降级后失败 -> 回等待, 且商品恢复成最初配置的那个
m = bare_manager()
tk = mk_task(111, "音箱", 120)
tk["repeat_daily"] = True
n = {"n": 0}


def nt(tstr):
    n["n"] += 1
    if n["n"] == 1:
        return datetime.datetime.now() + datetime.timedelta(seconds=0.8)
    return datetime.datetime.now() + datetime.timedelta(hours=6)


calls, th = run_worker(m, tk, [(False, "尝试 600 次未成功"), (False, "尝试 600 次未成功")],
                       [prize(902, "咖啡券", 108)], nt_fn=nt, timeout=10)
t_end = time.time() + 10
while time.time() < t_end and not any("等待明天同一时间再试" in x for x in m.logs):
    time.sleep(0.05)
time.sleep(2.6)      # 等它 sleep(2) 后回到 while 顶部恢复商品
chk("降级后失败 + 每日重复 -> 回到等待", tk["status"] == "等待", tk["status"])
chk("★ 商品恢复成最初配置的「音箱」（明天抢的还是原商品）",
    tk["prize"]["cName"] == "音箱", tk["prize"]["cName"])
chk("_fell_back 标记已清掉（明天可以再降级一次）", not tk.get("_fell_back"))
tk["status"] = "已删除"      # 放这条 daemon 线程走
time.sleep(0.3)

# ---------------- 7. 推送卡片要说清「花在哪了」 ----------------
print("\n== 7. 微信推送里的降级说明 ==")
m = bare_manager()
sent = {}


class FakePush:
    @staticmethod
    def is_ready():
        return True

    @staticmethod
    def notify_success(**kw):
        sent.clear()
        sent.update(kw)
        return True

    @staticmethod
    def notify_fail(**kw):
        sent.clear()
        sent.update(kw)
        return True


real_push = S.PUSH
S.PUSH = FakePush
try:
    m._balance_after = lambda acc, task: 2
    tk = mk_task(111, "音箱", 120)
    tk["prize"] = prize(902, "咖啡券", 108)
    tk["_fell_back"] = True
    S.Manager._push_success(m, tk, m.accounts[0])
    chk("降级抢到时 note 非空", bool(sent.get("note")))
    chk("note 里写清是【自动降级】", "自动降级" in (sent.get("note") or ""), sent.get("note"))
    chk("note 里带上原配置的商品名", "音箱" in (sent.get("note") or ""))
    chk("卡片商品是替代品", sent.get("prize") == "咖啡券")

    tk2 = mk_task(111, "音箱", 120)
    S.Manager._push_success(m, tk2, m.accounts[0])
    chk("没降级时 note 留空（走卡片默认说明）", sent.get("note") == "",
        repr(sent.get("note")))

    tk3 = mk_task(111, "音箱", 120)
    tk3["prize"] = prize(902, "咖啡券", 108)
    tk3["_fell_back"] = True
    S.Manager._push_fail(m, tk3, m.accounts[0], "尝试 600 次未成功")
    chk("降级后仍失败 -> 失败推送里也说清了",
        "自动降级" in (sent.get("reason") or "") and "音箱" in (sent.get("reason") or ""),
        sent.get("reason"))
finally:
    S.PUSH = real_push

# ---------------- 8. add_task 接线 ----------------
print("\n== 8. add_task 带上降级开关 ==")
m = bare_manager()
S.save_json = lambda p, d: None
m.acct_state[1] = {"balance": 110, "error": None, "prizes": [prize(111, "音箱", 120)]}
r = m.add_task({"account_id": 1, "cId": 111, "time": "10:00:00"})
chk("建任务成功", r.get("ok") is True, r.get("msg"))
chk("★ 默认带上降级（用户选了默认开启）", r["task"]["fb"]["enabled"] is True, r["task"]["fb"])
chk("存了原始配置 _orig_prize", r["task"]["_orig_prize"]["cId"] == 111)
chk("日志里提示已开降级", any("已开自动降级" in x for x in m.logs),
    next((x for x in m.logs if "已开自动降级" in x), ""))

r2 = m.add_task({"account_id": 1, "cId": 111, "time": "10:00:00", "fallback": False})
chk("显式传 fallback=False -> 这个任务关掉", r2["task"]["fb"]["enabled"] is False)
chk("关掉时日志不提示降级", "已开自动降级" not in m.logs[-1], m.logs[-1])

# ---------------- 9. 升级前的老任务 ----------------
print("\n== 9. 升级前的老任务（tasks.json 里没有 fb / _orig_prize） ==")
m = bare_manager()
old = {"id": 3, "account_id": 1, "account_name": "测试号",
       "prize": prize(111, "音箱", 120), "time": "10:00:00", "lead_ms": 0,
       "interval_ms": 5, "max_attempts": 600, "repeat_daily": False,
       "status": "失败", "detail": "", "attempts": 0}
chk("老任务读出来也有 fb（缺字段不会崩）", m.fb_of(old)["enabled"] is True)
chk("老任务 _orig_prize 缺失时 pick_fallback 照样能跑",
    m.pick_fallback(old, {"balance": 110, "prizes": [prize(902, "咖啡券", 108)]})[0]
    is not None)

# ---------------- 10. 预览页 ----------------
print("\n== 10. 推送样式预览 ==")
import dewu_push as PUSH  # noqa: E402

p = PUSH.preview_html(os.path.join(ROOT, "dist", "推送样式预览.html"))
html = open(p, encoding="utf-8").read()
chk("预览页含「自动降级」示例", "自动降级" in html)
chk("预览页标题写的是「底部会写清原配置」", "底部会写清原配置" in html)

print("\n" + "=" * 48)
print("通过 %d 项, 失败 %d 项" % (len(ok), len(bad)))
for b in bad:
    print("  失败:", b)
sys.exit(1 if bad else 0)
