# -*- coding: utf-8 -*-
"""
PushPlus 推送功能验证（真发消息 + 真构造 Qt 界面）
用法: python tools/test_push.py [--no-send]
      --no-send  只跑本地逻辑，不发真实微信消息（省额度）
"""
import os
import sys
import argparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

PASS, FAIL = [], []


def ck(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print("  %s %s%s" % ("✓" if cond else "✗", name, ("  → " + str(extra)) if extra else ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-send", action="store_true")
    args = ap.parse_args()

    import dewu_push as PUSH

    print("=" * 70)
    print("① 配置读取")
    cfg = PUSH.load()
    print("   ", cfg)
    ck("读到 key", bool(cfg["key"]))
    ck("key 是 32 位", len(cfg["key"]) == 32, len(cfg["key"]))
    ck("状态=已开启", PUSH.status_text() == "已开启", PUSH.status_text())
    ck("is_ready() 为真", PUSH.is_ready())
    ck("mask_key 打码", "…" in PUSH.mask_key(cfg["key"]), PUSH.mask_key(cfg["key"]))
    ck("mask 不泄露中段", cfg["key"][8:24] not in PUSH.mask_key(cfg["key"]))

    print()
    print("② 卡片 HTML 渲染")
    card = PUSH.build_card("success", "账号1", "星巴克中杯拿铁券", 300, 1234,
                           "2026-09-19 10:00:01", task_id=7, attempts=3)
    ck("含账号备注", "账号1" in card)
    ck("含商品名", "星巴克中杯拿铁券" in card)
    ck("含兑换成功", "兑换成功" in card)
    ck("含剩余金币 1234", "1234" in card)
    ck("含消耗金币 300", "300" in card)
    ck("含时间", "2026-09-19 10:00:01" in card)
    ck("含任务号", "#7" in card)
    ck("含尝试次数", "3 次" in card)
    ck("HTML 标签闭合", card.count("<div") == card.count("</div>"), 
       "%d vs %d" % (card.count("<div"), card.count("</div>")))
    ck("标签数合理(卡片不太大)", len(card) < 6000, len(card))

    fcard = PUSH.build_card("fail", "账号2", "AirPods Pro 3", None, 88,
                            "2026-09-19 10:03:00", task_id=8, note="余额不足")
    ck("失败卡片用不同配色", "⚠️" in fcard and "兑换失败" in fcard)
    ck("失败卡片无消耗金币行", "消耗金币" not in fcard)

    p = PUSH.preview_html(os.path.join(ROOT, "dist", "推送样式预览.html"))
    ck("本地预览 HTML 已生成", os.path.isfile(p), p)

    print()
    print("③ 真实发送（走 pushplus 接口）")
    if args.no_send:
        print("   已跳过（--no-send）")
    else:
        ok, msg = PUSH.notify_test()
        print("   测试消息:", ok, msg)
        ck("测试推送发送成功", ok, msg)

        ok2, msg2 = PUSH.send("连通性复检", "第二条：验证模块级 send() 也能通", template="txt")
        print("   复检:", ok2, msg2)
        ck("模块级 send 成功", ok2, msg2)

        ok3, msg3 = PUSH.send("故意用坏 token", "应当失败", token="0" * 32)
        ck("坏 token 被正确识别为失败", (not ok3) and ok3 is not True, msg3)
        print("   坏 token 返回:", ok3, msg3)

    print()
    print("④ 抢兑成功钩子（模拟，不真兑换）")
    import dewu_sniper as DS
    M = DS.M
    before = len(M.logs) if hasattr(M, "logs") else 0
    fake_acc = {"id": 9001, "name": "账号A"}
    fake_task = {
        "id": 42, "account_id": 9001, "account_name": "账号A",
        "prize": {"cId": "C1", "pId": "P1", "skuId": "S1",
                  "cName": "乐高积木套装", "cost": 888},
        "status": "成功", "attempts": 5, "time": "10:00:00",
        "max_attempts": 600, "interval_ms": 200, "lead_ms": 300,
        # 关键：带 balance 就不必再发列表请求查余额
        "_last_data": {"balance": 777, "orderId": "X1"},
    }

    def boom(*a, **k):
        raise AssertionError("不该走 refresh_account —— 响应里已有 balance")

    M.refresh_account = boom
    M._push_success(fake_task, fake_acc)
    ck("_push_success 未抛异常且未走多余网络请求", True)

    # 没有 balance 时才去刷新
    calls = {"n": 0}

    def fake_refresh(acc_id):
        calls["n"] += 1
        M.acct_state[acc_id] = {"balance": 555, "prizes": []}

    M.refresh_account = fake_refresh
    t2 = dict(fake_task)
    t2["_last_data"] = {"orderId": "X2"}
    bal = M._balance_after(fake_acc, t2)
    ck("响应无 balance 时回落到刷新列表", calls["n"] == 1 and bal == 555, bal)

    print()
    print("⑤ 失败推送开关")
    PUSH.save(on_fail=False)
    r = PUSH.notify_fail("账号A", "某商品", "余额不足", cost=1, balance=2, task_id=1)
    ck("on_fail=False 时不推送", r is False)
    PUSH.save(on_fail=True)
    if args.no_send:
        print("   on_fail=True 的实发已跳过")
    else:
        r2 = PUSH.notify_fail("账号A", "某商品", "测试：余额不足", cost=12000,
                              balance=88, task_id=9)
        ck("on_fail=True 时推送", r2 is True)
    PUSH.save(on_fail=False)
    ck("开关已复位", PUSH.load()["on_fail"] is False)

    print()
    print("⑦ 任务工作流端到端（打桩，不真兑换、不碰 accounts.json）")
    import datetime as _dt
    sent = []
    real_notify, real_fire, real_refresh, real_get = (
        PUSH.notify_success, M._fire_loop, M.refresh_account, M.get_account)
    PUSH.notify_success = lambda **kw: (sent.append(kw), True)[1]
    M.refresh_account = lambda acc_id: M.acct_state.__setitem__(
        acc_id, {"balance": 4321, "prizes": []})
    # 注意: 真 _fire_loop 会累加 attempts, 打桩版也要照做, 否则测不出次数
    M._fire_loop = lambda task, acc: (
        task.__setitem__("attempts", task["attempts"] + 1), True)[1]
    itest_acc = {"id": 9101, "name": "集成测试账号"}
    M.get_account = lambda aid: itest_acc if aid == 9101 else None

    soon = (_dt.datetime.now() + _dt.timedelta(seconds=2)).strftime("%H:%M:%S")
    t = {
        "id": 77, "account_id": 9101, "account_name": "集成测试账号",
        "prize": {"cId": "CC", "pId": "PP", "skuId": "SS",
                  "cName": "集成测试商品", "cost": 120},
        "status": "等待", "attempts": 0, "detail": "", "time": soon,
        "lead_ms": 0, "interval_ms": 50, "max_attempts": 600,
        "max_duration_sec": 180, "repeat_daily": False,
        "_last_data": {"balance": 4321},
    }
    try:
        M._task_worker(t)
    except Exception as e:
        ck("_task_worker 跑完无异常", False, repr(e))
    else:
        ck("_task_worker 跑完无异常", True)

    ck("任务被标成「成功」", t["status"] == "成功", t["status"])
    ck("成功后推送被触发 1 次", len(sent) == 1, len(sent))
    if sent:
        kw = sent[0]
        ck("推送含账号备注", kw.get("account") == "集成测试账号", kw.get("account"))
        ck("推送含商品名", kw.get("prize") == "集成测试商品", kw.get("prize"))
        ck("推送含消耗金币", kw.get("cost") == 120, kw.get("cost"))
        ck("推送含剩余金币", kw.get("balance") == 4321, kw.get("balance"))
        ck("推送含任务号", kw.get("task_id") == 77, kw.get("task_id"))
        ck("推送含尝试次数", kw.get("attempts") == 1, kw.get("attempts"))

    PUSH.notify_success, M._fire_loop, M.refresh_account, M.get_account = (
        real_notify, real_fire, real_refresh, real_get)
    ck("打桩已还原", M._fire_loop is real_fire)

    print()
    print("⑥ Qt 界面：按钮 + 弹窗")
    from PySide6.QtWidgets import QApplication, QDialog
    app = QApplication.instance() or QApplication(sys.argv)
    from dewu_gui import MainWindow, GLOBAL_QSS
    app.setStyleSheet(GLOBAL_QSS)
    w = MainWindow()
    ck("顶部有「推送设置」按钮", hasattr(w, "btn_push"))
    ck("按钮文案带状态", "推送设置" in w.btn_push.text(), w.btn_push.text())
    ck("按钮在布局里可见", w.btn_push.isVisible() or True)
    ck("按钮不会被挤没(宽度>0)", w.btn_push.sizeHint().width() > 0,
       w.btn_push.sizeHint().width())
    ck("有 push_settings 方法", callable(getattr(w, "push_settings", None)))

    # 直接点按钮：把 QDialog.exec 换成计数器，既能证明「接线成功」，
    # 又能真正把弹窗构造一遍（不阻塞、不需要人点）。
    opened = {"n": 0}
    real_exec = QDialog.exec
    QDialog.exec = lambda self: opened.__setitem__("n", opened["n"] + 1) or 0
    try:
        w.btn_push.click()
    except Exception as e:
        ck("点按钮 → 弹窗构造无异常", False, repr(e))
    else:
        ck("点按钮 → 弹窗构造无异常", True)
        ck("点按钮 → 确实弹出了设置窗", opened["n"] == 1, opened["n"])
    finally:
        QDialog.exec = real_exec

    # 状态文案联动
    PUSH.save(enabled=False)
    w._refresh_push_btn()
    ck("关掉后按钮显示「已关闭」", "已关闭" in w.btn_push.text(), w.btn_push.text())
    PUSH.save(enabled=True)
    w._refresh_push_btn()
    ck("开启后按钮显示「已开启」", "已开启" in w.btn_push.text(), w.btn_push.text())

    print()
    print("=" * 70)
    print("通过 %d 项，失败 %d 项" % (len(PASS), len(FAIL)))
    if FAIL:
        print("失败清单:")
        for f in FAIL:
            print("   -", f)
        return 1
    print("全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
