# -*- coding: utf-8 -*-
"""
端到端验证「推送设置」按钮真的出现在 exe 里。

判定依据（一句话）：按钮文案是启动时按 config.json 的 pushplus 段渲染的，
所以截图里只要出现「推送设置 · 已开启」，就同时证明了三件事：
  ① 新代码确实打进 exe 了      ② 按钮没被挤出头部      ③ exe 读到了推送配置

流程: 杀残留 → 启动 exe → 等声明窗 → 回车同意 → 等主窗口 → 截图
输出: dist/exe验证_推送按钮.png
"""
import ctypes
import os
import subprocess
import sys
import time
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
os.chdir(HERE)
DIST = os.path.join(ROOT, "dist")
EXE = os.path.join(DIST, "得物整点抢兑助手.exe")

user32 = ctypes.windll.user32
DLG_KEY = "使用声明与免责条款"
MAIN_KEY = "得物整点抢兑助手"
OUT_PNG = os.path.join(DIST, "exe验证_推送按钮.png")

lines = []


def say(s):
    print(s)
    lines.append(s)


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


def find(title_key, contain=True, minw=300):
    for hwnd, t, w, h in windows():
        if (title_key in t if contain else t.startswith(title_key)) and w > minw:
            return hwnd, t, w, h
    return None, "", 0, 0


def wait(fn, timeout=45):
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
    time.sleep(1.0)


def main():
    if not os.path.isfile(EXE):
        say("找不到 exe: %s" % EXE)
        return 1
    say("exe: %s (%d 字节)" % (EXE, os.path.getsize(EXE)))

    from PySide6.QtWidgets import QApplication
    app = QApplication.instance() or QApplication(sys.argv)

    kill()
    subprocess.Popen([EXE], cwd=DIST)
    say("已启动 exe")

    hwnd, title, w, h, dt = wait(lambda: find(DLG_KEY))
    say("[声明窗] 出现=%s 标题=%r %dx%d 用时 %.1fs" % (bool(hwnd), title, w, h, dt))
    if not hwnd:
        kill()
        return 1

    user32.SetForegroundWindow(hwnd)
    time.sleep(0.4)
    user32.PostMessageW(hwnd, 0x0100, 0x0D, 0)   # WM_KEYDOWN VK_RETURN
    user32.PostMessageW(hwnd, 0x0101, 0x0D, 0)   # WM_KEYUP
    say("已同意声明")

    mh, mt, mw, mhh, dt2 = wait(lambda: find(MAIN_KEY, contain=False, minw=900), 25)
    say("[主界面] 出现=%s 标题=%r %dx%d 用时 %.1fs" % (bool(mh), mt, mw, mhh, dt2))
    if not mh:
        kill()
        return 1

    time.sleep(3.0)   # 等界面把状态刷完（含按钮文案）
    pm = app.primaryScreen().grabWindow(int(mh))
    pm.save(OUT_PNG)
    say("[截图] %s  %dx%d" % (OUT_PNG, pm.width(), pm.height()))

    kill()
    say("已关闭 exe")
    return 0


if __name__ == "__main__":
    try:
        rc = main()
    finally:
        with open(os.path.join(HERE, "_verify_push_exe.log"), "w",
                  encoding="utf-8") as f:
            f.write("\n".join(lines))
    sys.exit(rc)
