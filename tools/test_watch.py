# -*- coding: utf-8 -*-
"""库存监听（新品上架 / 补货 推微信）的测试。

要点:
  · 第一次只建基线, 不推送(否则一开启就把整个列表推一遍)
  · 缺货的新品不推, 等有货再推
  · 「缺货 -> 有货」才算补货
  · 推送里必须带商品名 + 金币
  · 开关能真的停掉后台线程
测试里把 notify_stock / save_json 都打桩, 不会真的发微信、不会动真实配置文件。

跑法: python tools/test_watch.py
"""
import datetime
import os
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dewu_sniper as S  # noqa: E402
import dewu_push as P    # noqa: E402

ok, bad = [], []


def chk(name, cond, extra=""):
    (ok if cond else bad).append(name)
    print("%s %s%s" % ("[PASS]" if cond else "[FAIL]", name, ("  " + extra) if extra else ""))


# --- 打桩: 不写真实 config.json, 不真发微信 ---
real_save = S.save_json
sent = []
S.save_json = lambda p, o: None
P.notify_stock = lambda items, account=None, interval_sec=None: (
    sent.append({"items": items, "account": account, "interval": interval_sec}) or True)


def prize(cid, name, cost, stock, out=False):
    return {"cId": cid, "pId": 1, "skuId": 2, "cName": name, "cost": cost,
            "stock": stock, "outOfStock": out, "level": "A"}


def manager():
    m = S.Manager.__new__(S.Manager)
    m.lock = threading.RLock()
    m.accounts = [{"id": 1, "name": "监听号", "list_curl": "curl x", "fp": "abcd1234"}]
    m.tasks = []
    m.acct_state = {}
    m.logs = []
    m.cfg = dict(S.DEFAULT_CONFIG)
    m.cfg["watch"] = dict(S.DEFAULT_CONFIG["watch"])
    m.watch_state = {}
    m._watch_stop = threading.Event()
    m._watch_thread = None
    m._watch_lock = threading.Lock()
    m.log = lambda msg: m.logs.append(str(msg))
    m._push_success = lambda *a, **k: None
    m._push_fail = lambda *a, **k: None
    return m


# ---------------- 1. 配置 ----------------
print("== 1. 监听配置 ==")
m = manager()
w = m.watch_cfg()
chk("默认关闭", w["enabled"] is False)
chk("默认间隔 30 秒", w["interval_sec"] == 30)
chk("默认账号 = 第一个账号", (m.watch_account() or {}).get("name") == "监听号")
chk("默认新品/补货都推", w["notify_new"] and w["notify_restock"])

m.cfg["watch"]["interval_sec"] = 1
chk("间隔下限 5 秒", m.watch_cfg()["interval_sec"] == 5, str(m.watch_cfg()["interval_sec"]))
m.cfg["watch"]["interval_sec"] = 99999
chk("间隔上限 3600 秒", m.watch_cfg()["interval_sec"] == 3600)
m.cfg["watch"]["interval_sec"] = "abc"
chk("乱填回落到 30", m.watch_cfg()["interval_sec"] == 30)

st = m.watch_status()
for k in ("enabled", "running", "account_name", "interval_sec", "tracked",
          "notified", "errors", "push_ready"):
    chk("watch_status 有 %s" % k, k in st)

# ---------------- 2. 首次只建基线 ----------------
print("\n== 2. 首次只建基线(不推送) ==")
m = manager()
sent.clear()
m._watch_diff([prize(1, "音箱", 100, 5), prize(2, "耳机", 200, 0, out=True)], m.accounts[0])
chk("第一次不推送", len(sent) == 0)
chk("基线标记已置位", m.watch_state.get("baseline") is True)
m._watch_save([prize(1, "音箱", 100, 5), prize(2, "耳机", 200, 0, out=True)])
chk("快照写下 2 个商品", len(m.watch_state["seen"]) == 2)

# ---------------- 3. 新品 / 补货 ----------------
print("\n== 3. 新品上架 / 补货 ==")


def tick(prizes):
    """模拟 _watch_tick 的一轮: 比对 + 落盘快照(生产代码每轮都存)。"""
    sent.clear()
    m._watch_diff(prizes, m.accounts[0])
    m._watch_save(prizes)


# 3a 新品(有货) -> 推
tick([prize(1, "音箱", 100, 5), prize(2, "耳机", 200, 0, out=True), prize(3, "手办", 300, 2)])
chk("新品(有货)被识别", len(sent) == 1 and [i["kind"] for i in sent[0]["items"]] == ["new"],
    str([i["kind"] for i in sent[0]["items"]]) if sent else "无")
chk("新品带上了金币", sent and sent[0]["items"][0]["cost"] == 300)

# 3b 新品但缺货 -> 不推
tick([prize(1, "音箱", 100, 5), prize(2, "耳机", 200, 0, out=True), prize(3, "手办", 300, 2),
      prize(4, "缺货仔", 50, 0, out=True)])
chk("新品但缺货 -> 不推(等有货再说)", len(sent) == 0)

# 3c 耳机 缺货->有货 -> 补货
tick([prize(1, "音箱", 100, 5), prize(2, "耳机", 200, 8, out=False), prize(3, "手办", 300, 2),
      prize(4, "缺货仔", 50, 0, out=True)])
chk("缺货->有货 识别为补货",
    len(sent) == 1 and sent[0]["items"][0]["kind"] == "restock",
    str(sent[0]["items"]) if sent else "无")
chk("补货带上了库存", sent and sent[0]["items"][0]["stock"] == 8)

# 3d 状态没再变 -> 不重复推(★ 快照每轮都落盘, 所以同一变化只推一次)
tick([prize(1, "音箱", 100, 6), prize(2, "耳机", 200, 8), prize(3, "手办", 300, 2),
      prize(4, "缺货仔", 50, 0, out=True)])
chk("★ 同一变化不会重复推送", len(sent) == 0,
    str(sent[0]["items"])[:60] if sent else "无")

# 3e 缺货仔后来到货了 -> 也能推出来(上一轮它已进快照)
tick([prize(1, "音箱", 100, 6), prize(2, "耳机", 200, 8), prize(3, "手办", 300, 2),
      prize(4, "缺货仔", 50, 4)])
chk("上一轮缺货、这一轮到货 -> 推补货",
    len(sent) == 1 and sent[0]["items"][0]["cName"] == "缺货仔",
    str(sent[0]["items"]) if sent else "无")

# ---------------- 4. 只开一个开关 ----------------
print("\n== 4. 通知开关 ==")
m = manager()
m.watch_state = {"baseline": True, "seen": {"1": {"cName": "音箱", "cost": 100,
                                                 "stock": 5, "out": False},
                                            "2": {"cName": "耳机", "cost": 200,
                                                  "stock": 0, "out": True}}}
m.cfg["watch"]["notify_new"] = False
sent.clear()
m._watch_diff([prize(1, "音箱", 100, 5), prize(2, "耳机", 200, 9),
               prize(3, "新品", 300, 1)], m.accounts[0])
kinds = [i["kind"] for i in (sent[0]["items"] if sent else [])]
chk("关掉新品通知 -> 新品不推", "new" not in kinds, str(kinds))
chk("关掉新品通知 -> 补货照推", kinds == ["restock"], str(kinds))

# ---------------- 5. 一轮 tick ----------------
print("\n== 5. 一轮检查 ==")
m = manager()
m.watch_state = {"baseline": True, "seen": {"1": {"cName": "音箱", "cost": 100,
                                                 "stock": 5, "out": False}}}
m._fetch_list = lambda acc: (True, {"code": 200, "data": {
    "balance": 77,
    "prizes": [{"level": "A", "prize": {"cId": 1, "pId": 1, "skuId": 2,
                                        "cName": "音箱", "scoreCostOrigin": 100, "stock": 5}},
               {"level": "A", "prize": {"cId": 3, "pId": 1, "skuId": 2,
                                        "cName": "新品手办", "scoreCostOrigin": 300, "stock": 2}}]}})
sent.clear()
m._watch_tick()
chk("acct_state 余额已更新", m.acct_state[1]["balance"] == 77)
chk("acct_state 商品已更新", len(m.acct_state[1]["prizes"]) == 2)
chk("记下了检查时间", bool(m.watch_state.get("checked_at")), str(m.watch_state.get("checked_at")))
chk("探到新品并推送", len(sent) == 1, str(sent)[:80])
chk("快照已更新到 2 个", len(m.watch_state["seen"]) == 2)

# 拉取失败: 记错误但不崩
m._fetch_list = lambda acc: (False, {"_exc": "ConnectionError"})
m.watch_state["baseline"] = True
m._watch_tick()
chk("拉取失败 -> 记录 last_error", m.watch_state.get("last_error") == "ConnectionError")
chk("拉取失败 -> 错误计数 +1", m.watch_state.get("errors") == 1)
chk("拉取失败不推空消息", len(sent) == 1)

# ---------------- 6. 开关线程 ----------------
print("\n== 6. 开启/停止后台线程 ==")
m = manager()
m.cfg["watch"]["interval_sec"] = 30
ticks = {"n": 0}


def fake_tick():
    ticks["n"] += 1
    time.sleep(0.05)


m._watch_tick = fake_tick
r = m.watch_start()
chk("watch_start 返回 ok", r.get("ok") is True, str(r))
chk("写了 enabled=True", m.cfg["watch"]["enabled"] is True)
chk("线程已起来", m._watch_thread is not None and m._watch_thread.is_alive())
t0 = time.time()
while ticks["n"] < 1 and time.time() - t0 < 3:
    time.sleep(0.02)
chk("线程真的跑了 tick", ticks["n"] >= 1, "ticks=%d" % ticks["n"])
m.watch_stop()
t0 = time.time()
while m._watch_thread.is_alive() and time.time() - t0 < 3:
    time.sleep(0.02)
chk("★ 停止后线程 2 秒内退出(不会留着后台空转)", not m._watch_thread.is_alive())
chk("写回 enabled=False", m.cfg["watch"]["enabled"] is False)
chk("停止有日志", any("已停止" in x for x in m.logs))

# 没有账号时不让开
m2 = manager()
m2.accounts = []
chk("没账号 -> 拒绝开启", m2.watch_start().get("ok") is False)

# ---------------- 7. 推送卡片内容 ----------------
print("\n== 7. 推送卡片 ==")
card = P.build_stock_card(
    [{"cName": "星巴克中杯拿铁券", "cost": 300, "stock": 20, "kind": "new"}],
    "监听号", "2026-10-02 10:00:00", interval_sec=30)
chk("卡片含商品名", "星巴克中杯拿铁券" in card)
chk("卡片含金币 300", "300" in card)
chk("卡片含库存", "20" in card)
chk("卡片含监听账号", "监听号" in card)
card2 = P.build_stock_card(
    [{"cName": "A", "cost": 1, "stock": 1, "kind": "restock"},
     {"cName": "B", "cost": 2, "stock": 2, "kind": "new"}], "x", "t")
chk("混合变化 -> 标题是「库存变化」", "库存变化" in card2)
card3 = P.build_stock_card(
    [{"cName": "第%d件" % i, "cost": i, "stock": i, "kind": "restock"} for i in range(1, 21)],
    "x", "t")
chk("超过 12 件会截断并提示", "还有 8 件" in card3, "含提示" if "还有 8 件" in card3 else "没提示")

S.save_json = real_save
print("\n" + "=" * 48)
print("通过 %d 项, 失败 %d 项" % (len(ok), len(bad)))
for b in bad:
    print("  失败:", b)
sys.exit(1 if bad else 0)
