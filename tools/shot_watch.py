# -*- coding: utf-8 -*-
"""渲染「库存监听」弹窗的真实预览图（用真实 windows 平台渲染，中文才不会变方块）。

不联网：watch_status / watch_once / today_info 全部打桩。
产出到 dist/ 下，用来肉眼确认排版没问题。
"""
import io
import os
import sys
import time

os.environ.setdefault("QT_QPA_PLATFORM", "windows")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from PySide6.QtWidgets import (  # noqa: E402
    QApplication, QDialog, QLabel, QPushButton, QMessageBox, QCheckBox,
)

OUTDIR = os.path.join(ROOT, "dist")
LOG = os.path.join(ROOT, "tools", "_shot_watch.log")
_f = io.open(LOG, "w", encoding="utf-8", buffering=1)


def say(s):
    _f.write(str(s) + "\n")
    try:
        sys.__stdout__.write(str(s) + "\n")
    except Exception:
        pass


app = QApplication.instance() or QApplication(sys.argv)

from PySide6.QtGui import QFont, QFontDatabase  # noqa: E402

for fam in ("Microsoft YaHei UI", "Microsoft YaHei", "SimHei",
            "Noto Sans CJK SC", "SimSun"):
    if fam in QFontDatabase.families():
        app.setFont(QFont(fam, 9))
        say("字体 = %s" % fam)
        break

import dewu_answer as ANS  # noqa: E402
import dewu_gui as G  # noqa: E402
import dewu_push as PUSH  # noqa: E402

app.setStyleSheet(G.GLOBAL_QSS)

# ---- 打桩：不联网、不碰真实账号 ----
ANS.today_info = lambda *a, **k: (None, "skip")          # 关掉开机探答题
G.M.accounts = [{"id": 1, "name": "账号1"},
                {"id": 2, "name": "小号备用账号"},
                {"id": 3, "name": "队友的号"}]
G.M.cfg["watch"]["account_id"] = 2
G.M.acct_state = {}
G.M.logs = []

_real_status = G.M.watch_status
_override = {}


def fake_status():
    st = _real_status()
    st.update(_override)
    return st


G.M.watch_status = fake_status


def fake_once():
    _override.update({"tracked": 8, "checked_at": "10-02 11:42:07",
                      "notified": 3, "last_error": None, "baseline": True,
                      "enabled": True, "running": True,
                      "account_name": "小号备用账号"})
    return True, "检查完成 · 已监听 8 个商品"


G.M.watch_once = fake_once
QMessageBox.information = staticmethod(lambda *a, **k: QMessageBox.Ok)
QMessageBox.warning = staticmethod(lambda *a, **k: QMessageBox.Ok)

w = G.MainWindow()
w.resize(1400, 940)
w.show()
app.processEvents()

shots = []


def snap(widget, name):
    p = os.path.join(OUTDIR, name)
    widget.grab().save(p)
    shots.append(p)
    say("已存 %s  (%d 字节, %dx%d)" % (name, os.path.getsize(p),
                                     widget.width(), widget.height()))
    return p


# ---------- ① 顶部按钮：未开启 ----------
_override.clear()
_override.update({"enabled": False, "running": False, "tracked": 0})
w._refresh_watch_btn()
app.processEvents()
say("按钮(未开启) = %r" % w.btn_watch.text())
snap(w, "库存监听_0_顶部按钮_未开启.png")

# ---------- ② 顶部按钮：运行中 ----------
_override.update({"enabled": True, "running": True, "tracked": 8,
                  "checked_at": "10-02 11:42:07", "notified": 3,
                  "baseline": True, "account_id": 2,
                  "account_name": "小号备用账号"})
w._refresh_watch_btn()
app.processEvents()
say("按钮(运行中) = %r" % w.btn_watch.text())

# ---------- ③ 弹窗本体（运行中 + 有记录） ----------
real_exec = QDialog.exec
_pushed = {"done": False}


def auto_exec(dlg):
    dlg.show()
    app.processEvents()
    for _ in range(12):
        app.processEvents()
        time.sleep(0.05)
    say("弹窗尺寸 %d x %d" % (dlg.width(), dlg.height()))
    for l in dlg.findChildren(QLabel):
        if l.text().strip():
            say("  文本: %r" % l.text()[:60])
    for c in dlg.findChildren(QCheckBox):
        say("  勾选: %-12s %s" % (c.text(), c.isChecked()))
    snap(dlg, "库存监听_1_弹窗_运行中.png")

    b = next((x for x in dlg.findChildren(QPushButton)
              if x.text() == "立即检查一次"), None)
    if b is not None:
        b.click()
        t0 = time.time()
        while time.time() - t0 < 8:
            app.processEvents()
            if b.isEnabled():
                break
            time.sleep(0.05)
        for _ in range(10):
            app.processEvents()
            time.sleep(0.05)
        for l in dlg.findChildren(QLabel):
            if "检查完成" in l.text():
                say("检查反馈 = %r" % l.text())
        snap(dlg, "库存监听_2_弹窗_检查后.png")

    dlg.reject()
    return 0


QDialog.exec = auto_exec
w.stock_watch()
QDialog.exec = real_exec

# ---------- ④ 没配 token 的警告态 ----------
_real_ready = PUSH.is_ready
PUSH.is_ready = lambda: False
_override.update({"enabled": False, "running": False, "tracked": 0,
                  "baseline": False, "checked_at": None, "notified": 0,
                  "last_error": None})


def auto_exec2(dlg):
    dlg.show()
    for _ in range(12):
        app.processEvents()
        time.sleep(0.05)
    snap(dlg, "库存监听_3_弹窗_没配推送.png")
    dlg.reject()
    return 0


QDialog.exec = auto_exec2
w.stock_watch()
QDialog.exec = real_exec
PUSH.is_ready = _real_ready

say("完成，共 %d 张" % len(shots))
_f.flush()
os._exit(0)      # MainWindow 的 QTimer 会让进程一直活着, 抓完图直接退
