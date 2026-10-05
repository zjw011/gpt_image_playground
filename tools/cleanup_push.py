# -*- coding: utf-8 -*-
"""收尾：同步使用说明、把卡片预览挪到 dist、清掉本次产生的临时文件。
删不掉的（safe-delete shim 可能拦）只提示，不当失败。
"""
import os
import shutil
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
os.chdir(ROOT)

log = []


def say(s):
    print(s)
    log.append(s)


# 1) dist 的使用说明 → 同步回源码目录，两边保持一致
src = os.path.join(ROOT, "dist", "使用说明.txt")
dst = os.path.join(ROOT, "使用说明.txt")
shutil.copy2(src, dst)
say("已同步: dist/使用说明.txt → 使用说明.txt  (%d 字节)" % os.path.getsize(dst))

# 2) 卡片预览图放一份到 dist（不看微信也能核对样式）
pv = os.path.join(HERE, "_preview.png")
if os.path.isfile(pv):
    out = os.path.join(ROOT, "dist", "推送样式预览.png")
    shutil.copy2(pv, out)
    say("已放置: dist/推送样式预览.png  (%.1f KB)" % (os.path.getsize(out) / 1024))

# 3) 清理本次产生的临时文件
tmp = [
    os.path.join(HERE, "_preview.html"),
    os.path.join(HERE, "_preview.png"),
    os.path.join(HERE, "_probe_py.txt"),
    os.path.join(HERE, "_probe_browser.txt"),
    os.path.join(HERE, "_probe_edge.txt"),
    os.path.join(HERE, "_crop_header.png"),
    os.path.join(HERE, "_crop_header_right.png"),
    os.path.join(HERE, "_crop_btn.png"),
    os.path.join(HERE, "_build_exe.log"),
    os.path.join(HERE, "_verify_push_exe.log"),
    os.path.join(HERE, "_click_push.log"),
]
for p in tmp:
    if not os.path.exists(p):
        continue
    try:
        os.remove(p)
        say("已删: tools/%s" % os.path.basename(p))
    except Exception as e:
        say("★ 删不掉 tools/%s (%r)" % (os.path.basename(p), e))

# 4) Edge 无头截图用的临时 profile（6~7MB）
prof = os.path.join(HERE, "_edge_profile")
if os.path.isdir(prof):
    try:
        shutil.rmtree(prof, ignore_errors=False)
        say("已删: tools/_edge_profile")
    except Exception as e:
        say("★ 删不掉 tools/_edge_profile (%r)" % (e,))

# 5) 打包中间产物（很大，可选删）
for d in ("dist_new", "build_new"):
    p = os.path.join(ROOT, d)
    if not os.path.isdir(p):
        continue
    try:
        shutil.rmtree(p, ignore_errors=False)
        say("已删: %s/" % d)
    except Exception as e:
        try:
            os.rename(p, p + "_%s" % time.strftime("%m%d_%H%M"))
            say("★ %s/ 删不掉，已改名留档" % d)
        except Exception as e2:
            say("★ %s/ 处理失败 (%r / %r)" % (d, e, e2))

say("")
say("完成")
with open(os.path.join(HERE, "_cleanup.log"), "w", encoding="utf-8") as f:
    f.write("\n".join(log))
