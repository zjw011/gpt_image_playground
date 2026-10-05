# -*- coding: utf-8 -*-
"""验证: 启动声明弹窗每次必弹 + 同意/不同意 的返回值是否正确。"""
import os
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PySide6.QtCore import QTimer  # noqa: E402
from PySide6.QtWidgets import QApplication, QMessageBox  # noqa: E402

import dewu_gui as G  # noqa: E402

app = QApplication(sys.argv)
app.setStyle("Fusion")
app.setStyleSheet(G.GLOBAL_QSS)

state = {"box": None, "shot": False}


def find_box():
    for w in app.topLevelWidgets():
        if isinstance(w, QMessageBox) and w.isVisible():
            return w
    return None


def act(mode):
    box = find_box()
    if box is None:
        print("[!] 没找到弹窗")
        app.quit()
        return
    state["box"] = box
    if not state["shot"]:
        pm = box.grab()
        pm.save("声明弹窗_验证.png")
        sc = box.devicePixelRatio()
        print("[shot] 物理像素 %dx%d  dpr=%s" % (pm.width(), pm.height(), sc))
        state["shot"] = True
    if mode == "reject":
        box.reject()          # 等价于点「不同意并退出」/ 右上角 X
    else:
        for b in box.buttons():
            if box.buttonRole(b) == QMessageBox.AcceptRole:
                b.click()
                break


def run(mode):
    QTimer.singleShot(800, lambda: act(mode))
    r = G.show_disclaimer(None)
    print("[%s] show_disclaimer -> %s" % (mode, r))
    return r


r1 = run("reject")
r2 = run("accept")
print("=" * 40)
print("自动关窗(X/ESC) 返回:", r1, " 期望 False ->", r1 is False)
print("点同意          返回:", r2, " 期望 True  ->", r2 is True)
