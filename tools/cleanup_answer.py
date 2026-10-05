# -*- coding: utf-8 -*-
"""整理本次答题功能产生的临时文件：一次性探针脚本+日志归入 tools/diag/。"""
import io
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")
DIAG = os.path.join(TOOLS, "diag")
os.makedirs(DIAG, exist_ok=True)

# 一次性探针脚本（阶段性排查用，留档备查）
move_py = ["probe_answer.py", "probe_h5.py", "scan_paths.py", "probe_today.py",
           "probe_multi.py", "probe_order.py", "probe_gui_answer.py",
           "trace_gui_answer.py"]
# 探针输出/日志/临时产物
move_other = ["_probe_answer.txt", "_probe_h5.txt", "_scan_paths.txt",
              "_probe_today.txt", "_probe_multi.txt", "_probe_order.txt",
              "_probe_lock.txt", "_probe_proc.txt", "_probe_kill.txt",
              "_probe_gui.log", "_trace_gui.log", "_run_answer.log",
              "_shot_answer.log", "_verify_answer.log", "_test_answer.log"]

log = []
for name in move_py + move_other:
    src = os.path.join(TOOLS, name)
    if os.path.exists(src):
        shutil.move(src, os.path.join(DIAG, name))
        log.append("移入 diag/  %s" % name)

# 抓下来的 H5 bundle（没用上，删掉）
for name in os.listdir(TOOLS):
    if name.startswith("_h5_"):
        os.remove(os.path.join(TOOLS, name))
        log.append("删除 %s" % name)

# 题图缓存
img = os.path.join(TOOLS, "img")
if os.path.isdir(img):
    shutil.rmtree(img)
    log.append("删除 tools/img/（题图缓存）")

io.open(os.path.join(TOOLS, "_cleanup_answer.log"), "w", encoding="utf-8").write("\n".join(log))
print("\n".join(log))
print()
print("=== tools/ 现有文件 ===")
for e in sorted(os.listdir(TOOLS)):
    p = os.path.join(TOOLS, e)
    print("  %-32s %s" % (e, "DIR" if os.path.isdir(p) else "%.1f KB" % (os.path.getsize(p) / 1024)))
print()
print("=== tools/diag/ ===")
for e in sorted(os.listdir(DIAG)):
    print("  %s" % e)
