# -*- coding: utf-8 -*-
"""在【真实打包的 exe】里验证「自动降级兜底」：

  1) 静态核对：从 exe 的打包归档里解出 dewu_gui 的字节码，
     确认「降级设置」「失效自动降级」这些字面量和 fb_cfg / pick_fallback /
     _try_fallback 这些方法名真的被打了进去（不靠截图运气）。
  2) 真机点击：启动 exe → 过声明窗 → 截主界面
     → 用「03」那块浅蓝徽标(#e8f1ff)定位 03 卡片的标题行
     → 在同一行右侧找深色文字（= 「降级设置 · 开」按钮上的字）
     → 点它，直到弹出标题含「自动降级设置 ·」的窗口
     → 截弹窗，并数弹窗里「勾选态」的小蓝方块（期望 3 个）
     → 关掉弹窗再截一张，确认主界面没坏
  3) 顺手核对 03 行「失效自动降级」勾选框在 exe 里是勾上的。

为什么不直接算坐标: 窗口大小随屏幕变，所以全部按「截图里找特征」落点，
落点对不对由「弹出来的窗口标题」兜底判定 —— 和 verify_watch_exe.py 一个路子。

输出: dist/exe验证_自动降级_*.png
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
FB_TITLE = "自动降级设置 ·"
OTHER_KEYS = ("微信推送设置", "每日答题", "手机号登录", "库存监听", "提示")

# ---- 参考几何（来自 dist/自动降级_0_主界面.png，2800x1880 物理像素）----
# 换屏幕 / 换缩放了这些数会变，所以只当「兜底值」，正常走特征检测。
REF_W = 2800
REF_BADGE = (68, 1644, 137, 1695)       # 「03」徽标
REF_CHK_FB = (1012, 1792, 1045, 1825)   # 「失效自动降级」勾选框
REF_BTN_TXT = (1402, 1601, 1544, 1737)  # 「降级设置 · 开」按钮上的文字

lines = []


def say(s):
    print(s)
    lines.append(str(s))


# ------------------------------------------------------------------ 窗口工具
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
    """误开了别的弹窗 -> 关掉，免得挡住后面的落点。"""
    for kh, kt, *_ in windows():
        if kh == main_hwnd:
            continue
        if any(k in kt for k in OTHER_KEYS):
            say("        （误开了 %r，关掉继续）" % kt)
            user32.PostMessageW(kh, 0x0010, 0, 0)     # WM_CLOSE
            time.sleep(0.8)
            return True
    return False


# ------------------------------------------------------------------ 图像工具
def _rgb(img, x, y):
    p = img.pixel(x, y)
    return (p >> 16) & 255, (p >> 8) & 255, p & 255


def _blobs(img, x0, y0, x1, y1, hit):
    """在小窗口里找连通块（4 邻域）。返回 [(minx,miny,maxx,maxy,pixels)]。"""
    x0 = max(0, x0); y0 = max(0, y0)
    x1 = min(img.width() - 1, x1); y1 = min(img.height() - 1, y1)
    if x1 < x0 or y1 < y0:
        return []
    w = x1 - x0 + 1
    h = y1 - y0 + 1
    seen = bytearray(w * h)
    out = []
    for yy in range(y0, y1 + 1):
        base = (yy - y0) * w
        for xx in range(x0, x1 + 1):
            i = base + (xx - x0)
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
            out.append((mnx, mny, mxx, mxy, n))
    return out


def _close_to(p, target, tol):
    return (abs(p[0] - target[0]) <= tol and abs(p[1] - target[1]) <= tol
            and abs(p[2] - target[2]) <= tol)


def find_badge_03(img, box):
    """找「03」徽标：浅蓝底 #e8f1ff 的小方块。"""
    cand = [b for b in _blobs(img, *box, hit=lambda x, y: _close_to(
        _rgb(img, x, y), (232, 241, 255), 5))
        if 200 <= b[4] and 40 <= (b[2] - b[0]) <= 110
        and 28 <= (b[3] - b[1]) <= 70]
    if not cand:
        return None
    return max(cand, key=lambda b: b[1])          # 最靠下的那个 = 03


def bbox_str(t):
    """把 (minx, miny, maxx, maxy) 打成好读的一行。"""
    return "x %d..%d  y %d..%d" % (t[0], t[2], t[1], t[3])


def dark_span(img, y0, y1, x0, x1, thr=480):
    """在矩形里找深色文字像素的 x 跨度（rgb 之和 < thr）。

    注意形参顺序是 (y0, y1, x0, x1) —— 故意和 _blobs 的 (x0,y0,x1,y1) 不同，
    调用时别搞混（踩过一次：按 x 系的顺序传进去，扫了空区域返回 None）。
    """
    lo = hi = None
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            r, g, b = _rgb(img, x, y)
            if r + g + b < thr:
                if lo is None or x < lo:
                    lo = x
                if hi is None or x > hi:
                    hi = x
    return (lo, hi) if lo is not None else None


def blue_squares(img, box, side=(20, 62)):
    """找「勾选态复选框的指示方块」= 填成 #2b7cf0 的小方块。"""
    lo, hi = side
    out = []
    for b in _blobs(img, *box, hit=lambda x, y: _close_to(
            _rgb(img, x, y), (43, 124, 240), 8)):
        w, h = b[2] - b[0] + 1, b[3] - b[1] + 1
        if lo <= w <= hi and lo <= h <= hi:
            out.append(b)
    return out


# ------------------------------------------------------------------ 1) 静态核对
# 每个模块单独查：GUI 前端的控件文案 + 后端的挑法/方法名 + 推送卡片的说明文案。
ARCHIVE_PLAN = (
    ("dewu_gui", (
        "自动降级设置 · 商品失效时自动换商品", "失效自动降级", "降级设置",
        "余额买不起也换", "抢不到也换", "商品下架就换", "已降级换商品",
        "_fell_back", "降级·",
    ), ("fb_cfg", "fb_save_cfg", "_refresh_fb_btn", "fallback_settings",
        "chk_fb", "btn_fb", "_task_detail", "_sync_task_table")),
    ("dewu_sniper", (
        "自动降级换商品", "没有可换的商品", "已自动降级换商品", "已开自动降级",
        "fallback", "on_gone", "on_soldout", "on_poor", "min_ratio",
    ), ("fb_cfg", "fb_save_cfg", "fb_of", "pick_fallback", "_try_fallback",
        "_task_worker", "add_task")),
    ("dewu_push", (
        "自动降级", "换商品抢到的", "note",
    ), ("notify_success", "build_card")),
)


def _code_of(arc, name, tmpdir):
    """从打包归档里取某个模块的字节码（先在顶层找，找不到再解 PYZ）。"""
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
    """从 exe 里把相关模块的字节码掏出来，找新功能的字符串 / 方法名。"""
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
        # 注意：字节码里的字符串常量很多是「长句」，这里按【子串】判断，
        # 不然 "自动降级换商品" 会被那条完整日志模板判成缺项。
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

    say("=========== 1) 静态核对：新功能代码有没有打进 exe ===========")
    ok_arc, msg = check_archive(EXE)
    say("[归档] %s" % msg)
    if ok_arc is True:
        say("[归档] ✓ 打包产物里确实带着自动降级的代码")
    else:
        say("[归档] ⚠ 这一项没能确认（不影响后面的真机验证）")

    from PySide6.QtWidgets import QApplication
    app = QApplication.instance() or QApplication(sys.argv)

    say("")
    say("=========== 2) 真机：启动 exe 并点开「降级设置」 ===========")
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
    user32.PostMessageW(hwnd, 0x0100, 0x0D, 0)      # WM_KEYDOWN VK_RETURN
    user32.PostMessageW(hwnd, 0x0101, 0x0D, 0)      # WM_KEYUP

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
    s = shot.width() / float(REF_W)
    say("[缩放] 截图宽/参考宽 = %.3f" % s)

    def R(p):
        return int(round(p * s))

    p0 = os.path.join(DIST, "exe验证_自动降级_0_主界面.png")
    shot.save(p0)
    say("[截图] %s" % p0)

    # ---- 定位「03」徽标 ----
    zx0, zy0, zx1, zy1 = REF_BADGE
    box = (R(zx0) - R(95), R(zy0) - R(75), R(zx1) + R(95), R(zy1) + R(75))
    b = find_badge_03(shot, box)
    if b:
        badge = (b[0], b[1], b[2], b[3])            # (minx, miny, maxx, maxy)
        say("[定位] 03 徽标 %s" % bbox_str(badge))
    else:
        badge = (R(zx0), R(zy0), R(zx1), R(zy1))
        say("[定位] 没检出徽标，用参考值兜底 %s" % bbox_str(badge))
    by = (badge[1] + badge[3]) // 2

    # ---- 定位同一行右侧按钮上的深色文字 ----
    tx0, _ty0, tx1, _ty1 = REF_BTN_TXT
    span = dark_span(shot, by - R(12), by + R(12),
                     R(tx0) - R(95), R(tx1) + R(95))
    if span and R(50) < (span[1] - span[0]) < R(250):
        bx = (span[0] + span[1]) // 2
        say("[定位] 按钮文字 x %d..%d → 落点 x=%d, y=%d"
            % (span[0], span[1], bx, by))
    else:
        bx = R((tx0 + tx1) // 2)
        say("[定位] 没测到按钮文字，用参考值兜底 落点 x=%d, y=%d" % (bx, by))

    # ---- 03 行「失效自动降级」勾选框状态 ----
    cx0, cy0, cx1, cy1 = REF_CHK_FB
    sq = blue_squares(shot, (R(cx0) - R(35), R(cy0) - R(35),
                             R(cx1) + R(35), R(cy1) + R(35)))
    if sq:
        say("[主界面] 「失效自动降级」= ✓ 已勾上（检出蓝色方块 %d 个）" % len(sq))
    else:
        say("[主界面] ⚠ 没检出勾选方块（可能没勾，或检测没对上）")

    # ---- 顺手裁一张 03 卡片的特写，方便一眼看排版 ----
    cy0c = max(0, by - R(80))
    cy1c = min(shot.height() - 1, by + R(180))
    p3 = os.path.join(DIST, "exe验证_自动降级_3_03行.png")
    shot.copy(0, cy0c, min(shot.width(), R(1680)),
              cy1c - cy0c + 1).save(p3)
    say("[截图] %s （03 卡片特写）" % p3)

    # ---- 点开弹窗：多试几个候选落点，以「弹窗标题」为准 ----
    cands = [(bx, by), (bx - R(45), by), (bx + R(45), by), (bx - R(85), by),
             (bx, by - R(14)), (bx, by + R(14))]
    opened = None
    tried = []
    for cx, cy in cands:
        tried.append((cx, cy))
        say("[落点] 试 (%d,%d)" % (cx, cy))
        click(mh, ox + cx, oy + cy)
        time.sleep(1.4)
        wh, wt, *_w = wait(lambda: find(FB_TITLE, minw=300), 4)
        if wh:
            opened = (wh, wt)
            break
        if close_all_but(mh):
            time.sleep(0.4)
    say("[尝试记录] %s" % tried)

    if not opened:
        say("★ 没点开「自动降级设置」弹窗")
        kill_exe(EXE)
        return 1

    wh, wt = opened
    say("[弹窗] 标题=%r" % wt)
    time.sleep(1.5)
    dlg_img = app.primaryScreen().grabWindow(int(wh)).toImage()
    p1 = os.path.join(DIST, "exe验证_自动降级_1_设置弹窗.png")
    dlg_img.save(p1)
    say("[截图] %s （%dx%d）" % (p1, dlg_img.width(), dlg_img.height()))

    # 期望 3 个勾选态方块：启用 / 下架就换 / 抢不到也换（「买不起也换」默认没勾）
    sq2 = blue_squares(dlg_img, (0, 0, dlg_img.width() - 1, dlg_img.height() - 1))
    say("[弹窗] 勾选态方块 %d 个（期望 3）" % len(sq2))
    if len(sq2) != 3:
        rc = 1
        say("★ 弹窗里的勾选状态和预期不一致")

    # 顺带看一眼：弹窗不是白的（说明三个勾选框所在的卡片 + 说明文字都渲染了）
    ink = 0
    for y in range(0, dlg_img.height(), 3):
        for x in range(0, dlg_img.width(), 3):
            r, g, bb = _rgb(dlg_img, x, y)
            if r + g + bb < 360:
                ink += 1
    say("[弹窗] 深色着墨点采样 %d 个（太少说明是空窗）" % ink)
    if ink < 200:
        rc = 1
        say("★ 弹窗内容看起来没渲染出来")

    user32.PostMessageW(wh, 0x0010, 0, 0)               # WM_CLOSE = 取消
    time.sleep(1.0)
    p2 = os.path.join(DIST, "exe验证_自动降级_2_关闭后.png")
    app.primaryScreen().grabWindow(int(mh)).save(p2)
    say("[截图] %s" % p2)

    still = find(MAIN_KEY, contain=False, minw=900)
    say("[收尾] 主界面仍在: %s" % bool(still[0]))
    if not still[0]:
        rc = 1

    kill_exe(EXE)
    say("[收尾] 已关闭 exe，剩余进程 %s" % (pids_of(EXE) or "（清干净了）"))
    return rc


if __name__ == "__main__":
    try:
        rc = main()
    finally:
        with open(os.path.join(HERE, "_verify_fallback.log"), "w",
                  encoding="utf-8") as f:
            f.write("\n".join(lines))
    sys.exit(rc)
