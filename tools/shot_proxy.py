# -*- coding: utf-8 -*-
"""渲染「代理 IP」弹窗的真实预览图（真实 windows 平台渲染，中文才不会变方块）。

不联网：池子内容全部是假的，proxy_check 也打桩，不会真的去探 IP。
产出到 dist/ 下，用来肉眼确认排版没问题。

    python tools/shot_proxy.py
"""
import io
import os
import sys
import time

os.environ.setdefault("QT_QPA_PLATFORM", "windows")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from PySide6.QtWidgets import (  # noqa: E402
    QApplication, QDialog, QLabel, QPushButton, QMessageBox, QCheckBox, QTableWidget,
)

OUTDIR = os.path.join(ROOT, "dist")
LOG = os.path.join(ROOT, "tools", "_shot_proxy.log")
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

import dewu_answer as ANS     # noqa: E402
import dewu_gui as G          # noqa: E402
import dewu_proxies as PX     # noqa: E402

app.setStyleSheet(G.GLOBAL_QSS)

# ---- 打桩：不联网、不碰真实账号 / config.json ----
ANS.today_info = lambda *a, **k: (None, "skip")     # 关掉开机探答题
G.M.accounts = [{"id": 1, "name": "甲号 · 主力"},
                {"id": 2, "name": "小号备用"},
                {"id": 3, "name": "队友的号"}]
G.M.acct_state = {}
G.M.logs = []
G.save_json = lambda p, o: None

FAKE = [
    # (host, port, scheme, label, account_id, status, exit_ip, latency, ok, fail, enabled)
    ("112.17.36.108", 1080, "socks5h", "杭州电信 · 独享", 1, "ok", "112.17.36.108", 186, 42, 1, True),
    ("120.79.44.21", 1080, "socks5h", "阿里云 · 独享", 2, "ok", "120.79.44.21", 233, 31, 0, True),
    ("47.98.120.6", 1080, "socks5h", "杭州 · 独享", 3, "ok", "47.98.120.6", 268, 17, 0, True),
    ("39.108.88.240", 1080, "socks5h", "深圳 · 备用", None, "ok", "39.108.88.240", 412, 9, 1, True),
    ("121.40.11.77", 1080, "socks5h", "上海 · 备用", None, "bad", "", 8012, 0, 6, True),
    ("123.56.7.19", 8080, "http", "北京 · 还没测", None, "untested", "", 0, 0, 0, True),
    ("47.110.9.33", 1080, "socks5h", "过期停用", None, "bad", "", 0, 3, 9, False),
]


def fake_pool():
    out = []
    for i, (h, p, sc, lb, aid, st, ip, lat, ok, fail, en) in enumerate(FAKE, 1):
        out.append({"id": i, "url": "%s://%s:%d" % (sc, h, p), "scheme": sc,
                    "host": h, "port": p, "label": lb, "account_id": aid,
                    "enabled": en, "status": st, "exit_ip": ip, "latency_ms": lat,
                    "ok_count": ok, "fail_count": fail, "fail_streak": 0,
                    "last_ok_at": "2026-10-05 11:40:00", "last_error": "",
                    "created_at": "2026-10-05 11:30:00"})
    return out


G.M.proxy_pool = fake_pool
G.M.proxy_status = lambda: {
    "enabled": True, "mode": "sticky", "rotate_n": 20, "also_list": False,
    "total": len(FAKE), "alive": 6, "ok": 4, "bad": 1, "untested": 1,
    "bound": 3, "accounts": 3, "socks_ready": True,
    "summary": PX.describe_pool(fake_pool()),
}
G.M.proxy_check = lambda ids=None, only_new=False, timeout=8: {
    "ok": True, "checked": 4, "passed": 3,
    "results": [{"id": 1, "ok": True, "exit_ip": "112.17.36.108", "latency_ms": 186}]}
QMessageBox.information = staticmethod(lambda *a, **k: QMessageBox.Ok)
QMessageBox.warning = staticmethod(lambda *a, **k: QMessageBox.Ok)
QMessageBox.question = staticmethod(lambda *a, **k: QMessageBox.Yes)

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


# ---------- ① 顶部按钮 ----------
w._refresh_proxy_btn()
app.processEvents()
say("按钮 = %r" % w.btn_proxy.text())
snap(w, "代理IP_0_顶部按钮.png")

# ---------- ② 弹窗本体 ----------
real_exec = QDialog.exec


def auto_exec(dlg):
    dlg.show()
    for _ in range(14):
        app.processEvents()
        time.sleep(0.05)
    say("弹窗尺寸 %d x %d" % (dlg.width(), dlg.height()))
    for l in dlg.findChildren(QLabel):
        if l.text().strip():
            say("  文本: %r" % l.text()[:70])
    for c in dlg.findChildren(QCheckBox):
        say("  勾选: %-24s %s" % (c.text(), c.isChecked()))
    for t in dlg.findChildren(QTableWidget):
        say("  表格 %d 行 x %d 列" % (t.rowCount(), t.columnCount()))
        for r in range(min(t.rowCount(), 8)):
            say("    | " + " | ".join(
                (t.item(r, c).text() if t.item(r, c) else "") for c in range(t.columnCount())))
    snap(dlg, "代理IP_1_弹窗.png")

    # 点一下「只测没测过的」看反馈行
    b = next((x for x in dlg.findChildren(QPushButton) if x.text() == "只测没测过的"), None)
    if b is not None:
        b.click()
        t0 = time.time()
        while time.time() - t0 < 8:
            app.processEvents()
            if b.isEnabled():
                break
            time.sleep(0.05)
        for _ in range(8):
            app.processEvents()
            time.sleep(0.05)
        for l in dlg.findChildren(QLabel):
            if "检测完" in l.text():
                say("检测反馈 = %r" % l.text())
        snap(dlg, "代理IP_2_检测后.png")

    dlg.reject()
    return 0


QDialog.exec = auto_exec
w.proxy_settings()

say("共 %d 张" % len(shots))
_f.close()
# 截图脚本跑完就退，别被 MainWindow 的定时器拖着不结束
os._exit(0)
