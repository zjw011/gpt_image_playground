# -*- coding: utf-8 -*-
"""行级追踪：找出 daily_answer() 里让进程猝死的那一行（含子线程）。"""
import io
import linecache
import os
import sys
import threading
import time

os.environ["QT_QPA_PLATFORM"] = "offscreen"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

LOG = os.path.join(ROOT, "tools", "_trace_gui.log")
_f = io.open(LOG, "w", encoding="utf-8", buffering=1)


def say(s):
    try:
        sys.__stdout__.write(str(s) + "\n")
    except Exception:
        pass
    _f.write(str(s) + "\n")


from PySide6.QtWidgets import QApplication, QDialog  # noqa: E402
app = QApplication.instance() or QApplication(sys.argv)
import dewu_gui as G  # noqa: E402
app.setStyleSheet(G.GLOBAL_QSS)
w = G.MainWindow()
w.resize(1400, 940)
w.show()
app.processEvents()
say("主窗口就绪，按钮=%r" % w.btn_answer.text())

FILE = G.__file__
WATCH = ("daily_answer", "load_question", "on_qinfo", "on_image", "start", "row_of", "set_lbl")


def tracer(frame, event, arg):
    if frame.f_code.co_filename != FILE:
        return None
    fn = frame.f_code.co_name
    if fn not in WATCH:
        return None
    if event == "line":
        ln = frame.f_lineno
        src = (linecache.getline(FILE, ln) or "").strip()
        say("   [%s] %s:%d  %s" % (threading.current_thread().name, fn, ln, src[:96]))
    elif event in ("return", "exception"):
        say("   [%s] %s → %s  %r" % (threading.current_thread().name, fn, event, arg))
    return tracer


real_exec = QDialog.exec
QDialog.exec = lambda dlg: (say("   [exec] 到达 exec，弹窗标题=%r" % dlg.windowTitle()),
                            dlg.accept(), 0)[-1]

sys.settrace(tracer)
threading.settrace(tracer)
try:
    say(">>> 调 daily_answer()")
    w.daily_answer()
    say(">>> daily_answer 返回")
except Exception as e:
    import traceback
    say(">>> 异常 %r" % (e,))
    say(traceback.format_exc())
finally:
    sys.settrace(None)
    threading.settrace(None)
    QDialog.exec = real_exec

time.sleep(0.3)
_f.flush()
