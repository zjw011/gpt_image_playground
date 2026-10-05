# -*- coding: utf-8 -*-
"""探测本机可用的 Python 解释器及其依赖（把结果写到文本文件，避免依赖 shell 管道）"""
import os
import subprocess
import sys

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_probe_py.txt")

CANDIDATES = [
    r"C:\Users\Administrator\.workbuddy\binaries\python\versions\3.13.12\python.exe",
    r"C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe",
    sys.executable,
    "python",
    "py",
]
# 常见的其它安装位置
for base in (r"C:\Python311", r"C:\Python312", r"C:\Python313",
             os.path.expanduser(r"~\AppData\Local\Programs\Python")):
    if os.path.isdir(base):
        for d in os.listdir(base):
            p = os.path.join(base, d, "python.exe")
            if os.path.isfile(p):
                CANDIDATES.append(p)

SNIPPET = (
    "import sys;"
    "print('VER', sys.version.split()[0], sys.executable);"
    "\nimport importlib;"
    "\nfor m in ('requests','PySide6','PyInstaller','urllib.request'):"
    "\n    try:"
    "\n        x=importlib.import_module(m)"
    "\n        print('OK ', m, getattr(x,'__version__',''))"
    "\n    except Exception as e:"
    "\n        print('NO ', m, type(e).__name__)"
)

lines = []
seen = set()
for c in CANDIDATES:
    if not c or c in seen:
        continue
    seen.add(c)
    lines.append("=" * 66)
    lines.append("CANDIDATE: %s" % c)
    try:
        p = subprocess.run([c, "-c", SNIPPET], capture_output=True, text=True,
                           errors="replace", timeout=90)
        lines.append((p.stdout or "").strip() or "(no stdout)")
        if p.stderr.strip():
            lines.append("STDERR: " + p.stderr.strip()[:400])
    except Exception as e:
        lines.append("FAILED: %r" % (e,))

with open(OUT, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print("written", OUT)
