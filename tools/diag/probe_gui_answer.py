# -*- coding: utf-8 -*-
"""最小探针：定位 daily_answer() 里到底是哪一步让进程死掉。"""
import io
import os
import sys
import time

os.environ["QT_QPA_PLATFORM"] = "offscreen"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

LOG = os.path.join(ROOT, "tools", "_probe_gui.log")
_f = io.open(LOG, "w", encoding="utf-8", buffering=1)


def say(s):
    try:
        sys.__stdout__.write(str(s) + "\n")
    except Exception:
        pass
    _f.write(str(s) + "\n")


say("① 导入 PySide6")
from PySide6.QtWidgets import QApplication, QDialog  # noqa: E402
say("② 建 QApplication")
app = QApplication.instance() or QApplication(sys.argv)
say("③ 导入 dewu_gui")
import dewu_gui as G  # noqa: E402
app.setStyleSheet(G.GLOBAL_QSS)
say("④ 建主窗口")
w = G.MainWindow()
w.resize(1400, 940)
w.show()
app.processEvents()
say("   按钮文案 = %r" % w.btn_answer.text())

real_exec = QDialog.exec


def stub_exec(dlg):
    """只进来看一眼就退出，不做交互。"""
    say("   [exec] 弹窗已构造，标题=%r" % dlg.windowTitle())
    kids = {}
    for c in dlg.findChildren(object):
        kids[type(c).__name__] = kids.get(type(c).__name__, 0) + 1
    say("   [exec] 子控件统计: %s" % kids)
    dlg.accept()
    return 0


QDialog.exec = stub_exec
say("⑤ 调 daily_answer()")
try:
    w.daily_answer()
    say("⑥ daily_answer 正常返回")
except Exception as e:
    import traceback
    say("⑥ 抛异常: %r" % (e,))
    say(traceback.format_exc())
finally:
    QDialog.exec = real_exec

time.sleep(0.5)
app.processEvents()
say("⑦ 结束")
w.close()
_f.flush()
