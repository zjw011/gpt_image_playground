# -*- coding: utf-8 -*-
"""渲染「每日答题」弹窗的真实预览图（离屏真渲染，含真实题图）。"""
import io
import json
import os
import sys
import time

os.environ.setdefault("QT_QPA_PLATFORM", "windows")   # 用真实平台渲染, 才有中文字体
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from PySide6.QtWidgets import QApplication, QDialog, QLabel, QLineEdit, QPushButton, QMessageBox  # noqa: E402
import dewu_answer as A  # noqa: E402

OUTDIR = os.path.join(ROOT, "dist")
LOG = os.path.join(ROOT, "tools", "_shot_answer.log")
_f = io.open(LOG, "w", encoding="utf-8", buffering=1)


def say(s):
    _f.write(str(s) + "\n")
    try:
        sys.__stdout__.write(str(s) + "\n")
    except Exception:
        pass


app = QApplication.instance() or QApplication(sys.argv)
import dewu_gui as G  # noqa: E402
# 离屏渲染默认字体没有中文字形，会全变方块 —— 显式指定字体
from PySide6.QtGui import QFont, QFontDatabase  # noqa: E402
for fam in ("Microsoft YaHei UI", "Microsoft YaHei", "SimHei", "Noto Sans CJK SC",
            "Source Han Sans SC", "SimSun"):
    if fam in QFontDatabase.families():
        app.setFont(QFont(fam, 9))
        sys.stderr.write("font=%s\n" % fam)
        break
say("可用字体(前 12): %s" % QFontDatabase.families()[:12])
app.setStyleSheet(G.GLOBAL_QSS)

accs = json.load(io.open(os.path.join(ROOT, "dist", "accounts.json"), encoding="utf-8"))
G.M.accounts = [dict(a) for a in accs]
G.M.acct_state = {}

# 真实题目（拿到真题图 URL）
info_real, err = A.today_info(accs[0])
assert err is None, err
IMG = info_real["image_url"]
say("真实题目: qId=%s %s  图=%s" % (info_real["question_id"], A.hint_text(info_real), IMG))

state = {"2": {"answered": False, "balance": 60},
         "3": {"answered": False, "balance": 2},
         "4": {"answered": True, "balance": 63}}
submits = []


def fake_today(acc, biz=None, timeout=10):
    s = state[str(acc["id"])]
    return {"question_id": info_real["question_id"], "image_url": IMG,
            "word_count": info_real["word_count"], "category": info_real["category"],
            "date": "9月19日", "status": 1 if s["answered"] else 0,
            "remain": 2 if s["answered"] else 3, "max_attempts": 3,
            "balance": s["balance"], "coin_earned": 1 if s["answered"] else 0,
            "answered": s["answered"]}, None


def fake_submit(acc, qid, answer, biz=None, sign=None, timeout=10):
    submits.append((acc["id"], qid, answer))
    s = state[str(acc["id"])]
    if str(acc["id"]) == "2":
        s["balance"] += 1
        return {"code": 200, "data": {"correct": True, "remainAttempts": 2, "coinEarned": 1}}, None
    return {"code": 200, "data": {"correct": False, "remainAttempts": 2, "coinEarned": 0}}, None


A.today_info, A.submit = fake_today, fake_submit
QMessageBox.information = staticmethod(lambda *a, **k: QMessageBox.Ok)

w = G.MainWindow()
w.resize(1400, 940)
w.show()
app.processEvents()

# 头部（含「每日答题」按钮）
w.grab().copy(0, 0, w.width(), 108).save(os.path.join(OUTDIR, "答题_入口按钮.png"))
say("已存 答题_入口按钮.png")

real_exec = QDialog.exec
shots = []


def auto_exec(dlg):
    # 不强制尺寸，量它自己想要的尺寸（决定小屏笔记本放不放得下）
    dlg.show()
    app.processEvents()

    def img_ok():
        for l in dlg.findChildren(QLabel):
            pm = l.pixmap()
            if pm is not None and not pm.isNull():
                return True
        return False

    t0 = time.time()
    while time.time() - t0 < 45:
        app.processEvents()
        chip = next((l for l in dlg.findChildren(QLabel)
                     if l.text().startswith("日期") and "—" not in l.text()), None)
        if chip and img_ok():
            break
        time.sleep(0.05)
    for _ in range(6):
        app.processEvents()
        time.sleep(0.05)
    say("弹窗自然尺寸(逻辑px): %d x %d  （屏幕可用 %d x %d）"
        % (dlg.width(), dlg.height(),
           app.primaryScreen().availableGeometry().width(),
           app.primaryScreen().availableGeometry().height()))
    say("  屏幕缩放 dpr = %s" % app.primaryScreen().devicePixelRatio())
    for l in dlg.findChildren(QLabel):
        if l.objectName() == "ansimg":
            say("  题图区: %d x %d" % (l.width(), l.height()))
    p1 = os.path.join(OUTDIR, "答题弹窗_1_出题.png")
    dlg.grab().save(p1)
    shots.append(p1)

    ed = next(l for l in dlg.findChildren(QLineEdit) if l.objectName() == "ansbig")
    ed.setText("导盲犬")
    btn = next(b for b in dlg.findChildren(QPushButton) if b.text() == "一键答题")
    btn.click()
    t0 = time.time()
    while time.time() - t0 < 40:
        app.processEvents()
        if btn.isEnabled():
            break
        time.sleep(0.05)
    for _ in range(10):
        app.processEvents()
        time.sleep(0.05)
    p2 = os.path.join(OUTDIR, "答题弹窗_2_答完.png")
    dlg.grab().save(p2)
    shots.append(p2)
    dlg.accept()
    return 0


QDialog.exec = auto_exec
w.daily_answer()
QDialog.exec = real_exec

app.processEvents()
w.grab().copy(0, 0, w.width(), 108).save(os.path.join(OUTDIR, "答题_入口按钮.png"))
for p in shots:
    say("已存 %s  %d 字节" % (os.path.basename(p), os.path.getsize(p)))
say("提交调用: %s" % submits)
_f.flush()
