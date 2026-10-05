# -*- coding: utf-8 -*-
"""
PushPlus 群发（一对多）验证 —— 纯本地，不发真实微信消息。

覆盖：
  ① clean_topic 边界
  ② 配置读写与默认值
  ③ send() 的 payload：一对一带不带 topic
  ④ send_async 的日志 tag（群发/私发 分得清）
  ⑤ send_stock 路由（核心：私发 / 群发 / 两者）
  ⑥ notify_stock 端到端
  ⑦ ★ 抢兑结果永不群发（notify_success / notify_fail）+ 源码守卫
  ⑧ notify_test 双发
  ⑨ GUI：弹窗控件、回显、summary、保存、非法编码拦截

用法: python tools/test_group_push.py
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

PASS, FAIL = [], []


def ck(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print("  %s %s%s" % ("✓" if cond else "✗", name, ("  → " + str(extra)) if extra else ""))


class _Resp:
    """假的 urlopen 返回对象（要能当上下文管理器用）。"""

    def __init__(self, data):
        self._d = data

    def read(self):
        return self._d

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


OK_BODY = json.dumps({"code": 200, "msg": "请求成功"}).encode("utf-8")


def main():
    import dewu_push as P

    # ---------------- ① clean_topic ----------------
    print("=" * 70)
    print("① clean_topic（群组编码规整）")
    ck("去普通空格", P.clean_topic(" de wu ") == "dewu", P.clean_topic(" de wu "))
    ck("去全角空格", P.clean_topic("　dewu　") == "dewu", P.clean_topic("　dewu　"))
    ck("去换行/制表", P.clean_topic("dewu\n\t") == "dewu", repr(P.clean_topic("dewu\n\t")))
    ck("去掉短横线以外的符号", P.clean_topic("de@wu!") == "dewu", P.clean_topic("de@wu!"))
    ck("保留 - 和 _", P.clean_topic("a-b_c1") == "a-b_c1", P.clean_topic("a-b_c1"))
    ck("保留大小写", P.clean_topic("DeWu") == "DeWu", P.clean_topic("DeWu"))
    # ★ isalnum() 对中文返回 True，所以必须显式按 ASCII 白名单过滤
    ck("★ 中文被剔除（不能靠 isalnum）", P.clean_topic("得物") == "",
       repr(P.clean_topic("得物")))
    ck("中文混英文只留英文", P.clean_topic("dewu库存") == "dewu", P.clean_topic("dewu库存"))
    ck("超 32 位截断", len(P.clean_topic("x" * 50)) == 32)
    ck("空/None 安全", P.clean_topic("") == "" and P.clean_topic(None) == "")

    # ---------------- ② 配置 ----------------
    print()
    print("② 配置读写与默认值")
    for k in ("topic", "group_stock", "group_self_too"):
        ck("DEFAULT_PUSH 含 %s" % k, k in P.DEFAULT_PUSH)
    ck("群发字段不掺抢兑（无 group_task）", "group_task" not in P.DEFAULT_PUSH)
    ck("topic 默认空", P.DEFAULT_PUSH["topic"] == "")
    ck("group_stock 默认开", P.DEFAULT_PUSH["group_stock"] is True)
    ck("group_self_too 默认开（保证不漏）", P.DEFAULT_PUSH["group_self_too"] is True)

    saved = dict(P.load())
    try:
        P.save(topic="dewu")
        ck("save(topic) 生效", P.load()["topic"] == "dewu", P.load()["topic"])
        ck("填了 topic → group_on() 真", P.group_on() is True)
        ck("save 不改 status_text", P.status_text() == "已开启", P.status_text())

        P.save(topic="  de wu  ")
        ck("save 时也做 clean_topic", P.load()["topic"] == "dewu", P.load()["topic"])

        P.save(group_stock=False)
        ck("group_stock=False → group_on() 假", P.group_on() is False)
        P.save(group_stock=True)

        P.save(group_self_too=False)
        ck("group_self_too=False 能存", P.load()["group_self_too"] is False)
        P.save(group_self_too=True)

        P.save(topic="")
        ck("topic 清空 → group_on() 假", P.group_on() is False)
        ck("topic 清空后 group_summary 提示未设置",
           "未设置" in P.group_summary(), P.group_summary())

        P.save(topic="dewu", group_stock=True, group_self_too=True)
        s = P.group_summary()
        ck("summary 含群组编码", "dewu" in s, s)
        ck("summary 含「私发一份」", "私发" in s, s)

        P.save(group_self_too=False)
        s2 = P.group_summary()
        ck("只群发时 summary 提到「只发群」", "只发群" in s2, s2)

        P.save(group_stock=False)
        s3 = P.group_summary()
        ck("没勾群发时 summary 会警告", "不会群发" in s3, s3)
    finally:
        P.save(topic=saved["topic"], group_stock=saved["group_stock"],
               group_self_too=saved["group_self_too"])

    # ---------------- ③ send() 的 payload ----------------
    print()
    print("③ send() 的 payload：一对一带不带 topic")
    captured = []
    real_urlopen = P.urllib.request.urlopen

    def fake_urlopen(req, timeout=None):
        captured.append(json.loads(req.data.decode("utf-8")))
        return _Resp(OK_BODY)

    P.urllib.request.urlopen = fake_urlopen
    try:
        captured.clear()
        ok, msg = P.send("标题", "内容")
        ck("一对一发送成功", ok, msg)
        ck("一对一 payload **没有** topic 键", "topic" not in captured[0], captured[0].keys())

        captured.clear()
        ok2, msg2 = P.send("标题", "内容", topic="dewu")
        ck("群发发送成功", ok2, msg2)
        ck("群发 payload 带 topic", captured[0].get("topic") == "dewu", captured[0].get("topic"))
        ck("群发仍带 token", bool(captured[0].get("token")))

        captured.clear()
        P.send("标题", "内容", topic="  de wu  ")
        ck("send 内部也 clean_topic", captured[0].get("topic") == "dewu",
           captured[0].get("topic"))

        captured.clear()
        P.send("标题", "内容", topic="")
        ck("topic='' 视同一对一", "topic" not in captured[0], captured[0].keys())

        captured.clear()
        P.send("标题", "内容", topic="得物")
        ck("topic 全中文 → 退化成一对一（不塞空 topic）",
           "topic" not in captured[0], captured[0].keys())
    finally:
        P.urllib.request.urlopen = real_urlopen

    # 真实接口对「群组编码不存在」回的是「服务端验证错误」→ 要翻译成人话
    BAD_GROUP = json.dumps({"code": 500, "msg": "服务端验证错误"}).encode("utf-8")
    P.urllib.request.urlopen = lambda req, timeout=None: _Resp(BAD_GROUP)
    try:
        ok_bad, msg_bad = P.send("标题", "内容", topic="no_such_grp")
        ck("不存在的群组 → 发送失败", ok_bad is False, msg_bad)
        ck("★ 错误里补上了「群组编码」人话提示",
           "群组编码" in msg_bad, msg_bad)

        ok_one, msg_one = P.send("标题", "内容")
        ck("一对一失败时不乱甩群组提示", "群组编码" not in msg_one, msg_one)
    finally:
        P.urllib.request.urlopen = real_urlopen

    # ---------------- ④ send_async 的 tag ----------------
    print()
    print("④ send_async 日志 tag")
    logs = []
    calls = []
    real_send, real_log = P.send, P._log
    P.send = lambda t, c, token=None, template="html", topic=None, **kw: (
        calls.append(topic), (True, "发送成功"))[1]
    P._log = lambda m: logs.append(m)
    try:
        th = P.send_async("T1", "C", topic="dewu", tag="群发「dewu」")
        th.join(5)
        th2 = P.send_async("T2", "C", tag="私发")
        th2.join(5)
        ck("群发那条 topic 传到了 send", calls[0] == "dewu", calls[0])
        ck("私发那条 topic 为 None", calls[1] is None, calls[1])
        ck("群发日志带 tag", any("群发「dewu」" in m for m in logs), logs)
        ck("私发日志带 tag", any("私发" in m for m in logs), logs)
        ck("日志仍含标题", any(m.endswith("T1") for m in logs), logs)
    finally:
        P.send, P._log = real_send, real_log

    # ---------------- ⑤ send_stock 路由 ----------------
    print()
    print("⑤ send_stock 路由（核心）")
    sent = []
    real_async = P.send_async
    P.send_async = lambda title, content, **kw: sent.append(
        {"title": title, "topic": kw.get("topic"), "tag": kw.get("tag")})
    try:
        saved = dict(P.load())
        # 5.1 没配群组 → 只私发
        P.save(topic="")
        sent.clear()
        r = P.send_stock("T", "C")
        ck("无 topic → 只发 1 条", len(sent) == 1, len(sent))
        ck("无 topic → 那条是私发", sent[0]["topic"] is None, sent[0])
        ck("无 topic → 返回 False", r is False)

        # 5.2 配了群组 + 默认（也私发）→ 群发 + 私发
        P.save(topic="dewu", group_stock=True, group_self_too=True)
        sent.clear()
        r = P.send_stock("T", "C")
        ck("群组+私发 → 发 2 条", len(sent) == 2, len(sent))
        ck("第一条是群发且带 topic", sent[0]["topic"] == "dewu", sent[0])
        ck("第二条是私发（无 topic）", sent[1]["topic"] is None, sent[1])
        ck("群发在前、私发在后", "群发" in (sent[0]["tag"] or ""), sent[0]["tag"])
        ck("返回 True", r is True)

        # 5.3 只要群发
        P.save(topic="dewu", group_stock=True, group_self_too=False)
        sent.clear()
        r = P.send_stock("T", "C")
        ck("只群发 → 发 1 条", len(sent) == 1, len(sent))
        ck("只群发那条带 topic", sent[0]["topic"] == "dewu", sent[0])

        # 5.4 填了 topic 但没勾「库存变化也群发」→ 退回只私发
        P.save(topic="dewu", group_stock=False, group_self_too=False)
        sent.clear()
        r = P.send_stock("T", "C")
        ck("group_stock=False → 只私发", len(sent) == 1 and sent[0]["topic"] is None, sent)
        ck("此时返回 False", r is False)
    finally:
        P.send_async = real_async
        P.save(topic=saved["topic"], group_stock=saved["group_stock"],
               group_self_too=saved["group_self_too"])

    # ---------------- ⑥ notify_stock 端到端 ----------------
    print()
    print("⑥ notify_stock 端到端")
    sent = []
    P.send_async = lambda title, content, **kw: sent.append(
        {"title": title, "topic": kw.get("topic"), "tag": kw.get("tag")})
    try:
        saved = dict(P.load())
        items = [{"cName": "AirPods Pro 3", "cost": 108, "stock": 2, "kind": "restock"}]

        P.save(topic="", enabled=True)
        sent.clear()
        ck("没配群组时 notify_stock 返回 True", P.notify_stock(items, "账号1", 30) is True)
        ck("没配群组 → 1 条私发", len(sent) == 1 and sent[0]["topic"] is None, sent)

        P.save(topic="dewu", enabled=True, group_stock=True, group_self_too=True)
        sent.clear()
        ck("配了群组时 notify_stock 仍 True", P.notify_stock(items, "账号1", 30) is True)
        ck("配了群组 → 群发 + 私发 2 条", len(sent) == 2, len(sent))
        ck("标题含「有货了」", "有货了" in sent[0]["title"], sent[0]["title"])

        P.save(enabled=False)
        sent.clear()
        ck("总开关关着 → 一条都不发", P.notify_stock(items, "账号1", 30) is False and not sent)

        P.save(enabled=True)
        sent.clear()
        ck("空列表不发", P.notify_stock([], "账号1", 30) is False and not sent)
    finally:
        P.send_async = real_async
        P.save(topic=saved["topic"], group_stock=saved["group_stock"],
               group_self_too=saved["group_self_too"], enabled=saved["enabled"])

    # ---------------- ⑦ 抢兑结果永不群发 ----------------
    print()
    print("⑦ ★ 抢兑结果永不群发（用户明确要求：群组只发库存变化）")
    sent = []
    P.send_async = lambda title, content, **kw: sent.append(
        {"title": title, "topic": kw.get("topic"), "tag": kw.get("tag")})
    try:
        saved = dict(P.load())
        P.save(topic="dewu", enabled=True, group_stock=True, group_self_too=True)
        sent.clear()
        P.notify_success("账号1", "AirPods Pro 3", cost=108, balance=2, attempts=1,
                         task_id=1)
        ck("notify_success 只发 1 条", len(sent) == 1, len(sent))
        ck("★ notify_success 那 1 条**不带** topic", sent[0]["topic"] is None, sent[0])

        P.save(on_fail=True)
        sent.clear()
        P.notify_fail("账号1", "某商品", "余额不足", cost=1, balance=2, task_id=1)
        ck("notify_fail 只发 1 条", len(sent) == 1, len(sent))
        ck("★ notify_fail 那 1 条**不带** topic", sent[0]["topic"] is None, sent[0])
    finally:
        P.send_async = real_async
        P.save(topic=saved["topic"], group_stock=saved["group_stock"],
               group_self_too=saved["group_self_too"], enabled=saved["enabled"],
               on_fail=saved["on_fail"])

    # 源码守卫：这两个函数体内不许出现 topic / send_stock
    src = open(os.path.join(ROOT, "dewu_push.py"), encoding="utf-8").read()

    def body(fn):
        m = re.search(r"\ndef %s\(" % fn, src)
        if not m:
            return ""
        nxt = re.search(r"\ndef ", src[m.end():])
        return src[m.start():m.end() + (nxt.start() if nxt else len(src))]

    for fn in ("notify_success", "notify_fail"):
        b = body(fn)
        ck("源码守卫：%s 不出现 topic" % fn, "topic" not in b)
        ck("源码守卫：%s 不调用 send_stock" % fn, "send_stock" not in b)
    ck("源码守卫：notify_stock 走 send_stock", "send_stock" in body("notify_stock"))

    # ---------------- ⑧ notify_test ----------------
    print()
    print("⑧ notify_test 双发")
    calls = []
    real_send2 = P.send
    P.send = lambda t, c, token=None, template="html", topic=None, **kw: (
        calls.append({"title": t, "topic": topic}), (True, "发送成功"))[1]
    try:
        calls.clear()
        ok, msg = P.notify_test(token="x" * 32, topic="")
        ck("无群组 → 只 1 次调用", len(calls) == 1, len(calls))
        ck("无群组 → 不带 topic", calls[0]["topic"] is None, calls[0])

        calls.clear()
        ok2, msg2 = P.notify_test(token="x" * 32, topic="dewu")
        ck("有群组 → 2 次调用", len(calls) == 2, len(calls))
        tp = [c for c in calls if c["topic"] == "dewu"]
        pv = [c for c in calls if c["topic"] is None]
        ck("其中一次带 topic=dewu", len(tp) == 1, [c["topic"] for c in calls])
        ck("另一次是私发", len(pv) == 1, [c["topic"] for c in calls])
        ck("群发那条标题带 📢 以便区分", "📢" in tp[0]["title"], tp[0]["title"])
        ck("两条都成功时返回 True", ok2 is True, msg2)
        ck("结果文案提到群组编码", "dewu" in msg2, msg2)
    finally:
        P.send = real_send2

    # ---------------- ⑨ GUI ----------------
    print()
    print("⑨ Qt 界面：群组控件 + 保存")
    from PySide6.QtWidgets import (QApplication, QDialog, QLineEdit, QCheckBox,
                                   QDialogButtonBox, QMessageBox)
    app = QApplication.instance() or QApplication(sys.argv)
    import dewu_gui as G
    app.setStyleSheet(G.GLOBAL_QSS)

    def open_push_dlg():
        """把 QDialog.exec 换掉 → 拿到弹窗对象，不阻塞。"""
        w = G.MainWindow()
        box = {"dlg": None, "n": 0}
        real_exec = QDialog.exec
        QDialog.exec = lambda self: (box.__setitem__("dlg", self),
                                     box.__setitem__("n", box["n"] + 1))[1] and 0
        try:
            w.btn_push.click()
        finally:
            QDialog.exec = real_exec
        return w, box["dlg"], box["n"]

    saved = dict(P.load())
    P.save(topic="dewu", group_stock=True, group_self_too=False, enabled=True)
    w, dlg, n = open_push_dlg()
    ck("点了推送设置 → 弹窗打开 1 次", n == 1, n)
    ck("拿到弹窗对象", dlg is not None)

    # 顶部按钮的 tooltip 要把群发摘要带上（否则 group_summary 就是死代码）
    tk = w.btn_push.toolTip()
    ck("★ 按钮 tooltip 带群发摘要", "群发" in tk and "dewu" in tk, tk.replace("\n", " | "))
    P.save(group_self_too=True)
    w._refresh_push_btn()
    ck("tooltip 跟着配置变（出现「私发」）", "私发" in w.btn_push.toolTip(),
       w.btn_push.toolTip().replace("\n", " | "))
    P.save(group_self_too=False)

    eds = dlg.findChildren(QLineEdit)
    ed_grp = next((e for e in eds if "群组编码" in e.placeholderText()), None)
    ck("弹窗里有「群组编码」输入框", ed_grp is not None)
    ck("群组编码回显配置里的 dewu", ed_grp is not None and ed_grp.text() == "dewu",
       ed_grp.text() if ed_grp else None)

    boxes = {c.text(): c for c in dlg.findChildren(QCheckBox)}
    ck("有「库存变化也群发到群组」勾选", any("库存变化也群发" in t for t in boxes), list(boxes))
    ck("有「也私发我一份」勾选", any("也私发我一份" in t for t in boxes), list(boxes))
    ck("群发勾选回显 True",
       boxes.get("库存变化也群发到群组") is not None
       and boxes["库存变化也群发到群组"].isChecked())
    ck("私发勾选回显 False",
       boxes.get("群发之外，也私发我一份") is not None
       and not boxes["群发之外，也私发我一份"].isChecked())
    ck("原有两个勾选还在",
       "开启抢兑成功推送" in boxes and "抢兑失败也推送" in boxes, list(boxes))

    from PySide6.QtWidgets import QLabel
    summary_lbl = next((x for x in dlg.findChildren(QLabel)
                        if "群发到" in x.text() or "群发关着" in x.text()), None)
    ck("有群发 summary 标签", summary_lbl is not None)
    if summary_lbl:
        ck("summary 指出只发货不发群",
           "不再私发" in summary_lbl.text(), summary_lbl.text())

    # 改勾选 → summary 跟着变
    if summary_lbl and "群发之外，也私发我一份" in boxes:
        boxes["群发之外，也私发我一份"].setChecked(True)
        ck("勾上私发后 summary 更新",
           "私发" in summary_lbl.text() and "不再私发" not in summary_lbl.text(),
           summary_lbl.text())

    # 保存 → 落到 config
    real_info = QMessageBox.information
    QMessageBox.information = lambda *a, **k: None
    try:
        bb = dlg.findChild(QDialogButtonBox)
        ck("弹窗有按钮盒", bb is not None)
        if ed_grp:
            ed_grp.setText("  my-group_1  ")
        boxes["群发之外，也私发我一份"].setChecked(True)
        bb.button(QDialogButtonBox.Ok).click()
        c = P.load()
        ck("保存后 topic 被 clean 并落盘", c["topic"] == "my-group_1", c["topic"])
        ck("保存后 group_stock=True", c["group_stock"] is True)
        ck("保存后 group_self_too=True", c["group_self_too"] is True)

        # 非法编码（全中文）→ 拦下，不改配置
        w2, dlg2, _ = open_push_dlg()
        ed2 = next((e for e in dlg2.findChildren(QLineEdit)
                    if "群组编码" in e.placeholderText()), None)
        ed2.setText("得物库存")
        bb2 = dlg2.findChild(QDialogButtonBox)
        bb2.button(QDialogButtonBox.Ok).click()
        ck("中文群组编码被拦下（配置未变）", P.load()["topic"] == "my-group_1",
           P.load()["topic"])
        ck("拦下后弹窗没关（还能改）", ed2.text() == "得物库存", ed2.text())
    finally:
        QMessageBox.information = real_info
        P.save(topic=saved["topic"], group_stock=saved["group_stock"],
               group_self_too=saved["group_self_too"], enabled=saved["enabled"],
               on_fail=saved["on_fail"])

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
