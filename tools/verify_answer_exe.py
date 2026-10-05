# -*- coding: utf-8 -*-
"""
在真实 exe 里验证「每日答题」：
  启动 → 过声明 → 头部点「每日答题」→ 截弹窗（含真实题图）
  → 在答案框输入答案（SendInput Unicode，不依赖输入法）→ 点「一键答题」→ 截结果

落点方式同 click_push_btn.py：不算坐标，从截图里找白块/蓝块。
输出: dist/exe验证_答题*.png
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
ANS_KEY = "每日答题"

lines = []


def say(s):
    print(s)
    lines.append(str(s))


# ---------------- 窗口 ----------------
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
    subprocess.run(["taskkill", "/F", "/IM", "得物整点抢兑助手.exe"], capture_output=True)
    time.sleep(1.2)


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


# ---------------- 像素 ----------------
def white_runs(img, y, min_w=100, thr=246):
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


def is_blue(c):
    r_, g_, b_ = c.red(), c.green(), c.blue()
    return b_ > 180 and 20 <= r_ <= 130 and 80 <= g_ <= 195 and b_ - r_ > 90


def blue_button(img, y0, y1, min_run=120, max_run=700):
    """找实心蓝色主按钮（#2b7cf0）。

    坑：答案输入框聚焦后它的边框也是这个蓝色，而且是一条 ~1000px 长的细线，
    加上下边缘一共才几行 —— 只按「最长的蓝色连续段」会选到边框。
    所以按「连续行的块」打分：块高 × 块宽，实心按钮完胜细边框；
    同时排除过宽（> max_run，就是边框那种）的连续段。
    """
    rows = []
    for y in range(max(0, y0), min(y1, img.height())):
        xs = [x for x in range(0, img.width(), 2) if is_blue(img.pixelColor(x, y))]
        if not xs:
            continue
        runs, start, prev = [], xs[0], xs[0]
        for x in xs[1:]:
            if x - prev <= 6:
                prev = x
            else:
                runs.append((start, prev))
                start = prev = x
        runs.append((start, prev))
        cand = [r for r in runs if min_run <= r[1] - r[0] <= max_run]
        if cand:
            rows.append((y, max(cand, key=lambda r: r[1] - r[0])))
    if not rows:
        return None

    # 按 y 连续分组
    segs, cur = [], [rows[0]]
    for y, r in rows[1:]:
        if y - cur[-1][0] <= 2:
            cur.append((y, r))
        else:
            segs.append(cur)
            cur = [(y, r)]
    segs.append(cur)

    def score(seg):
        hh = seg[-1][0] - seg[0][0] + 1
        ww = max(r[1] - r[0] for _y, r in seg)
        return hh * ww

    seg = max(segs, key=score)
    ys = [y for y, _r in seg]
    cy = (min(ys) + max(ys)) // 2
    mid = min(seg, key=lambda t: abs(t[0] - cy))[1]
    return (mid[0] + mid[1]) // 2, cy, mid[1] - mid[0]


# ---------------- Unicode 输入 ----------------
class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD),
                ("wParamH", wintypes.WORD)]


class _U(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _U)]


def type_text(s):
    KEYEVENTF_UNICODE, KEYEVENTF_KEYUP = 0x0004, 0x0002
    for ch in s:
        for flags in (KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP):
            inp = INPUT(type=1, u=_U(ki=KEYBDINPUT(0, ord(ch), flags, 0, None)))
            user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
            time.sleep(0.03)
    time.sleep(0.3)


# ---------------- 主流程 ----------------
def main():
    from PySide6.QtWidgets import QApplication
    app = QApplication.instance() or QApplication(sys.argv)

    kill()
    subprocess.Popen([EXE], cwd=DIST)
    say("已启动 exe")

    hwnd, *_ , dt = wait(lambda: find(DLG_KEY))
    if not hwnd:
        say("★ 声明窗没出现")
        kill()
        return 1
    say("[声明窗] 出现，用时 %.1fs" % dt)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.4)
    user32.PostMessageW(hwnd, 0x0100, 0x0D, 0)
    user32.PostMessageW(hwnd, 0x0101, 0x0D, 0)

    mh, mt, mx, my, mw, mhg, dt2 = wait(lambda: find(MAIN_KEY, contain=False, minw=900), 30)
    if not mh:
        say("★ 主界面没出现")
        kill()
        return 1
    say("[主界面] 标题=%r 矩形=(%d,%d,%dx%d) 用时 %.1fs" % (mt, mx, my, mw, mhg, dt2))
    time.sleep(3.0)

    pm = app.primaryScreen().grabWindow(int(mh))
    shot = pm.toImage()
    say("[截图] 客户区 %dx%d" % (shot.width(), shot.height()))
    ox, oy = client_origin(mh)
    say("[客户区原点] 物理 (%d, %d)" % (ox, oy))

    # ---- 头部找按钮行：白块最多的一行，次右 = 每日答题（最右是推送设置）----
    best = None
    for y in range(115, min(190, shot.height())):
        runs = [r for r in white_runs(shot, y, min_w=110) if 110 <= r[2] <= 560]
        if len(runs) >= 2 and (best is None or len(runs) > len(best[1])):
            best = (y, runs)
    if not best:
        say("★ 头部没找到按钮行")
        kill()
        return 1
    y, runs = best
    say("[扫描] 按钮行 y=%d，白块 %d 个:" % (y, len(runs)))
    for r in runs:
        say("        x %d..%d  宽 %d" % r)
    hdr_png = os.path.join(DIST, "exe验证_答题_头部按钮.png")
    shot.copy(0, 0, shot.width(), int(shot.height() * 0.11)).save(hdr_png)
    say("[截图] %s" % hdr_png)

    if len(runs) < 2:
        say("★ 白块不足 2 个，无法定位「每日答题」")
        kill()
        return 1
    target = runs[-2]
    cx = (target[0] + target[1]) // 2
    say("[落点] 次右白块（每日答题）中心 = 截图内 (%d, %d)" % (cx, y))
    click(mh, ox + cx, oy + y)

    ah, at, *_ , dt3 = wait(lambda: find(ANS_KEY, minw=400), 15)
    if not ah:
        say("★ 没等到「每日答题」弹窗 —— 点击可能没命中")
        kill()
        return 1
    say("[弹窗] 标题=%r  用时 %.1fs" % (at, dt3))

    # 等题图加载（弹窗里出现大面积彩色像素）
    for _ in range(30):
        time.sleep(0.8)
        dpm = app.primaryScreen().grabWindow(int(ah))
        dimg = dpm.toImage()
        colored = 0
        for yy in range(int(dimg.height() * 0.10), int(dimg.height() * 0.45), 4):
            for xx in range(0, dimg.width(), 6):
                c = dimg.pixelColor(xx, yy)
                if abs(c.red() - c.green()) + abs(c.green() - c.blue()) > 60:
                    colored += 1
        if colored > 300:
            break
    p1 = os.path.join(DIST, "exe验证_答题_题目.png")
    dpm.save(p1)
    say("[截图] %s  %dx%d（彩色像素 %d，说明题图已渲染）" % (p1, dpm.width(), dpm.height(), colored))

    dox, doy = client_origin(ah)
    dimg = dpm.toImage()

    # ---- 点答案输入框：中段最宽的白条 ----
    box = None
    for yy in range(int(dimg.height() * 0.48), int(dimg.height() * 0.68)):
        rr = white_runs(dimg, yy, min_w=int(dimg.width() * 0.35))
        if rr:
            w0 = max(rr, key=lambda r: r[2])
            if box is None or w0[2] > box[0][2]:
                box = (w0, yy)
    typed = False
    if box:
        (x0, x1, ww), yy = box
        cxx = (x0 + x1) // 2
        say("[输入框] 截图内 (%d, %d) 宽 %d" % (cxx, yy, ww))
        click(ah, dox + cxx, doy + yy)
        type_text("导盲犬")
        typed = True
        time.sleep(0.6)
        p2 = os.path.join(DIST, "exe验证_答题_填答案.png")
        app.primaryScreen().grabWindow(int(ah)).save(p2)
        say("[截图] %s（已用 Unicode 键入答案）" % p2)
    else:
        say("★ 没找到答案输入框")

    # ---- 点「一键答题」（蓝块）----
    dpm = app.primaryScreen().grabWindow(int(ah))
    dimg = dpm.toImage()
    bb = blue_button(dimg, int(dimg.height() * 0.40), int(dimg.height() * 0.80))
    if not bb:
        say("★ 没找到蓝色「一键答题」按钮")
        kill()
        return 1
    bx, by, bw = bb
    say("[落点] 一键答题 截图内 (%d, %d) 宽 %d" % (bx, by, bw))
    click(ah, dox + bx, doy + by)

    say("已点「一键答题」，等 25 秒看结果…")
    time.sleep(25.0)
    p3 = os.path.join(DIST, "exe验证_答题_结果.png")
    app.primaryScreen().grabWindow(int(ah)).save(p3)
    say("[截图] %s" % p3)

    # 统计结果区颜色（绿=答对 / 红=答错 / 灰=已答过）
    img3 = app.primaryScreen().grabWindow(int(ah)).toImage()
    g = r_ = gray = 0
    for yy in range(int(img3.height() * 0.70), int(img3.height() * 0.95), 2):
        for xx in range(0, img3.width(), 2):
            c = img3.pixelColor(xx, yy)
            cr, cg, cb = c.red(), c.green(), c.blue()
            if cg > 110 and cr < 110 and cg - cr > 45 and cg - cb > 25:
                g += 1
            elif cr > 150 and cg < 110 and cr - cg > 70:
                r_ += 1
            elif 100 < cr < 200 and abs(cr - cg) < 12 and abs(cg - cb) < 20:
                gray += 1
    say("[结果色] 绿=%d 红=%d 灰=%d" % (g, r_, gray))

    kill()
    say("已关闭 exe")
    return 0


if __name__ == "__main__":
    try:
        rc = main()
    except Exception:
        import traceback
        say(traceback.format_exc())
        rc = 1
    finally:
        with open(os.path.join(HERE, "_verify_answer.log"), "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
    sys.exit(rc)
