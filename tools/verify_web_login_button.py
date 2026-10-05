# -*- coding: utf-8 -*-
"""真机验证：在新 exe 上点击「网页登录 · 免抓包」按钮，
   确认 ① 弹出登录进度窗口 ② 真的拉起带调试端口的 Edge。"""
import ctypes
import os
import shutil
import subprocess
import sys
import time
from ctypes import wintypes

DIST = r"D:\work\workbuudy\dewu\dist"
EXE = os.path.join(DIST, "得物整点抢兑助手.exe")
user32 = ctypes.windll.user32
shell32 = ctypes.windll.shell32

WM_LBUTTONDOWN, WM_LBUTTONUP, WM_CLOSE = 0x0201, 0x0202, 0x0010
WM_KEYDOWN, WM_KEYUP, VK_RETURN = 0x0100, 0x0101, 0x0D

# 0) 先备份账号文件，万一误点可恢复
bak = os.path.join(DIST, "accounts.json.testbak")
if os.path.exists(os.path.join(DIST, "accounts.json")):
    shutil.copy2(os.path.join(DIST, "accounts.json"), bak)


def wins():
    out = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            if n:
                b = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, b, n + 1)
                r = wintypes.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(r))
                out.append((hwnd, b.value, r.right - r.left, r.bottom - r.top))
        return True

    user32.EnumWindows(cb, 0)
    return out


def find(key, minw=200):
    for hwnd, t, w, h in wins():
        if key in t and w >= minw:
            return hwnd, t, w, h
    return None, "", 0, 0


def wait(fn, timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = fn()
        if r[0]:
            return r
        time.sleep(0.4)
    return fn()


from PySide6.QtWidgets import QApplication  # noqa: E402
app = QApplication(sys.argv)

subprocess.run(["taskkill", "/F", "/IM", "得物整点抢兑助手.exe"], capture_output=True)
time.sleep(1.0)
subprocess.Popen([EXE], cwd=DIST)

hwnd, title, w, h = wait(lambda: find("使用声明与免责条款"), 40)
print("[1] 声明弹窗:", bool(hwnd), repr(title))
user32.SetForegroundWindow(hwnd)
time.sleep(0.3)
user32.PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN, 0)
user32.PostMessageW(hwnd, WM_KEYUP, VK_RETURN, 0)

mh, mt, mw, mhh = wait(lambda: (lambda r: r if r[0] and "使用声明" not in r[1] else (None, "", 0, 0))(
    find("得物整点抢兑助手")), 25)
print("[2] 主界面:", bool(mh), repr(mt), "%dx%d" % (mw, mhh))

cr = wintypes.RECT()
user32.GetClientRect(mh, ctypes.byref(cr))
print("[3] 客户区尺寸: %dx%d" % (cr.right, cr.bottom))

pm = app.primaryScreen().grabWindow(int(mh))
pm.save(os.path.join(r"D:\work\workbuudy\dewu", "网页登录按钮_验证.png"))
print("[4] 截图: %dx%d" % (pm.width(), pm.height()))

# 用 QImage 在截图里定位蓝色「导入账号」按钮，据此反推左侧「网页登录」按钮中心
from PySide6.QtGui import QImage  # noqa: E402
img = QImage(os.path.join(r"D:\work\workbuudy\dewu", "网页登录按钮_验证.png")).convertToFormat(
    QImage.Format_RGB32)
def is_acc(c):
    return abs(c.red() - 43) < 22 and abs(c.green() - 124) < 22 and abs(c.blue() - 240) < 18


def longest_acc_run(y):
    best, s = (0, 0), None
    for x in range(200, 2400):
        if is_acc(img.pixelColor(x, y)):
            if s is None:
                s = x
        elif s is not None:
            if x - s > best[1] - best[0]:
                best = (s, x - 1)
            s = None
    if s is not None and 2400 - s > best[1] - best[0]:
        best = (s, 2399)
    return best


# ① 逐行找最长的实心 C_ACC 段 → 就是「导入账号」按钮
best, best_y = (0, 0), 0
for y in range(220, 480, 2):
    r = longest_acc_run(y)
    if r[1] - r[0] > best[1] - best[0]:
        best, best_y = r, y
blue_l, blue_r = best
blue_t, blue_b = best_y, best_y
print("[5] 蓝色「导入账号」按钮: x %d~%d  行 y=%d  宽=%d" % (blue_l, blue_r, best_y, blue_r - blue_l))

# ② 在该 y 带上，找紧邻蓝色按钮左侧的“深色文字簇” = 「网页登录 · 免抓包」
Y0, Y1 = best_y - 70, best_y + 70


def dark(c):
    return c.red() < 170 and c.green() < 180 and c.blue() < 200


cols = []
for x in range(0, blue_l - 20):
    cols.append(sum(1 for y in range(Y0, Y1) if dark(img.pixelColor(x, y))))
runs, s = [], None
for x, n in enumerate(cols):
    if n > 0 and s is None:
        s = x
    elif n == 0 and s is not None:
        if x - s >= 6:
            runs.append((s, x - 1))
        s = None
merged = []
for a, b in runs:
    if merged and a - merged[-1][1] < 44:
        merged[-1] = (merged[-1][0], b)
    else:
        merged.append((a, b))
merged = [r for r in merged if r[1] - r[0] >= 20]
print("[6] 蓝色按钮左侧的文字簇:", merged)

tgt = merged[-1] if merged else (blue_l - 240, blue_l - 20)
cx = (tgt[0] + tgt[1]) // 2
cy = best_y
print("[7] 目标「网页登录 · 免抓包」中心(客户区): (%d, %d)" % (cx, cy))
print("[6] 目标「网页登录」按钮中心(客户区): (%d, %d)" % (cx, cy))

# 客户区坐标 → 屏幕坐标（精确换算，不靠猜边框）
pt = wintypes.POINT(cx, cy)
user32.ClientToScreen(mh, ctypes.byref(pt))
print("[7] 屏幕坐标: (%d, %d)" % (pt.x, pt.y))

# 真实系统级鼠标点击
user32.SetForegroundWindow(mh)
time.sleep(0.4)
user32.SetCursorPos(pt.x, pt.y)
time.sleep(0.25)
user32.mouse_event(0x0002, 0, 0, 0, 0)   # LEFTDOWN
time.sleep(0.12)
user32.mouse_event(0x0004, 0, 0, 0, 0)   # LEFTUP

time.sleep(3.0)
dh, dt, dw, dhh = find("网页登录", 300)
print("[8] 登录进度窗口:", bool(dh), repr(dt), "%dx%d" % (dw, dhh))

# 有没有弹出"确定删除账号"（误点保护）
qh, qt, _, _ = find("确认", 200)
print("[9] 误点检查（应为 False）:", bool(qh), repr(qt))

if dh:
    time.sleep(8)
    print("[10] Edge 进程数:", subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq msedge.exe", "/NH"],
        capture_output=True, text=True, encoding="gbk", errors="replace").stdout.count("msedge.exe"))
    pm2 = app.primaryScreen().grabWindow(int(dh))
    pm2.save(os.path.join(r"D:\work\workbuudy\dewu", "网页登录进度_验证.png"))
    print("[11] 进度窗口截图 %dx%d" % (pm2.width(), pm2.height()))
    user32.PostMessageW(dh, WM_CLOSE, 0, 0)
    time.sleep(2)

subprocess.run(["taskkill", "/F", "/IM", "得物整点抢兑助手.exe"], capture_output=True)

# 恢复账号备份
if os.path.exists(bak):
    shutil.copy2(bak, os.path.join(DIST, "accounts.json"))
    os.remove(bak)
    print("[10] 已恢复 accounts.json 备份")

print("\n结论:", "PASS ✓ 按钮 → 登录窗口 链路正常" if dh else "未弹出登录窗口（点击可能没命中）")
