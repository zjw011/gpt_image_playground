# -*- coding: utf-8 -*-
"""在**真实 exe** 里验证「代理 IP 池」，而不是只看打包成功。

三道闸，任何一道过不了都要说话：

  A. 静态核对：把 exe 里对应的字节码掏出来，查「代理」相关的字面量和方法名 ——
     证明代码真的打进包里了（PySide6 打包最容易的就是"源码有、exe 里没有"）。
  B. 真机 GUI：启动 exe → 过声明窗 → 截主界面（确认工具栏多出「代理 IP」）→
     点开弹窗 → 截弹窗。
  C. 真机功能：在弹窗里**用剪贴板真粘两行代理进去 → 点「导入」**，
     然后去读 exe 自己的 `dist/config.json`，断言那两个代理真的落库了。
     （光看截图找特征太弱，这一步是确定性的。）

收尾会把 dist/config.json 还原成跑测试之前的样子。

输出：dist/exe验证_代理IP_*.png

    python tools/verify_proxy_exe.py
"""
import ctypes
import io
import json
import os
import shutil
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
CFG = os.path.join(DIST, "config.json")

user32 = ctypes.windll.user32
DLG_KEY = "使用声明与免责条款"
MAIN_KEY = "得物整点抢兑助手"
PROXY_BTN = "代理 IP"
PROXY_DLG = "代理 IP 池 ·"

# 导入用的两行（故意全 ASCII，避免剪贴板编码问题）
IMPORT_TEXT = "127.0.0.1:1080:u1:p1#livetest1\n127.0.0.1:1081:u2:p2#livetest2"

lines = []


def say(s):
    print(s)
    lines.append(str(s))


# ============================================================ A. 静态核对
def static_check():
    say("=" * 64)
    say("A. 静态核对：代理代码到底打进 exe 了没")
    say("=" * 64)
    ok = True
    try:
        sys.path.insert(0, r"C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Lib\site-packages")
        from PyInstaller.archive.readers import CArchiveReader, ZlibArchiveReader
    except Exception as e:
        say("  ! 拿不到 PyInstaller 的 reader：%r（跳过静态核对）" % (e,))
        return None

    arc = CArchiveReader(EXE)
    toc = arc.toc
    say("  归档里共 %d 个条目" % len(toc))

    pyz_name = next((n for n in toc if n.endswith(".pyz")), None)
    if not pyz_name:
        say("  ✗ 找不到 PYZ")
        return False
    tmp = os.path.join(HERE, "_vpx.pyz")
    with open(tmp, "wb") as f:
        f.write(arc.extract(pyz_name))
    zarc = ZlibArchiveReader(tmp)
    try:
        names = set(zarc.toc)
        for mod in ("dewu_proxies", "dewu_sniper", "dewu_login", "dewu_push",
                    "dewu_answer"):
            hit = mod in names
            say("  %s %s 在包里" % ("✓" if hit else "✗", mod))
            ok = ok and hit
        # PySocks：requests 只在真的用 socks 时才 import 它，静态分析扫不到，
        # 所以 spec 里显式带了 hiddenimports。少了它 exe 一开代理就报错。
        hit = "socks" in names
        say("  %s socks（PySocks，socks 代理必需）" % ("✓" if hit else "✗"))
        ok = ok and hit

        # ★ 入口脚本（dewu_gui）不在 PYZ 里 —— PyInstaller 把它作为 SCRIPT 条目
        # 直接放在 CArchive 根部（类型 's'），内容是 marshal 过的 code object。
        # 这是正常行为，不是漏打包；早先按「在 PYZ 里」查会误报。
        script = next((n for n in toc if os.path.basename(str(n)) == "dewu_gui"), None)
        say("  %s dewu_gui 是入口脚本，在 CArchive 根部（%r）"
            % ("✓" if script else "✗", script))
        ok = ok and bool(script)

        code = zarc.extract("dewu_proxies")
        strs, names_ = set(), set()

        def walk(co, d=0):
            if d > 14 or not hasattr(co, "co_consts"):
                return
            names_.update(co.co_names)
            for c in co.co_consts:
                if isinstance(c, str):
                    strs.add(c)
                elif hasattr(c, "co_consts"):
                    walk(c, d + 1)

        walk(code)
        say("  dewu_proxies：%d 个字面量 / %d 个名字" % (len(strs), len(names_)))
        # 用子串匹配，别用整串相等 —— 文案经常是长句的一部分
        for w in ("socks5h", "Missing dependencies", "轮换", "本轮固定"):
            hit = any(w in s for s in strs)
            say("  %s 字面量含 %r" % ("✓" if hit else "✗", w))
            ok = ok and hit
        for w in ("normalize_line", "Provider", "provider_from_rows"):
            hit = w in names_ or any(w in s for s in strs)
            say("  %s 名字含 %r" % ("✓" if hit else "✗", w))
            ok = ok and hit

        gui = _entry_code(arc, script)
        gstrs = set()

        def walk2(co, d=0):
            if d > 14 or not hasattr(co, "co_consts"):
                return
            for c in co.co_consts:
                if isinstance(c, str):
                    gstrs.add(c)
                elif hasattr(c, "co_consts"):
                    walk2(c, d + 1)

        walk2(gui)
        for w in ("代理 IP", "让每个账号从不同的 IP 出去", "自动分配（每账号一个）",
                  "批量导入（一行一个，可带备注）"):
            hit = any(w in s for s in gstrs)
            say("  %s 界面文案含 %r" % ("✓" if hit else "✗", w))
            ok = ok and hit
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass
    return ok


def _entry_code(arc, name):
    """取入口脚本的 code object。

    CArchive 里 SCRIPT 条目存的是 marshal.dumps(code)；不同 PyInstaller 版本
    偶尔会在前面垫几个字节的头部，所以先按原样 loads，不行再逐字节偏移试。
    """
    import marshal
    raw = arc.extract(name)
    try:
        return marshal.loads(raw)
    except Exception:
        for off in range(1, 24):
            try:
                return marshal.loads(raw[off:])
            except Exception:
                continue
    raise ValueError("解不出 %r 的字节码" % name)


# ============================================================ 窗口工具
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
    kill_exe(EXE)
    time.sleep(0.9)


def client_origin(hwnd):
    pt = wintypes.POINT(0, 0)
    user32.ClientToScreen(int(hwnd), ctypes.byref(pt))
    return pt.x, pt.y


def click(hwnd, sx, sy):
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.3)
    user32.SetCursorPos(int(sx), int(sy))
    time.sleep(0.22)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.09)
    user32.mouse_event(0x0004, 0, 0, 0, 0)


def key_combo(vk):
    """按下并松开一个键（配合 Ctrl 用时先自己按下 0x11）。"""
    user32.keybd_event(vk, 0, 0, 0)
    time.sleep(0.05)
    user32.keybd_event(vk, 0, 2, 0)


# ============================================================ 图像工具
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


def grey_count(img, y, lo=120, hi=205):
    """数这一行「中性灰文字」的像素（R≈G≈B 且在区间内）。"""
    n = 0
    for x in range(0, img.width(), 2):
        c = img.pixelColor(x, y)
        r, g, b = c.red(), c.green(), c.blue()
        if abs(r - g) < 14 and abs(g - b) < 14 and lo <= r <= hi:
            n += 1
    return n


def is_accent(c):
    """实心主色按钮的底色。

    ★ 别写死红色。这个界面上有两个强调色：主色是红 #e6243f（抢购按钮），
    但弹窗里的主操作按钮是蓝 #2b7cf0（「导入」「保存并关闭」）。
    只认红就会漏掉「导入」，白白浪费一次真机跑。
    判据改成「高饱和、不是浅底」—— 红蓝都吃，白色/浅灰按钮（检测全部、
    启用停用…）和纯文字都会自然落选。
    """
    r, g, b = c.red(), c.green(), c.blue()
    return max(r, g, b) - min(r, g, b) >= 60 and max(r, g, b) >= 130


def accent_button(img, y0, y1, min_run=60, max_run=420):
    """按「块高 × 块宽」找实心强调色按钮。

    别看「最长的连续段」—— 输入框聚焦时的边框、进度条都会更长，
    选中它们就会点到别的地方。块高×块宽打分才能挑到按钮本体。
    """
    rows = []
    for y in range(max(0, y0), min(y1, img.height())):
        xs = [x for x in range(0, img.width(), 2) if is_accent(img.pixelColor(x, y))]
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
    segs, cur = [], [rows[0]]
    for y, r in rows[1:]:
        if y - cur[-1][0] <= 2:
            cur.append((y, r))
        else:
            segs.append(cur)
            cur = [(y, r)]
    segs.append(cur)
    seg = max(segs, key=lambda s: (s[-1][0] - s[0][0] + 1)
              * max(r[1] - r[0] for _y, r in s))
    h = seg[-1][0] - seg[0][0] + 1
    w = max(r[1] - r[0] for _y, r in seg)
    ys = [y for y, _r in seg]
    cy = (min(ys) + max(ys)) // 2
    mid = min(seg, key=lambda t: abs(t[0] - cy))[1]
    return (mid[0] + mid[1]) // 2, cy, w, h


# ============================================================ B/C. 真机
def main():
    from PySide6.QtWidgets import QApplication
    app = QApplication.instance() or QApplication(sys.argv)

    if not os.path.isfile(EXE):
        say("找不到 exe：%s" % EXE)
        return 1

    try:
        st = static_check()
    except Exception as e:
        say("  ! 静态核对自身出错（不影响后面的真机验证）：%r" % (e,))
        st = None

    backup = CFG + ".vpxbak"
    shutil.copy2(CFG, backup)
    before = json.load(open(CFG, encoding="utf-8"))
    n_before = len((before.get("proxy") or {}).get("pool") or [])

    code = 0
    try:
        say("")
        say("=" * 64)
        say("B. 真机：启动 exe，确认工具栏有「代理 IP」并能点开")
        say("=" * 64)
        kill()
        subprocess.Popen([EXE], cwd=DIST)
        say("已启动 exe（onefile 首次解包要几秒）")

        hwnd, _t, *_x, dt = wait(lambda: find(DLG_KEY), 50)
        if not hwnd:
            say("★ 声明窗没出现 —— exe 可能没启动成功")
            return 1
        say("[声明窗] 出现，用时 %.1fs" % dt)
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.4)
        user32.PostMessageW(hwnd, 0x0100, 0x0D, 0)
        user32.PostMessageW(hwnd, 0x0101, 0x0D, 0)

        mh, mt, mx, my, mw, mhg, dt2 = wait(
            lambda: find(MAIN_KEY, contain=False, minw=900), 40)
        if not mh:
            say("★ 主界面没出现")
            return 1
        say("[主界面] 标题=%r 矩形=(%d,%d,%dx%d) 用时 %.1fs" % (mt, mx, my, mw, mhg, dt2))
        time.sleep(3.2)

        shot = app.primaryScreen().grabWindow(int(mh)).toImage()
        say("[截图] 主界面客户区 %dx%d" % (shot.width(), shot.height()))
        ox, oy = client_origin(mh)
        p0 = os.path.join(DIST, "exe验证_代理IP_0_工具栏.png")
        shot.copy(0, 0, shot.width(), int(shot.height() * 0.11)).save(p0)
        say("[截图] %s" % p0)

        # 工具栏那一行：白色药丸最多的行
        best = None
        for y in range(115, min(240, shot.height())):
            runs = [r for r in white_runs(shot, y, min_w=40) if 40 <= r[2] <= 620]
            if len(runs) >= 3 and (best is None or len(runs) > len(best[1])):
                best = (y, runs)
        if not best:
            say("★ 没找到工具栏按钮行")
            return 1
        y, runs = best
        merged = []
        for r in runs:
            if merged and r[0] - merged[-1][1] <= 6:
                merged[-1] = (merged[-1][0], r[1], r[1] - merged[-1][0] + 1)
            else:
                merged.append(list(r))
        say("[扫描] 工具栏 y=%d，白色块 %d 个" % (y, len(merged)))

        # 先点一下标题栏预热：Windows 的前台锁会把第一次点击吃掉
        user32.SetForegroundWindow(mh)
        time.sleep(0.35)
        click(mh, ox + shot.width() // 2, oy - 32)
        time.sleep(0.5)

        # 从右往左试白色块，直到弹出「代理 IP 池 ·」为止（不靠猜下标）
        dropped = ("微信推送设置", "库存监听", "每日答题", "手机号登录", "自动降级")
        dh = None
        for idx in range(len(merged) - 1, max(-1, len(merged) - 9), -1):
            r = merged[idx]
            cxx = (r[0] + r[1]) // 2
            for attempt in (1, 2):
                say("[落点] 试第 %d 块 x=%d 宽=%d（第 %d 次）" % (idx, cxx, r[2], attempt))
                click(mh, ox + cxx, oy + y)
                time.sleep(1.4)
                wh, wt, *_w = wait(lambda: find(PROXY_DLG, minw=420), 4)
                if wh:
                    dh = wh
                    say("✓ 点开了：%r" % wt)
                    break
                for kh, kt, *_ in windows():
                    if any(k in kt for k in dropped) and not kt.startswith(MAIN_KEY):
                        say("        （误开了 %r，关掉继续）" % kt)
                        user32.PostMessageW(kh, 0x0010, 0, 0)
                        time.sleep(0.8)
            if dh:
                break
        if not dh:
            say("★ 没能点开「代理 IP」弹窗")
            return 1

        time.sleep(1.2)
        dshot = app.primaryScreen().grabWindow(int(dh)).toImage()
        say("[弹窗] 客户区 %dx%d" % (dshot.width(), dshot.height()))
        dox, doy = client_origin(dh)
        p1 = os.path.join(DIST, "exe验证_代理IP_1_弹窗.png")
        dshot.save(p1)
        say("[截图] %s" % p1)

        say("")
        say("=" * 64)
        say("C. 真机功能：粘两行代理 → 点「导入」→ 去 config.json 里查")
        say("=" * 64)

        # ① 找「批量导入」那个多行框：下半部分中性灰 placeholder 文字最密的一带
        y0 = int(dshot.height() * 0.55)
        bands = [(y, grey_count(dshot, y)) for y in range(y0, dshot.height() - 40)]
        bands = [b for b in bands if b[1] >= 6]
        if not bands:
            say("★ 没找到批量导入框（下半部分没有灰色占位文字）")
            return 1
        ta_y = bands[0][0]
        # 往下并进同一个框（连续行），取整条带的中点
        ys = [b[0] for b in bands]
        run_end = ta_y
        for yy in ys:
            if yy - run_end <= 6:
                run_end = yy
        ta_cy = (ta_y + run_end) // 2
        ta_x = int(dshot.width() * 0.22)
        say("[落点] 批量导入框 (x=%d, y=%d)，灰度行 %d..%d" % (ta_x, ta_cy, ta_y, run_end))

        # ② 把要导入的文本放进剪贴板（用 PowerShell，中文不经过我的代码）
        tmp_txt = os.path.join(HERE, "_vpx_import.txt")
        with io.open(tmp_txt, "w", encoding="utf-8", newline="\r\n") as f:
            f.write(IMPORT_TEXT + "\n")
        subprocess.run(["powershell", "-NoProfile", "-Command",
                        "Get-Content -Raw -LiteralPath '%s' | Set-Clipboard" % tmp_txt],
                       capture_output=True)

        click(dh, dox + ta_x, doy + ta_cy)
        time.sleep(0.5)
        user32.SetForegroundWindow(dh)
        user32.keybd_event(0x11, 0, 0, 0)      # Ctrl
        key_combo(0x56)                        # V
        user32.keybd_event(0x11, 0, 2, 0)
        time.sleep(0.8)
        p2 = os.path.join(DIST, "exe验证_代理IP_2_已粘贴.png")
        app.primaryScreen().grabWindow(int(dh)).toImage().save(p2)
        say("[截图] %s" % p2)

        # ③ 点「导入」（导入框下方那个实心强调色按钮）
        btn = accent_button(dshot, run_end + 4, min(dshot.height(), run_end + 260))
        if not btn:
            say("★ 没找到「导入」按钮")
            return 1
        bx, by, bw, bh = btn
        say("[落点] 导入按钮 x=%d y=%d (%dx%d)" % (bx, by, bw, bh))
        if not (60 <= bw <= 420):
            say("★ 找到的强调色块宽 %d 不像按钮，放弃点击（宁可报错也别点错）" % bw)
            return 1
        click(dh, dox + bx, doy + by)
        time.sleep(1.6)
        p3 = os.path.join(DIST, "exe验证_代理IP_3_导入后.png")
        app.primaryScreen().grabWindow(int(dh)).toImage().save(p3)
        say("[截图] %s" % p3)

        # ④ **不看截图，看数据**：exe 自己的 config.json 里应该多出这两个代理
        time.sleep(0.6)
        after = json.load(open(CFG, encoding="utf-8"))
        pool = (after.get("proxy") or {}).get("pool") or []
        labels = [p.get("label") for p in pool]
        got = [l for l in labels if l in ("livetest1", "livetest2")]
        say("config.json：导入前 %d 个 → 现在 %d 个，命中 %r" % (n_before, len(pool), got))
        if len(got) == 2:
            say("✓ 真机导入成功 —— 两行代理都落库了（config.json 是铁证）")
        else:
            say("★ 导入没成功。落库的备注是 %r" % (labels,))
            code = 1

    finally:
        kill()
        try:
            shutil.copy2(backup, CFG)
            os.remove(backup)
            say("已还原 dist/config.json")
        except Exception as e:
            say("! 还原 config.json 失败：%r" % (e,))
        try:
            os.remove(os.path.join(HERE, "_vpx_import.txt"))
        except Exception:
            pass

    say("")
    say("=" * 64)
    if st is None:
        say("静态核对：跳过")
    else:
        say("静态核对：%s" % ("通过 —— 代理代码确实在 exe 里" if st else "★ 有缺项，见上面"))
        if not st:
            code = 1
    say("真机验证：%s" % ("通过" if code == 0 else "★ 没过"))
    say("=" * 64)
    return code


if __name__ == "__main__":
    sys.exit(main())
