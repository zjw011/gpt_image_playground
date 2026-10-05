# -*- coding: utf-8 -*-
"""在【真实打包的 exe】里验证「群发到群组」：

  1) 静态核对：从 exe 归档里解出 dewu_gui / dewu_push 的字节码，
     确认群发相关的字面量和方法名都打进去了。
  2) 真机：启动 exe → 过声明窗 → 截主界面 → 扫工具栏那一行白药丸
     → 从右往左试，直到弹出标题含「PushPlus」的窗口
     → 截弹窗，数一下「勾选态小蓝方块」是不是 4 个
       （开启推送 / 失败也推送 / 库存变化也群发 / 也私发我一份）
     → 关掉再截一张确认主界面没坏。

★ 本脚本**不会**往群里发任何消息 —— 群里可能有别人，发测试消息应该由用户
  自己在软件里点「发送测试」决定。

输出: dist/exe验证_群发_*.png
"""
import ctypes
import marshal
import os
import subprocess
import sys
import time
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
os.chdir(HERE)
sys.path.insert(0, HERE)

from procutil import kill as kill_exe, pids_of          # noqa: E402

DIST = os.path.join(ROOT, "dist")
EXE = os.path.join(DIST, "得物整点抢兑助手.exe")

user32 = ctypes.windll.user32
DLG_KEY = "使用声明与免责条款"
MAIN_KEY = "得物整点抢兑助手"
PUSH_KEY = "PushPlus"
OTHER_KEYS = ("每日答题", "手机号登录", "库存监听", "提示")

lines = []


def say(s):
    print(s)
    lines.append(str(s))


# ------------------------------------------------------------------ 窗口
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


def close_all_but(main_hwnd):
    for kh, kt, *_ in windows():
        if kh == main_hwnd:
            continue
        if any(k in kt for k in OTHER_KEYS):
            say("        （误开了 %r，关掉继续）" % kt)
            user32.PostMessageW(kh, 0x0010, 0, 0)
            time.sleep(0.8)
            return True
    return False


# ------------------------------------------------------------------ 图像
def _rgb(img, x, y):
    p = img.pixel(x, y)
    return (p >> 16) & 255, (p >> 8) & 255, p & 255


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


def blue_squares(img, box, tol=8, side=(20, 62)):
    """找「勾选态复选框的指示方块」= 填成 #2b7cf0 的小方块。"""
    x0, y0, x1, y1 = box
    x0 = max(0, x0); y0 = max(0, y0)
    x1 = min(img.width() - 1, x1); y1 = min(img.height() - 1, y1)
    w = x1 - x0 + 1
    seen = bytearray(w * (y1 - y0 + 1))
    lo, hi = side
    found = []

    def hit(x, y):
        r, g, b = _rgb(img, x, y)
        return abs(r - 43) <= tol and abs(g - 124) <= tol and abs(b - 240) <= tol

    for yy in range(y0, y1 + 1):
        for xx in range(x0, x1 + 1):
            i = (yy - y0) * w + (xx - x0)
            if seen[i] or not hit(xx, yy):
                continue
            stack = [(xx, yy)]
            seen[i] = 1
            n = 0
            mnx = mxx = xx
            mny = mxy = yy
            while stack:
                cx, cy = stack.pop()
                n += 1
                if cx < mnx: mnx = cx
                if cx > mxx: mxx = cx
                if cy < mny: mny = cy
                if cy > mxy: mxy = cy
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = cx + dx, cy + dy
                    if not (x0 <= nx <= x1 and y0 <= ny <= y1):
                        continue
                    j = (ny - y0) * w + (nx - x0)
                    if not seen[j] and hit(nx, ny):
                        seen[j] = 1
                        stack.append((nx, ny))
            bw, bh = mxx - mnx + 1, mxy - mny + 1
            if lo <= bw <= hi and lo <= bh <= hi:
                found.append((mnx, mny, mxx, mxy, n))
    return found


# ------------------------------------------------------------------ 静态核对
ARCHIVE_PLAN = (
    ("dewu_push", (
        "topic", "group_stock", "group_self_too",
        "群发", "私发", "库存变化",
    ), ("clean_topic", "group_on", "group_summary", "send_stock",
        "notify_stock", "notify_test")),
    ("dewu_gui", (
        "群组编码", "库存变化也群发到群组", "群发之外，也私发我一份",
        "群组管理",
    ), ("group_summary", "clean_topic")),
)


def _code_of(arc, name, tmpdir):
    from PyInstaller.archive.readers import ZlibArchiveReader
    toc = arc.toc
    if name in toc:
        return arc.extract(name), "顶层归档"
    entry = next((n for n in toc
                  if os.path.basename(n).lower().endswith(".pyz")), None)
    if entry is None:
        return None, "没有 .pyz"
    raw = arc.extract(entry)
    if raw is None:
        return None, "解不出 %s" % entry
    tmp = os.path.join(tmpdir, "_%s_probe.pyz" % name)
    with open(tmp, "wb") as f:
        f.write(raw)
    try:
        return ZlibArchiveReader(tmp).extract(name), os.path.basename(entry)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def check_archive(exe):
    try:
        from PyInstaller.archive.readers import CArchiveReader
    except Exception as e:                                # noqa: BLE001
        return None, "没装 PyInstaller，跳过（%s）" % e
    try:
        arc = CArchiveReader(exe)
    except Exception as e:                                # noqa: BLE001
        return None, "打不开归档: %r" % (e,)

    all_ok = True
    parts = []
    for mod, want_str, want_name in ARCHIVE_PLAN:
        try:
            code, how = _code_of(arc, mod, HERE)
        except Exception as e:                            # noqa: BLE001
            all_ok = False
            parts.append("  %-12s ✗ 取不出来: %r" % (mod, e))
            continue
        if code is None:
            all_ok = False
            parts.append("  %-12s ✗ 归档里没有（%s）" % (mod, how))
            continue
        if isinstance(code, (bytes, bytearray)):
            code = marshal.loads(code)
        strs, names = set(), set()

        def walk(co, depth=0):
            if depth > 14 or not hasattr(co, "co_consts"):
                return
            names.update(co.co_names)
            for c in co.co_consts:
                if isinstance(c, str):
                    strs.add(c)
                elif hasattr(c, "co_consts"):
                    walk(c, depth + 1)

        walk(code)
        miss_s = [w for w in want_str if not any(w in s for s in strs)]
        miss_n = [n for n in want_name if n not in names]
        ok = not miss_s and not miss_n
        all_ok = all_ok and ok
        parts.append("  %-12s %s 字面量 %d/%d  方法名 %d/%d  ← %s" % (
            mod, "✓" if ok else "✗",
            len(want_str) - len(miss_s), len(want_str),
            len(want_name) - len(miss_n), len(want_name), how))
        if miss_s:
            parts.append("              缺字面量: %s" % miss_s)
        if miss_n:
            parts.append("              缺方法名: %s" % miss_n)
    return all_ok, "\n".join(parts)


# ------------------------------------------------------------------ main
def main():
    rc = 0

    say("=========== 1) 静态核对：群发代码有没有打进 exe ===========")
    ok_arc, msg = check_archive(EXE)
    say("[归档] %s" % msg)
    if ok_arc is not True:
        rc = 1
        say("★ 归档核对没过")
    else:
        say("[归档] ✓ 打包产物里确实带着群发的代码")

    from PySide6.QtWidgets import QApplication
    app = QApplication.instance() or QApplication(sys.argv)

    say("")
    say("=========== 2) 真机：打开「推送设置」看群组控件 ===========")
    killed = kill_exe(EXE)
    if killed:
        say("[清理] 先杀掉了残留进程 %s" % killed)
    subprocess.Popen([EXE], cwd=DIST)
    say("已启动 exe")

    hwnd, _t, *_x, dt = wait(lambda: find(DLG_KEY))
    if not hwnd:
        say("★ 声明窗没出现")
        kill_exe(EXE)
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
        kill_exe(EXE)
        return 1
    say("[主界面] 标题=%r 矩形=(%d,%d,%dx%d) 用时 %.1fs" % (mt, mx, my, mw, mhg, dt2))
    time.sleep(3.0)

    shot = app.primaryScreen().grabWindow(int(mh)).toImage()
    say("[截图] 客户区 %dx%d" % (shot.width(), shot.height()))
    ox, oy = client_origin(mh)
    p0 = os.path.join(DIST, "exe验证_群发_0_主界面.png")
    shot.save(p0)
    say("[截图] %s" % p0)

    # ---- 工具栏那一行：白色药丸最多的行 ----
    best = None
    for y in range(115, min(230, shot.height())):
        runs = [r for r in white_runs(shot, y, min_w=40) if 40 <= r[2] <= 620]
        if len(runs) >= 3 and (best is None or len(runs) > len(best[1])):
            best = (y, runs)
    if not best:
        say("★ 没找到工具栏按钮行")
        kill_exe(EXE)
        return 1
    y, runs = best
    merged = []
    for r in runs:
        if merged and r[0] - merged[-1][1] <= 6:
            merged[-1] = (merged[-1][0], r[1], r[1] - merged[-1][0] + 1)
        else:
            merged.append(list(r))
    hdr = os.path.join(DIST, "exe验证_群发_1_工具栏.png")
    shot.copy(0, 0, shot.width(), int(shot.height() * 0.11)).save(hdr)
    say("[扫描] 工具栏 y=%d，白色块 %d 个:" % (y, len(merged)))
    for i, r in enumerate(merged):
        say("         #%d x %d..%d 宽 %d 中心 %d" % (i, r[0], r[1], r[2], (r[0] + r[1]) // 2))

    # ---- ★ 标题栏预热点击 ----
    # Windows 有「前台锁」：如果目标窗口不是当前前台窗口，**第一次点击只会
    # 把窗口激活**，消息不会传给控件 —— 表现就是「点了没反应」。
    # 先在标题栏点一下（标题栏不属于任何控件，点了绝对安全），
    # 让窗口成为前台，后面的点击才会真的落到按钮上。
    user32.SetForegroundWindow(mh)
    time.sleep(0.3)
    click(mh, ox + shot.width() // 2, oy - 32)      # 标题栏中部
    time.sleep(0.6)
    say("[预热] 已在标题栏点了一下，确保窗口是前台（否则首次点击会被前台锁吃掉）")

    opened = None
    tried = []
    for idx in range(len(merged) - 1, max(-1, len(merged) - 6), -1):
        r = merged[idx]
        cxx = (r[0] + r[1]) // 2
        tried.append((idx, cxx, r[2]))
        for attempt in (1, 2):
            say("[落点] 试第 %d 块 x=%d 宽=%d（第 %d 次）" % (idx, cxx, r[2], attempt))
            click(mh, ox + cxx, oy + y)
            time.sleep(1.3)
            wh, wt, *_w = wait(lambda: find(PUSH_KEY, minw=380), 3)
            if wh:
                opened = (wh, wt)
                break
            if close_all_but(mh):
                time.sleep(0.4)
                break
        if opened:
            break
    say("[尝试记录] %s" % tried)

    if not opened:
        say("★ 没点开推送设置弹窗")
        kill_exe(EXE)
        return 1

    wh, wt = opened
    say("[弹窗] 标题=%r" % wt)
    time.sleep(1.5)
    dlg = app.primaryScreen().grabWindow(int(wh)).toImage()
    p1 = os.path.join(DIST, "exe验证_群发_2_设置弹窗.png")
    dlg.save(p1)
    say("[截图] %s （%dx%d）" % (p1, dlg.width(), dlg.height()))

    # 4 个勾选态方块：开启推送 / 失败也推送 / 库存变化也群发 / 也私发我一份
    sq = blue_squares(dlg, (0, 0, dlg.width() - 1, dlg.height() - 1))
    say("[弹窗] 勾选态方块 %d 个（期望 ≥4）" % len(sq))
    for b in sq:
        say("        方块 x %d..%d y %d..%d" % (b[0], b[2], b[1], b[3]))
    if len(sq) < 4:
        rc = 1
        say("★ 勾选框数量比预期少（群组那两个可能没渲染出来）")

    ink = sum(1 for yy in range(0, dlg.height(), 3)
              for xx in range(0, dlg.width(), 3)
              if sum(_rgb(dlg, xx, yy)) < 360)
    say("[弹窗] 深色着墨点采样 %d 个（太少说明是空窗）" % ink)
    if ink < 200:
        rc = 1
        say("★ 弹窗内容看起来没渲染出来")

    user32.PostMessageW(wh, 0x0010, 0, 0)
    time.sleep(1.0)
    p2 = os.path.join(DIST, "exe验证_群发_3_关闭后.png")
    app.primaryScreen().grabWindow(int(mh)).save(p2)
    say("[截图] %s" % p2)

    still = find(MAIN_KEY, contain=False, minw=900)
    say("[收尾] 主界面仍在: %s" % bool(still[0]))
    if not still[0]:
        rc = 1

    kill_exe(EXE)
    say("[收尾] 已关闭 exe，剩余进程 %s" % (pids_of(EXE) or "（清干净了）"))
    say("[注意] 本脚本没往群里发任何消息；要不要发测试由你自己点「发送测试」决定")
    return rc


if __name__ == "__main__":
    try:
        rc = main()
    finally:
        with open(os.path.join(HERE, "_verify_group.log"), "w",
                  encoding="utf-8") as f:
            f.write("\n".join(lines))
    sys.exit(rc)
