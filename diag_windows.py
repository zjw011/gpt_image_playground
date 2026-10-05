# -*- coding: utf-8 -*-
"""诊断: exe 启动后到底弹出了哪些窗口(按标题枚举)。"""
import ctypes
import os
import subprocess
import time
from ctypes import wintypes

os.chdir(os.path.dirname(os.path.abspath(__file__)))
user32 = ctypes.windll.user32
DIST = r"D:\work\workbuudy\dewu\dist"
EXE = os.path.join(DIST, "得物整点抢兑助手.exe")


def dump():
    out = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        n = user32.GetWindowTextLengthW(hwnd)
        if n:
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            # 取该窗口所属进程名
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            r = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            out.append((buf.value, user32.IsWindowVisible(hwnd),
                        r.right - r.left, r.bottom - r.top, pid.value))
        return True

    user32.EnumWindows(cb, 0)
    return out


subprocess.run("taskkill /F /IM 得物整点抢兑助手.exe", shell=True,
               capture_output=True)
time.sleep(0.6)
proc = subprocess.Popen([EXE], cwd=DIST)
print("已启动 pid=%s" % proc.pid)

for i in range(12):
    time.sleep(2)
    alive = proc.poll() is None
    wins = [w for w in dump() if w[2] > 120 and w[3] > 60]
    print("--- t=%2ds  进程存活=%s  窗口数=%d" % ((i + 1) * 2, alive, len(wins)))
    for t, vis, w, h, pid in wins:
        print("      [%s] %sx%s vis=%s pid=%s" % (t[:30], w, h, vis, pid))

print("=== 日志尾部 ===")
log = os.path.join(DIST, "dewu_sniper.log")
if os.path.exists(log):
    with open(log, "r", encoding="utf-8", errors="replace") as f:
        lines = f.read().strip().splitlines()
    for ln in lines[-6:]:
        print("   ", ln)

subprocess.run("taskkill /F /IM 得物整点抢兑助手.exe", shell=True,
               capture_output=True)
