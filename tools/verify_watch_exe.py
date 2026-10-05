# -*- coding: utf-8 -*-
"""在真实 exe 里验证「库存监听」：

  启动 → 过声明窗 → 截主界面（确认工具栏多出「库存监听」按钮）
  → 点「库存监听」→ 截弹窗 → 点「样式预览」不点（避免弹浏览器）

落点方式同 verify_answer_exe.py：不算坐标，从截图里找白色药丸块，逐个试。
输出: dist/exe验证_库存监听_*.png
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
sys.path.insert(0, HERE)

from procutil import kill as kill_exe                    # noqa: E402

DIST = os.path.join(ROOT, "dist")
EXE = os.path.join(DIST, "得物整点抢兑助手.exe")

user32 = ctypes.windll.user32
DLG_KEY = "使用声明与免责条款"
MAIN_KEY = "得物整点抢兑助手"
WATCH_KEY = "库存监听"
OTHER_KEYS = ("微信推送设置", "每日答题", "手机号登录")

lines = []


def say(s):
    print(s)
    lines.append(str(s))


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
                out.append((hwnd, buf.value, r.left, r.top,
                            r.right - r.left, r.bottom - r.top))
        return True

    user32.EnumWindows(cb, 0)
    return out


def find(key, contain=True, minw=200):
    for hwnd, t, x, y, w, h in windows():
        if (key in t if contain else t.startswith(key)) and w > minw:
            return hwnd, t, x, y, w, h
    return None, "", 0, 0, 0, 0


def wait(fn, timeout=45):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = fn()
        if r[0]:
            return r + (time.time() - t0,)
        time.sleep(0.4)
    return fn() + (time.time() - t0,)


def kill():
    # 别再用 taskkill /IM 中文名 —— cp936 解码会飘，静默失败留残留进程。
    # 走 procutil: 按 exe 完整路径找 PID, 再按 PID 杀(先杀大的子进程)。
    killed = kill_exe(EXE)
    if not killed:
        time.sleep(0.4)
    else:
        time.sleep(0.8)


def client_origin(hwnd):
    pt = wintypes.POINT(0, 0)
    user32.ClientToScreen(int(hwnd), ctypes.byref(pt))
    return pt.x, pt.y


def click(hwnd, sx, sy):
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.35)
    user32.SetCursorPos(int(sx), int(sy))
    time.sleep(0.25)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.09)
    user32.mouse_event(0x0004, 0, 0, 0, 0)


def white_runs(img, y, min_w=40, thr=246):
    runs, start = [], None
    for x in range(img.width()):
        c = img.pixelColor(x, y)
        if c.red() >= thr and c.green() >= thr and c.blue() >= thr:
            if start is None:
                start = x
        elif start is not None:
            if x - start >= min_w:
                runs.append((start, x - 1, x - start))
            start = None
    if start is not None and img.width() - start >= min_w:
        runs.append((start, img.width() - 1, img.width() - start))
    return runs


def main():
    from PySide6.QtWidgets import QApplication
    app = QApplication.instance() or QApplication(sys.argv)

    kill()
    subprocess.Popen([EXE], cwd=DIST)
    say("已启动 exe")

    hwnd, _t, *_x, dt = wait(lambda: find(DLG_KEY))
    if not hwnd:
        say("★ 声明窗没出现")
        kill()
        return 1
    say("[声明窗] 出现，用时 %.1fs" % dt)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.4)
    user32.PostMessageW(hwnd, 0x0100, 0x0D, 0)
    user32.PostMessageW(hwnd, 0x0101, 0x0D, 0)

    mh, mt, mx, my, mw, mhg, dt2 = wait(
        lambda: find(MAIN_KEY, contain=False, minw=900), 30)
    if not mh:
        say("★ 主界面没出现")
        kill()
        return 1
    say("[主界面] 标题=%r 矩形=(%d,%d,%dx%d) 用时 %.1fs" % (mt, mx, my, mw, mhg, dt2))
    time.sleep(3.0)

    shot = app.primaryScreen().grabWindow(int(mh)).toImage()
    say("[截图] 客户区 %dx%d" % (shot.width(), shot.height()))
    ox, oy = client_origin(mh)

    # ---- 工具栏那一行：白色药丸最多的行 ----
    best = None
    for y in range(115, min(230, shot.height())):
        runs = [r for r in white_runs(shot, y, min_w=40) if 40 <= r[2] <= 620]
        if len(runs) >= 3 and (best is None or len(runs) > len(best[1])):
            best = (y, runs)
    if not best:
        say("★ 没找到工具栏按钮行")
        kill()
        return 1
    y, runs = best
    # 合并相邻很近的段（同一个药丸被文字切开的情况）
    merged = []
    for r in runs:
        if merged and r[0] - merged[-1][1] <= 6:
            merged[-1] = (merged[-1][0], r[1], r[1] - merged[-1][0] + 1)
        else:
            merged.append(list(r))
    say("[扫描] 工具栏 y=%d，白色块 %d 个:" % (y, len(merged)))
    for r in merged:
        say("        x %d..%d  宽 %d" % tuple(r))
    hdr = os.path.join(DIST, "exe验证_库存监听_0_工具栏.png")
    shot.copy(0, 0, shot.width(), int(shot.height() * 0.11)).save(hdr)
    say("[截图] %s" % hdr)

    # 说明: 右侧还有「推送设置 · 已开启」等更白的块 —— 逐个从右往左试，
    # 直到弹出的窗口标题含「库存监听 ·」为止（不靠猜下标，最稳）。
    tried = []
    ok = False
    opened = None
    for idx in range(len(merged) - 1, max(-1, len(merged) - 8), -1):
        r = merged[idx]
        cxx = (r[0] + r[1]) // 2
        tried.append((idx, cxx, r[2]))
        say("[落点] 试第 %d 块 x=%d 宽=%d" % (idx, cxx, r[2]))
        click(mh, ox + cxx, oy + y)
        time.sleep(1.3)
        wh, wt, *_w = wait(lambda: find(WATCH_KEY + " ·", minw=380), 4)
        if wh:
            ok = True
            opened = (wh, wt)
            break
        # 点到了别的弹窗 -> 关掉再来
        for kh, kt, *_ in windows():
            if any(k in kt for k in OTHER_KEYS) and kt != mt:
                say("        （误开了 %r，关掉继续）" % kt)
                user32.PostMessageW(kh, 0x0010, 0, 0)      # WM_CLOSE
                time.sleep(0.8)

    say("[尝试记录] %s" % tried)
    if not ok:
        say("★ 没点开库存监听弹窗")
        kill()
        return 1

    wh, wt = opened
    say("[弹窗] 标题=%r" % wt)
    time.sleep(1.5)
    p = os.path.join(DIST, "exe验证_库存监听_1_弹窗.png")
    app.primaryScreen().grabWindow(int(wh)).save(p)
    say("[截图] %s" % p)

    # 弹窗里的关键文案（用标题/尺寸确认渲染完整）
    r = wintypes.RECT()
    user32.GetWindowRect(int(wh), ctypes.byref(r))
    say("[弹窗矩形] %dx%d" % (r.right - r.left, r.bottom - r.top))

    user32.PostMessageW(wh, 0x0010, 0, 0)
    time.sleep(0.8)
    p3 = os.path.join(DIST, "exe验证_库存监听_2_关闭后.png")
    app.primaryScreen().grabWindow(int(mh)).save(p3)
    say("[截图] %s" % p3)

    kill()
    say("已关闭 exe")
    return 0


if __name__ == "__main__":
    try:
        rc = main()
    finally:
        with open(os.path.join(HERE, "_verify_watch.log"), "w",
                  encoding="utf-8") as f:
            f.write("\n".join(lines))
    sys.exit(rc)
