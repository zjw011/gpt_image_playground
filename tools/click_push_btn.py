# -*- coding: utf-8 -*-
"""
在真实 exe 里点开「推送设置」弹窗，并截图存证。

为什么不能算坐标：Qt 的布局宽度依赖字体度量，离屏渲染和真机渲染算出来的按钮位置
能差一百多逻辑像素（实测差 ~125px）。所以改成「从截图里找那个白色按钮块」：
  header 里的 mini 按钮是近白色圆角块，底色是浅蓝 —— 沿按钮所在那一行扫描
  近白像素的连续段，取最右边那一段就是「推送设置」（它右边只剩分隔线和时钟）。

落点换算：窗口客户区 1400x940 逻辑 @DPR2 = 2800x1880 物理，
grabWindow 出的图就是客户区的物理像素图 → 屏幕坐标 = ClientToScreen(客户区原点) + 截图内坐标。

输出: dist/exe验证_推送设置弹窗.png
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
OUT_PNG = os.path.join(DIST, "exe验证_推送设置弹窗.png")

user32 = ctypes.windll.user32
DLG_KEY = "使用声明与免责条款"
MAIN_KEY = "得物整点抢兑助手"
PUSH_KEY = "PushPlus"

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
                out.append((hwnd, buf.value, r.left, r.top,
                            r.right - r.left, r.bottom - r.top))
        return True

    user32.EnumWindows(cb, 0)
    return out


def find(key, contain=True, minw=300):
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
    subprocess.run(["taskkill", "/F", "/IM", "得物整点抢兑助手.exe"],
                   capture_output=True)
    time.sleep(1.0)


def white_runs(img, y, min_w=120, thr=246):
    """在 y 这一行上找「近白像素」的连续段，返回 [(x0,x1,width), ...]"""
    runs, start = [], None
    for x in range(img.width()):
        c = img.pixelColor(x, y)
        is_white = (c.red() >= thr and c.green() >= thr and c.blue() >= thr)
        if is_white and start is None:
            start = x
        elif not is_white and start is not None:
            if x - start >= min_w:
                runs.append((start, x - 1, x - start))
            start = None
    if start is not None and img.width() - start >= min_w:
        runs.append((start, img.width() - 1, img.width() - start))
    return runs


def main():
    from PySide6.QtWidgets import QApplication
    from PySide6.QtGui import QImage
    app = QApplication.instance() or QApplication(sys.argv)

    kill()
    subprocess.Popen([EXE], cwd=DIST)
    say("已启动 exe")

    hwnd, title, *_, dt = wait(lambda: find(DLG_KEY))
    if not hwnd:
        say("★ 声明窗没出现")
        kill()
        return 1
    say("[声明窗] 已出现，用时 %.1fs" % dt)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.4)
    user32.PostMessageW(hwnd, 0x0100, 0x0D, 0)
    user32.PostMessageW(hwnd, 0x0101, 0x0D, 0)

    mh, mt, mx, my, mw, mhgt, dt2 = wait(
        lambda: find(MAIN_KEY, contain=False, minw=900), 25)
    if not mh:
        say("★ 主界面没出现")
        kill()
        return 1
    say("[主界面] 标题=%r 窗口矩形=(%d,%d,%dx%d) 用时 %.1fs"
        % (mt, mx, my, mw, mhgt, dt2))
    time.sleep(3.0)

    pm = app.primaryScreen().grabWindow(int(mh))
    say("[截图] 客户区 %dx%d" % (pm.width(), pm.height()))

    # 客户区原点(物理屏幕坐标)
    pt = wintypes.POINT(0, 0)
    user32.ClientToScreen(int(mh), ctypes.byref(pt))
    say("[客户区原点] 屏幕物理坐标 = (%d, %d)" % (pt.x, pt.y))

    # 找按钮所在行：
    #   header 里这一行会有好几个近白圆角块（适配窗口 / NTP / 校时 / 推送设置），
    #   而卡片顶边那一行只有 2 个超宽白块。所以判据是「宽度落在按钮尺寸区间的白块个数最多」，
    #   取其中的最右一块 —— 它右边只剩 1px 分隔线和时钟。
    shot = pm.toImage()
    best = None
    for y in range(115, min(185, shot.height())):
        runs = [r for r in white_runs(shot, y, min_w=110) if 110 <= r[2] <= 520]
        if len(runs) >= 2 and (best is None or len(runs) > len(best[1])):
            best = (y, runs)
    if not best:
        # 兜底：放宽宽度限制
        for y in range(115, min(185, shot.height())):
            runs = white_runs(shot, y, min_w=110)
            if len(runs) >= 2:
                best = (y, runs)
                break
    if not best:
        say("★ 在头部没找到按钮行")
        kill()
        return 1

    y, runs = best
    say("[扫描] 按钮行 y=%d，白块:" % y)
    for r in runs:
        say("        x %d..%d  宽 %d" % r)
    last = runs[-1]
    cx_dev = (last[0] + last[1]) // 2
    say("[落点] 取最右那段（推送设置）中心 = 截图内 (%d, %d)" % (cx_dev, y))

    sx, sy = pt.x + cx_dev, pt.y + y
    say("[落点] 换算成屏幕物理坐标 = (%d, %d)" % (sx, sy))

    user32.SetForegroundWindow(mh)
    time.sleep(0.4)
    user32.SetCursorPos(sx, sy)
    time.sleep(0.3)
    user32.mouse_event(0x0002, 0, 0, 0, 0)   # LEFTDOWN
    time.sleep(0.08)
    user32.mouse_event(0x0004, 0, 0, 0, 0)   # LEFTUP
    say("已点击")

    dh, dtit, *_, dt3 = wait(lambda: find(PUSH_KEY, minw=300), 12)
    if not dh:
        say("★ 没等到「%s」弹窗 —— 点击可能没命中" % PUSH_KEY)
        kill()
        return 1
    say("[弹窗] 找到 %r  用时 %.1fs" % (dtit, dt3))
    time.sleep(1.5)
    dpm = app.primaryScreen().grabWindow(int(dh))
    dpm.save(OUT_PNG)
    say("[截图] %s  %dx%d" % (OUT_PNG, dpm.width(), dpm.height()))

    # ---------- 继续点弹窗里的「发送测试」，把 调用pushplus 这一步也真跑一遍 ----------
    dpt = wintypes.POINT(0, 0)
    user32.ClientToScreen(int(dh), ctypes.byref(dpt))
    dimg = dpm.toImage()
    # 按钮行在弹窗底部：从下往上找第一行「至少两个近白块」的
    row = None
    for y in range(dimg.height() - 1, int(dimg.height() * 0.6), -1):
        rr = [r for r in white_runs(dimg, y, min_w=60) if r[2] <= 400]
        if len(rr) >= 2:
            row = (y, rr)
            break
    if not row:
        say("★ 弹窗里没找到按钮行，跳过测试发送")
        kill()
        return 1

    y2, rr = row
    say("[弹窗按钮行] y=%d:" % y2)
    for r in rr:
        say("        x %d..%d  宽 %d" % r)
    # 「保存」是蓝底(不是白)，所以最左边那个白块就是「发送测试」
    target = rr[0]
    cx2 = (target[0] + target[1]) // 2
    sx2, sy2 = dpt.x + cx2, dpt.y + y2
    say("[落点] 发送测试 屏幕物理坐标 = (%d, %d)" % (sx2, sy2))

    user32.SetForegroundWindow(dh)
    time.sleep(0.3)
    user32.SetCursorPos(sx2, sy2)
    time.sleep(0.3)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.08)
    user32.mouse_event(0x0004, 0, 0, 0, 0)
    say("已点击「发送测试」，等 6 秒看返回…")
    time.sleep(6.0)

    dpm2 = app.primaryScreen().grabWindow(int(dh))
    out2 = os.path.join(DIST, "exe验证_推送设置_测试发送.png")
    dpm2.save(out2)
    say("[截图] %s  %dx%d" % (out2, dpm2.width(), dpm2.height()))

    # 状态行会变成绿色(成功)或红色(失败)：扫一下像素判个色
    img2 = dpm2.toImage()
    green = red = 0
    for yy in range(int(img2.height() * 0.55), int(img2.height() * 0.92)):
        for xx in range(0, img2.width(), 2):
            c = img2.pixelColor(xx, yy)
            r_, g_, b_ = c.red(), c.green(), c.blue()
            if g_ > 110 and r_ < 110 and g_ - r_ > 50 and g_ - b_ > 30:
                green += 1
            elif r_ > 150 and g_ < 110 and r_ - g_ > 70:
                red += 1
    say("[状态色] 绿色像素=%d  红色像素=%d" % (green, red))
    say("[判定] %s" % ("成功提示（绿）" if green > 5 else
                       ("失败提示（红）" if red > 5 else "没看出颜色变化")))

    kill()
    say("已关闭 exe")
    return 0


if __name__ == "__main__":
    try:
        rc = main()
    finally:
        with open(os.path.join(HERE, "_click_push.log"), "w",
                  encoding="utf-8") as f:
            f.write("\n".join(lines))
    sys.exit(rc)
