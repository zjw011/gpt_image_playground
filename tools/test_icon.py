# -*- coding: utf-8 -*-
"""图标回归测试 —— 守住 2026-09-20 踩过的那个坑。

坑的样子(真实发生过):
    spec 的 datas=[] 少了 app.ico, 于是 exe 只有"文件图标"(资源管理器里正常),
    运行时 setWindowIcon() 拿到 null -> 任务栏显示成 Windows 默认图标。
    用户反馈: "软件的图标没加上吧 这里没有"

跑法:
    python tools/test_icon.py
"""
import os
import re
import struct
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

SPEC = os.path.join(ROOT, "得物整点抢兑助手.spec")
ICO = os.path.join(ROOT, "app.ico")

ok = []
bad = []


def chk(name, cond, extra=""):
    (ok if cond else bad).append(name)
    print("%s %s%s" % ("[PASS]" if cond else "[FAIL]", name, ("  " + extra) if extra else ""))


# ---------- 1. spec 必须把 app.ico 打进包 ----------
print("== 1. PyInstaller spec ==")
spec_txt = open(SPEC, encoding="utf-8").read()
chk("spec 里 icon= 指向 app.ico", "icon=" in spec_txt and "app.ico" in spec_txt)
chk("spec 里 datas 带上了 app.ico (★ 少了这行任务栏就没图标)",
    re.search(r"datas\s*=\s*\[\s*\(\s*[A-Za-z_][\w.]*\s*,", spec_txt) is not None,
    "实际: " + (re.search(r"datas=.*", spec_txt).group(0) if re.search(r"datas=.*", spec_txt) else "?"))

# ---------- 2. app.ico 的多尺寸帧格式 ----------
print("\n== 2. app.ico 帧格式 (小尺寸必须是 DIB) ==")
chk("app.ico 存在", os.path.isfile(ICO))
data = open(ICO, "rb").read()
_, typ, cnt = struct.unpack_from("<HHH", data, 0)
frames = []
for i in range(cnt):
    off = 6 + i * 16
    w, h, _cc, _r, _p, bpp, size, offset = struct.unpack_from("<BBBBHHII", data, off)
    raw = data[offset:offset + size]
    fmt = "PNG" if raw[:4] == b"\x89PNG" else ("DIB" if raw[:4] == b"\x28\x00\x00\x00" else "??")
    frames.append({"w": w or 256, "h": h or 256, "bpp": bpp, "fmt": fmt})
print("   帧:", ", ".join("%dx%d/%s" % (f["w"], f["h"], f["fmt"]) for f in frames))
chk("帧数 >= 6", len(frames) >= 6, "实际 %d" % len(frames))
chk("256 帧是 PNG", any(f["w"] == 256 and f["fmt"] == "PNG" for f in frames))
chk("所有 <256 的帧都是 DIB (PNG 会让资源管理器回退成空白图标)",
    all(f["fmt"] == "DIB" for f in frames if f["w"] < 256))
chk("大尺寸在前 (第一帧 >= 最后一帧)", frames[0]["w"] >= frames[-1]["w"])

# ---------- 3. resource_path 在"打包态"能找到图标 ----------
print("\n== 3. resource_path 兼容 onefile 打包态 ==")
import dewu_gui as G  # noqa: E402

saved_meipass = getattr(sys, "_MEIPASS", None)
saved_exe = sys.executable
try:
    tmp = tempfile.mkdtemp(prefix="meipass_sim_")
    import shutil
    shutil.copy2(ICO, os.path.join(tmp, "app.ico"))
    sys._MEIPASS = tmp
    sys.executable = os.path.join(tmp, "fake_dir", "App.exe")  # 故意指向不存在的目录
    p = G.resource_path("app.ico")
    chk("_MEIPASS 里有 ico 时优先命中它", os.path.normcase(p) == os.path.normcase(os.path.join(tmp, "app.ico")), p)

    # exe 同目录兜底: _MEIPASS 空, 但 exe 旁边有
    empty = tempfile.mkdtemp(prefix="meipass_empty_")
    exedir = tempfile.mkdtemp(prefix="exedir_")
    shutil.copy2(ICO, os.path.join(exedir, "app.ico"))
    sys._MEIPASS = empty
    sys.executable = os.path.join(exedir, "App.exe")
    p2 = G.resource_path("app.ico")
    chk("_MEIPASS 没有时能靠 sys.executable 找到 exe 同目录的 ico",
        os.path.normcase(p2) == os.path.normcase(os.path.join(exedir, "app.ico")), p2)
finally:
    if saved_meipass is None:
        sys.__dict__.pop("_MEIPASS", None)
    else:
        sys._MEIPASS = saved_meipass
    sys.executable = saved_exe

# ---------- 4. app_icon() 真的能拿到非空 QIcon ----------
print("\n== 4. app_icon() 非空 (setWindowIcon 才会被调用) ==")
from PySide6.QtWidgets import QApplication  # noqa: E402

app = QApplication.instance() or QApplication([])
ic = G.app_icon()
chk("app_icon() 不是 null", not ic.isNull())
chk("app_icon() 尺寸集合够多", len(ic.availableSizes()) >= 4,
    "sizes=" + str(sorted((s.width(), s.height()) for s in ic.availableSizes())))

# ---------- 5. main() 里的调用条件别被删掉 ----------
print("\n== 5. main() 里的守卫 ==")
gui_src = open(os.path.join(ROOT, "dewu_gui.py"), encoding="utf-8").read()
chk("调用了 app.setWindowIcon", "app.setWindowIcon(" in gui_src)
chk("调用了 w.setWindowIcon", "w.setWindowIcon(" in gui_src)

print("\n" + "=" * 46)
print("通过 %d 项, 失败 %d 项" % (len(ok), len(bad)))
if bad:
    print("失败:")
    for b in bad:
        print("  -", b)
sys.exit(1 if bad else 0)
