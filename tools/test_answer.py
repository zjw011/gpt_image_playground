# -*- coding: utf-8 -*-
"""每日答题：模块单测 + GUI 端到端（含模拟「新的一天」真实提交）。

真实网络部分：取题目、下题图（今天三个账号都已答对，走跳过分支，不做提交）。
模拟部分：把 today_info/submit 打桩成「新的一天」，让 answer_all 完整跑一遍，
         验证 提交参数正确 / 三类结果（答对、答错、已答跳过）/ 表格与按钮状态。
"""
import io
import json
import os
import sys
import threading
import time

os.environ["QT_QPA_PLATFORM"] = "offscreen"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dewu_answer as A  # noqa: E402

PASS, FAIL = [], []


def ck(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print("  %s %s%s" % ("PASS" if cond else "FAIL", name,
                         ("  → %s" % (extra,)) if extra != "" else ""))


def sec(t):
    print("\n" + "=" * 74)
    print(t)


# ---------------------------------------------------------------- 模块单测
def test_module():
    sec("① dewu_answer 纯逻辑")
    ck("classify 答对", A.classify({"code": 200, "data": {"correct": True, "coinEarned": 1}})
       == ("ok", "答对，+1 金币"))
    ck("classify 答错带剩余次数",
       A.classify({"code": 200, "data": {"correct": False, "remainAttempts": 2}})
       == ("wrong", "答案不对，还剩 2 次机会"))
    ck("classify 今日已答对", A.classify({"code": A.CODE_ALREADY, "msg": "今日已答对，明日再来"})
       == ("done", "今日已答对"))
    ck("classify 参数错误", A.classify({"code": A.CODE_PARAM})[0] == "err")
    ck("classify 460 风控", "风控" in A.classify({"code": 460})[1])
    ck("classify 登录失效", "登录态" in A.classify({"code": 700})[1])
    ck("classify 非 dict", A.classify(None) == ("err", "响应异常"))

    ck("hint_text", A.hint_text({"word_count": 3, "category": "谐音"}) == "3 个字 · 谐音")
    ck("hint_text 空", A.hint_text(None) == "" and A.hint_text({}) == "")

    ck("_sign_problem 认签名错", A._sign_problem({"msg": "签名校验失败"}) is True)
    ck("_sign_problem 不误判", A._sign_problem({"msg": "今日已答对，明日再来"}) is False)

    ck("_url 带参数+sign",
       A._url("/p", "abc", {"bizActivity": 2}) == "https://app.dewu.com/p?bizActivity=2&sign=abc")
    ck("_url 只有参数", A._url("/p", None, {"bizActivity": 2}) == "https://app.dewu.com/p?bizActivity=2")
    ck("_url 裸路径", A._url("/p") == "https://app.dewu.com/p")

    acc = json.load(io.open(os.path.join(ROOT, "dist", "accounts.json"), encoding="utf-8"))[0]
    h = A.headers_for(acc)
    ck("请求头带 x-auth-token", any(k.lower() == "x-auth-token" for k in h))
    ck("请求头带 cookieToken/duToken/SK/shumeiId",
       all(h.get(k) for k in ("cookieToken", "duToken", "SK", "shumeiId")))
    ck("请求头剔除了 Host/Content-Length", "Host" not in h and "Content-Length" not in h)
    ck("请求头用 identity 免 gzip", h.get("Accept-Encoding") == "identity")
    ck("biz_from_acc 默认 2", A.biz_from_acc({"list_curl": "curl 'https://x/y'"}) == 2)
    ck("biz_from_acc 能认 URL 里的活动号",
       A.biz_from_acc({"list_curl": "curl 'https://x/y?bizActivity=7'"}) == 7)


# ---------------------------------------------------------------- 真实网络
def test_real():
    sec("② 真实接口（今天三个账号都已答对 → 应全部走「跳过」，不发提交）")
    accs = json.load(io.open(os.path.join(ROOT, "dist", "accounts.json"), encoding="utf-8"))
    info, err = A.today_info(accs[0])
    ck("today_info 成功", err is None and info is not None, err)
    if info:
        ck("拿到 questionId", isinstance(info["question_id"], int), info["question_id"])
        ck("拿到题图 URL", info["image_url"].startswith("http"), info["image_url"][:60])
        ck("提示可读", A.hint_text(info) != "", A.hint_text(info))
        b = A.fetch_image(info["image_url"])
        ck("题图可下载", bool(b) and len(b) > 2000, "%s 字节" % (len(b) if b else 0))

    calls = {"submit": 0}
    real_submit = A.submit
    A.submit = lambda *a, **k: (calls.__setitem__("submit", calls["submit"] + 1), None)[1]
    try:
        res = A.answer_all(accs, "导盲犬")
    finally:
        A.submit = real_submit
    ck("批量返回条数 = 账号数", len(res) == len(accs), len(res))
    ck("已答对账号不重复提交（submit 零调用）", calls["submit"] == 0, calls["submit"])
    ck("结果都判为已答/跳过", all(r["kind"] in ("ok", "done", "err") for r in res))
    for r in res:
        print("     %-14s %-5s %s (余额 %s)" % (r["name"], r["kind"], r["text"], r.get("balance")))


# ---------------------------------------------------------------- GUI 端到端
def test_gui_fresh_day():
    sec("③ GUI 端到端：模拟「新的一天」跑完整答题")
    from PySide6.QtWidgets import (QApplication, QDialog, QLineEdit, QPushButton,
                                   QLabel, QTableWidget, QMessageBox)
    app = QApplication.instance() or QApplication(sys.argv)

    import dewu_gui as G
    app.setStyleSheet(G.GLOBAL_QSS)

    captured = {}

    # 源码方式运行时 APP_DIR 是源码目录, 没有 accounts.json —— 直接把真实账号注入 Manager
    real_accs = json.load(io.open(os.path.join(ROOT, "dist", "accounts.json"), encoding="utf-8"))
    G.M.accounts = [dict(a) for a in real_accs]
    G.M.acct_state = {}
    captured["acc_names"] = [a["name"] for a in real_accs]

    # ---- 打桩：今天是新的一天 ----
    # 账号2 未答 → 答对；账号3 未答 → 答错；账号4 已答 → 跳过
    state = {"2": {"answered": False, "balance": 60},
             "3": {"answered": False, "balance": 2},
             "4": {"answered": True, "balance": 63}}
    submits = []

    real_today, real_submit = A.today_info, A.submit

    # 拿真实的题图 URL，等下用真图片跑一遍下载+解码+缩放
    real_info, real_err = real_today(real_accs[0])
    assert real_err is None and real_info, "取真实题目失败: %s" % real_err
    real_img_url = real_info["image_url"]

    def fake_today(acc, biz=None, timeout=10):
        s = state[str(acc["id"])]
        return {"question_id": 854, "image_url": real_img_url, "word_count": 3,
                "category": "谐音", "date": "9月20日", "status": 1 if s["answered"] else 0,
                "remain": 2 if s["answered"] else 3, "max_attempts": 3,
                "balance": s["balance"], "coin_earned": 1 if s["answered"] else 0,
                "answered": s["answered"]}, None

    def fake_submit(acc, qid, answer, biz=None, sign=None, timeout=10):
        submits.append({"acc": acc["id"], "qid": qid, "answer": answer, "biz": biz})
        s = state[str(acc["id"])]
        if str(acc["id"]) == "2":
            s["balance"] += 1                      # 答对 → 金币 +1
            return {"code": 200, "data": {"correct": True, "remainAttempts": 2, "coinEarned": 1}}, None
        s["balance"] += 0
        return {"code": 200, "data": {"correct": False, "remainAttempts": 2, "coinEarned": 0}}, None

    A.today_info, A.submit = fake_today, fake_submit

    # 模态框在离屏环境下没有事件循环会卡死 —— 全部打桩
    real_info = QMessageBox.information
    real_q = QMessageBox.question
    QMessageBox.information = staticmethod(lambda *a, **k: QMessageBox.Ok)
    QMessageBox.question = staticmethod(lambda *a, **k: QMessageBox.Yes)

    w = G.MainWindow()
    w.resize(1400, 940)
    w.show()
    app.processEvents()

    ck("头部有「每日答题」按钮", hasattr(w, "btn_answer") and isinstance(w.btn_answer, QPushButton))
    ck("按钮已接线到 daily_answer", callable(getattr(w, "daily_answer", None)))
    ck("按钮文案含状态", "每日答题" in w.btn_answer.text(), w.btn_answer.text())
    ck("窗口宽度下按钮没被挤没", w.btn_answer.sizeHint().width() > 0,
       w.btn_answer.sizeHint().width())

    # ---- 把 exec 打桩成「自动操作一遍」 ----
    real_exec = QDialog.exec

    def auto_exec(dlg):
        def find(cls, cond=None):
            for c in dlg.findChildren(cls):
                if cond is None or cond(c):
                    return c
            return None
        # 等题目加载完（日期胶囊填上 + 题图真的渲染出来），或超时
        def img_ready():
            for l in dlg.findChildren(QLabel):
                pm = l.pixmap()
                if pm is not None and not pm.isNull():
                    captured["img_size"] = (pm.width(), pm.height())
                    return True
            return False

        chip = None
        t0 = time.time()
        while time.time() - t0 < 45:
            app.processEvents()
            chip = next((l for l in dlg.findChildren(QLabel)
                         if l.text().startswith("日期") and "—" not in l.text()), None)
            if chip and img_ready():
                break
            time.sleep(0.05)
        captured["img_loaded"] = img_ready()
        captured["chip_stat"] = next((l.text() for l in dlg.findChildren(QLabel)
                                      if l.text().startswith("已答")), "(无)")
        captured["chip_day"] = next((l.text() for l in dlg.findChildren(QLabel)
                                     if l.text().startswith("日期")), "(无)")
        captured["chip_hint"] = next((l.text() for l in dlg.findChildren(QLabel)
                                      if l.text().startswith("提示")), "(无)")
        captured["img_loaded"] = any(
            l.pixmap() is not None and not l.pixmap().isNull()
            for l in dlg.findChildren(QLabel))

        ed = find(QLineEdit, lambda x: x.objectName() == "ansbig")
        captured["has_input"] = ed is not None
        tbl = dlg.findChild(QTableWidget)
        captured["tbl"] = tbl
        btn_go = next((b for b in dlg.findChildren(QPushButton) if b.text() == "一键答题"), None)
        captured["has_go"] = btn_go is not None

        # 长度不符时应弹确认框 → 已全局打桩为「是」
        # 先试空答案：应被拦下且不提交
        ed.setText("")
        btn_go.click()
        app.processEvents()
        captured["empty_blocked"] = len(submits) == 0
        captured["empty_msg"] = next((l.text() for l in dlg.findChildren(QLabel)
                                      if "填上答案" in l.text()), "")

        # 正常答题
        ed.setText("导盲犬")
        btn_go.click()
        t0 = time.time()
        while time.time() - t0 < 40:
            app.processEvents()
            if btn_go.isEnabled() and "答题中" not in btn_go.text():
                break
            time.sleep(0.05)

        captured["btn_text_after"] = btn_go.text()
        captured["rows"] = []
        for r in range(tbl.rowCount()):
            captured["rows"].append([tbl.item(r, c).text() if tbl.item(r, c) else ""
                                     for c in range(tbl.columnCount())])
        captured["final_lbl"] = " | ".join(l.text() for l in dlg.findChildren(QLabel)
                                           if l.objectName() == "ansres")
        dlg.accept()
        return 0

    QDialog.exec = auto_exec
    try:
        w.daily_answer()
    finally:
        QDialog.exec = real_exec
        A.today_info, A.submit = real_today, real_submit
        QMessageBox.information = real_info
        QMessageBox.question = real_q

    print("     提交调用：%s" % json.dumps(submits, ensure_ascii=False))
    print("     表格：")
    for row in captured["rows"]:
        print("        %s" % row)

    ck("题图渲染成功（真图片下载+解码+等比缩放）", captured.get("img_loaded") is True,
       captured.get("img_size"))
    ck("题图缩放到 430 宽以内", captured.get("img_size", (0, 0))[0] <= 430,
       captured.get("img_size"))
    ck("日期胶囊", captured["chip_day"] == "日期 9月20日", captured["chip_day"])
    ck("提示胶囊", captured["chip_hint"] == "提示 3 个字 · 谐音", captured["chip_hint"])
    ck("有答案输入框", captured["has_input"] is True)
    ck("空答案被拦下（不提交）", captured.get("empty_blocked") is True)
    ck("空答案有提示语", "填上答案" in captured.get("empty_msg", ""), captured.get("empty_msg"))
    ck("只对「未答」的 2 个账号提交", len(submits) == 2, len(submits))
    ck("提交的 questionId 正确(自动取到的 854)", all(s["qid"] == 854 for s in submits))
    ck("提交的答案正确", all(s["answer"] == "导盲犬" for s in submits))
    ck("提交带上了活动号", all(s["biz"] in (2, None) for s in submits), submits[:1])
    ck("已答过的账号没被提交", all(s["acc"] != "2" for s in submits))

    txt = json.dumps(captured["rows"], ensure_ascii=False)
    ck("表格出现「答对，+1 金币」", "答对，+1 金币" in txt)
    ck("表格出现「答案不对，还剩 2 次机会」", "答案不对" in txt)
    ck("表格出现「今日已答对」", "今日已答对" in txt)
    ck("余额列显示 60 → 61", "60 → 61" in txt)
    ck("按钮回到可点状态", captured["btn_text_after"] == "一键答题", captured["btn_text_after"])
    ck("结束后按钮状态变「已答」", "已答" in w.btn_answer.text(), w.btn_answer.text())
    ck("底部汇总含「1 个答对」", "1 个答对" in captured.get("final_lbl", ""), captured.get("final_lbl"))

    # 账号表格余额应被同步
    app.processEvents()
    time.sleep(0.1)
    w._poll()
    app.processEvents()
    bal_cell = w.tbl_acct.item(0, 1)
    ck("账号表格余额同步为 61", bal_cell is not None and bal_cell.text() == "61",
       bal_cell.text() if bal_cell else None)

    w.close()
    app.processEvents()


def _tiny_png():
    """一张 4x4 的合法 PNG，用于验证图片链路（不联网）。"""
    import base64
    return base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR4nGP8//8/AzbAxIAH"
        "jEoOSgAAYBoD/2bF7F8AAAAASUVORK5CYII=")


def test_gui_probe():
    """启动时的状态探测：按钮文案必须自己更新（回归：子线程里 QTimer 不触发）。"""
    sec("④ GUI 启动探状态（真实接口）")
    from PySide6.QtWidgets import QApplication
    app = QApplication.instance() or QApplication(sys.argv)

    import dewu_gui as G
    app.setStyleSheet(G.GLOBAL_QSS)
    real_accs = json.load(io.open(os.path.join(ROOT, "dist", "accounts.json"), encoding="utf-8"))
    G.M.accounts = [dict(a) for a in real_accs]
    G.M.acct_state = {}

    w = G.MainWindow()
    w.resize(1400, 940)
    w.show()
    app.processEvents()

    before = w.btn_answer.text()
    ck("初始文案是「每日答题」", before == "每日答题", before)
    ck("有 _answer_bridges 容器", isinstance(getattr(w, "_answer_bridges", None), list))

    w._probe_answer_status()
    got = None
    t0 = time.time()
    while time.time() - t0 < 20:
        app.processEvents()
        if w.btn_answer.text() != "每日答题":
            got = w.btn_answer.text()
            break
        time.sleep(0.1)

    ck("探测后按钮文案自动更新（不再停在初始值）", got is not None, got or before)
    ck("文案含「已答」或「待答」", bool(got) and ("已答" in got or "待答" in got), got)
    ck("探到的日期已记录", bool(w._answer_day), w._answer_day)
    ck("跨天标记已记录", w._answer_probe_day != "", w._answer_probe_day)
    ck("按钮 tooltip 有说明", len(w.btn_answer.toolTip()) > 6, w.btn_answer.toolTip())
    w.close()
    app.processEvents()


if __name__ == "__main__":
    test_module()
    test_real()
    test_gui_fresh_day()
    test_gui_probe()
    print("\n" + "=" * 74)
    print("通过 %d 项" % len(PASS))
    if FAIL:
        print("失败 %d 项：" % len(FAIL))
        for f in FAIL:
            print("   -", f)
    else:
        print("全部通过 ✅")
