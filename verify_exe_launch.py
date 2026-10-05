# -*- coding: utf-8 -*-
"""端到端验证真实 exe:
   1) 启动第一时间弹出声明(此时主界面不存在)
   2) 点「我已阅读并同意」后才进入主界面
   3) 重启一次, 确认声明是每次必弹
"""
import ctypes
import os
import subprocess
import sys
import time
from ctypes import wintypes

os.chdir(os.path.dirname(os.path.abspath(__file__)))
user32 = ctypes.windll.user32
DIST = r"D:\work\workbuudy\dewu\dist"
EXE = os.path.join(DIST, "得物整点抢兑助手.exe")

DLG_KEY = "使用声明与免责条款"
MAIN_KEY = "得物整点抢兑助手"


def windows():
    out = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                r = wintypes.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(r))
                out.append((hwnd, buf.value, r.right - r.left, r.bottom - r.top))
        return True

    user32.EnumWindows(cb, 0)
    return out


def find_dlg():
    for hwnd, t, w, h in windows():
        if DLG_KEY in t and w > 300:
            return hwnd, t, w, h
    return None, "", 0, 0


def find_main():
    for hwnd, t, w, h in windows():
        if t.startswith(MAIN_KEY) and DLG_KEY not in t and w > 900:
            return hwnd, t, w, h
    return None, "", 0, 0


def wait(fn, timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = fn()
        if r[0]:
            return r + (time.time() - t0,)
        time.sleep(0.4)
    return fn() + (time.time() - t0,)


def kill():
    subprocess.run(["taskkill", "/F", "/IM", "得物整点抢兑助手.exe"],
                   capture_output=True)
    time.sleep(0.8)


from PySide6.QtWidgets import QApplication  # noqa: E402
app = QApplication(sys.argv)
VK_RETURN, WM_KEYDOWN, WM_KEYUP = 0x0D, 0x0100, 0x0101

results = []
for round_no in (1, 2):
    kill()
    subprocess.Popen([EXE], cwd=DIST)
    print("\n===== 第 %d 次启动 =====" % round_no)

    hwnd, title, w, h, dt = wait(find_dlg, 40)
    print("[声明] 出现=%s  标题=%r  %dx%d  用时 %.1fs"
          % (bool(hwnd), title, w, h, dt))

    m_now = find_main()
    print("[顺序] 声明弹出时, 主界面是否已出现(应为 False): %s" % bool(m_now[0]))

    if round_no == 1 and hwnd:
        pm = app.primaryScreen().grabWindow(int(hwnd))
        pm.save("exe验证_声明弹窗.png")
        print("[截图] exe验证_声明弹窗.png %dx%d" % (pm.width(), pm.height()))

    if hwnd:
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.3)
        user32.PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN, 0)
        user32.PostMessageW(hwnd, WM_KEYUP, VK_RETURN, 0)
        print("[操作] 发送回车 = 点击「我已阅读并同意」")

    mh, mt, mw, mhh, dt2 = wait(find_main, 20)
    print("[主界面] 出现=%s  标题=%r  %dx%d  用时 %.1fs"
          % (bool(mh), mt, mw, mhh, dt2))
    print("[声明] 是否已关闭: %s" % (not bool(find_dlg()[0])))

    if round_no == 1 and mh:
        time.sleep(2.5)
        pm2 = app.primaryScreen().grabWindow(int(mh))
        pm2.save("exe验证_主界面.png")
        print("[截图] exe验证_主界面.png %dx%d" % (pm2.width(), pm2.height()))

    results.append((bool(hwnd), bool(mh)))

kill()
print("\n最终结论: 两次启动均(弹声明, 进主界面) = %s" % (results,))
