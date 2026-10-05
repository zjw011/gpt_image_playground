# -*- coding: utf-8 -*-
"""
用系统自带的 Edge 无头模式，把推送卡片渲染成 PNG，肉眼核对排版。
（不装任何东西；输出到 tools/_preview.png）
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import dewu_push as PUSH  # noqa: E402

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
BROWSER = EDGE if os.path.isfile(EDGE) else CHROME

html = os.path.join(HERE, "_preview.html")
png = os.path.join(HERE, "_preview.png")
profile = os.path.join(HERE, "_edge_profile")

PUSH.preview_html(html)
url = "file:///" + html.replace("\\", "/")

W, H = 680, 1560
cmd = [
    BROWSER,
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--no-first-run",
    "--disable-extensions",
    "--user-data-dir=" + profile,
    "--window-size=%d,%d" % (W, H),
    "--screenshot=" + png,
    url,
]
r = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=180)
print("browser :", BROWSER)
print("exists  :", os.path.isfile(png),
      (os.path.getsize(png) if os.path.isfile(png) else 0), "bytes")
print("rc      :", r.returncode)
if r.stdout.strip():
    print("stdout  :", r.stdout.strip()[:400])
if r.stderr.strip():
    print("stderr  :", r.stderr.strip()[:900])
