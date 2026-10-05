# -*- coding: utf-8 -*-
"""跑 test_answer 的某一节，并把输出同时写文件（进程被杀也不丢日志）。"""
import io
import os
import sys
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")
sys.path.insert(0, ROOT)
sys.path.insert(0, TOOLS)

LOG = os.path.join(TOOLS, "_run_answer.log")
_f = io.open(LOG, "w", encoding="utf-8")


class Tee(object):
    def write(self, s):
        try:
            sys.__stdout__.write(s)
        except Exception:
            pass
        try:
            _f.write(s)
            _f.flush()
        except Exception:
            pass
        return len(s)

    def flush(self):
        try:
            _f.flush()
        except Exception:
            pass


sys.stdout = sys.stderr = Tee()

which = sys.argv[1] if len(sys.argv) > 1 else "all"
import test_answer as T  # noqa: E402

try:
    if which in ("all", "module"):
        T.test_module()
        print("== module 节完成 ==")
    if which in ("all", "real"):
        T.test_real()
        print("== real 节完成 ==")
    if which in ("all", "gui"):
        T.test_gui_fresh_day()
        print("== gui 节完成 ==")
    if which in ("all", "probe"):
        T.test_gui_probe()
        print("== probe 节完成 ==")
except Exception:
    traceback.print_exc()
    print("!! 抛异常了")

print("\n通过 %d 项 / 失败 %d 项" % (len(T.PASS), len(T.FAIL)))
for f in T.FAIL:
    print("   -", f)
_f.flush()
