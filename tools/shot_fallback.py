# -*- coding: utf-8 -*-
"""渲染「自动降级」相关界面的真实预览图（windows 平台，中文不会变方块）。

不联网：today_info 打桩；tasks 用假数据，但只改内存、不落盘。
产出到 dist/ 下，用来肉眼确认排版。
"""
import io
import os
import sys
import time

os.environ.setdefault("QT_QPA_PLATFORM", "windows")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from PySide6.QtWidgets import (  # noqa: E402
    QApplication, QDialog, QLabel, QCheckBox, QPushButton, QMessageBox,
)

OUTDIR = os.path.join(ROOT, "dist")
LOG = os.path.join(ROOT, "tools", "_shot_fallback.log")
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
from PySide6.QtCore import QPoint  # noqa: E402

app.setStyleSheet(G.GLOBAL_QSS)

ANS.today_info = lambda *a, **k: (None, "skip")     # 关掉开机探答题
G.M.accounts = [{"id": 1, "name": "账号1"}, {"id": 2, "name": "小号备用账号"}]
G.M.acct_state = {}
G.M.logs = []
G.M.watch_status = lambda: {"enabled": False, "running": False, "tracked": 0,
                            "account_name": "账号1", "interval_sec": 30,
                            "account_id": 1, "baseline": False, "checked_at": None,
                            "notified": 0, "last_error": None, "notify_new": True,
                            "notify_restock": True, "errors": 0, "push_ready": True}
QMessageBox.information = staticmethod(lambda *a, **k: QMessageBox.Ok)
QMessageBox.warning = staticmethod(lambda *a, **k: QMessageBox.Ok)

# 降级策略：跟用户选的一致
G.M.cfg["fallback"] = {"enabled": True, "on_gone": True, "on_soldout": True,
                       "on_poor": False, "min_ratio": 0.0}

# 假任务：一条正常、一条已经降级成功、一条降级后失败
G.M.tasks = [
    {"id": 1, "account_id": 1, "account_name": "账号1", "time": "10:00:00",
     "prize": {"cId": 108, "cName": "星巴克中杯拿铁券", "cost": 300},
     "_orig_prize": {"cId": 108, "cName": "星巴克中杯拿铁券", "cost": 300},
     "fb": dict(G.M.cfg["fallback"]), "lead_ms": 300, "interval_ms": 200,
     "max_attempts": 600, "repeat_daily": False, "status": "等待",
     "detail": "", "attempts": 0},
    {"id": 2, "account_id": 2, "account_name": "小号备用账号", "time": "10:00:00",
     "prize": {"cId": 902, "cName": "AirPods Pro 3", "cost": 108},
     "_orig_prize": {"cId": 111, "cName": "任天堂 Switch 2 主机", "cost": 12000},
     "fb": dict(G.M.cfg["fallback"]), "lead_ms": 300, "interval_ms": 200,
     "max_attempts": 600, "repeat_daily": False, "status": "成功",
     "detail": "第 1 次尝试成功（已自动降级换商品）", "attempts": 1,
     "_fell_back": True},
    {"id": 3, "account_id": 1, "account_name": "账号1", "time": "10:00:00",
     "prize": {"cId": 903, "cName": "OU 男士心动护手霜礼盒装", "cost": 150},
     "_orig_prize": {"cId": 111, "cName": "宝可梦集换式卡牌", "cost": 12500},
     "fb": dict(G.M.cfg["fallback"]), "lead_ms": 300, "interval_ms": 200,
     "max_attempts": 600, "repeat_daily": False, "status": "失败",
     "detail": "尝试 600 次未成功", "attempts": 600, "_fell_back": True},
]

w = G.MainWindow()
w.resize(1400, 940)
w.show()
app.processEvents()
w._task_sig = None
w._poll()
app.processEvents()

shots = []


def snap(widget, name):
    p = os.path.join(OUTDIR, name)
    widget.grab().save(p)
    shots.append(p)
    say("已存 %s (%d 字节, %dx%d)" % (name, os.path.getsize(p),
                                    widget.width(), widget.height()))


# ---------- ① 03 那一行的排版 ----------
say("降级设置按钮 = %r" % w.btn_fb.text())
say("失效自动降级勾选 = %s" % w.chk_fb.isChecked())
snap(w, "自动降级_0_主界面.png")

# ---------- ② 任务表格（带降级标记） ----------
tbl = w.tbl_task
for r in range(tbl.rowCount()):
    say("  行%d: %s | %s | %s | %s" % (
        r, tbl.item(r, 2).text(), tbl.item(r, 3).text(),
        tbl.item(r, 4).text(), tbl.item(r, 5).text()))
snap(tbl, "自动降级_1_任务表格.png")

# ---------- ③ 降级设置弹窗 ----------
real_exec = QDialog.exec


def auto_exec(dlg):
    dlg.show()
    for _ in range(14):
        app.processEvents()
        time.sleep(0.05)
    say("弹窗尺寸 %d x %d" % (dlg.width(), dlg.height()))
    for c in dlg.findChildren(QCheckBox):
        say("  勾选: %-28s %s" % (c.text(), c.isChecked()))
    snap(dlg, "自动降级_2_设置弹窗.png")
    dlg.reject()
    return 0


QDialog.exec = auto_exec
w.fallback_settings()
QDialog.exec = real_exec

# ---------- ④ 推送卡片预览（含降级说明） ----------
import dewu_push as PUSH  # noqa: E402

p = PUSH.preview_html(os.path.join(OUTDIR, "推送样式预览.html"))
say("推送预览 → %s" % p)
try:
    from PySide6.QtWebEngineWidgets import QWebEngineView  # noqa: F401
    say("（有 QtWebEngine，但这里不截图网页，直接用浏览器看 html）")
except Exception:
    pass

say("完成，共 %d 张" % len(shots))
_f.flush()
os._exit(0)      # MainWindow 的 QTimer 会让进程一直活着, 抓完图直接退
