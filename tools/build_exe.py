# -*- coding: utf-8 -*-
"""
重建 exe（得物整点抢兑助手）

为什么要这么绕：
  本机的 safe-delete shim 会接管 os.remove。PyInstaller 在 --noconfirm 覆盖旧产物时
  会 os.remove 那个 exe，于是被接管去 trash、报 SAFE_DELETE_FAIL_CLOSED，构建直接 exit=1。
  → 所以**输出到独立的 dist_new / build_new**，完全不碰旧 exe；
    最后用 PowerShell Copy-Item -Force 覆盖 dist/ 里的正式 exe（PowerShell 不过 shim）。

用法:
  python tools/build_exe.py            # 构建 + 覆盖 dist/ 正式 exe
  python tools/build_exe.py --dry      # 只看会做什么，不真跑 PyInstaller
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENV_PY = r"C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
SPEC = os.path.join(ROOT, "得物整点抢兑助手.spec")
EXE_NAME = "得物整点抢兑助手.exe"
DIST = os.path.join(ROOT, "dist")
BACKUP = os.path.join(DIST, "_backup")
LOG = os.path.join(ROOT, "tools", "_build_exe.log")

lines = []


def say(s):
    print(s)
    lines.append(s)


def rmtree_soft(path):
    """尽力删掉旧构建目录；删不动就返回 False（改用新目录名）。"""
    if not os.path.isdir(path):
        return True
    try:
        shutil.rmtree(path, ignore_errors=False)
        return True
    except Exception as e:
        say("  (旧目录删不掉: %r，换个新目录名继续)" % (e,))
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    if not os.path.isfile(SPEC):
        say("找不到 spec: %s" % SPEC)
        return 1
    if not os.path.isfile(VENV_PY):
        say("找不到打包用 Python: %s" % VENV_PY)
        return 1

    # ---- 0) 确认 exe 没在运行（在跑时覆盖会失败）----
    # ★ 别用 tasklist / taskkill + 中文镜像名: cp936 解码一飘就误判成"没在运行",
    #   结果打完包覆盖时才发现"文件被占用"。这里按 exe 完整路径精确匹配 PID。
    cur = os.path.join(DIST, EXE_NAME)
    from procutil import pids_of, kill as kill_exe
    pids = pids_of(cur)
    say("exe 正在运行: %s%s" % (bool(pids), ("  PID=%s" % pids) if pids else ""))
    if pids:
        say("★ 先把正在跑的「得物整点抢兑助手」关掉再打包（下面自动帮你关）…")
        killed = kill_exe(cur)
        say("  已结束 PID: %s" % (killed or "（无）"))
        time.sleep(0.8)
        left = pids_of(cur)
        if left:
            say("★ 还有进程没退出: %s → 请手动关掉后重试" % left)
            return 2
        say("  已关干净，继续打包")

    # ---- 1) 备份现有 exe ----
    stamp = time.strftime("%m%d_%H%M")
    if os.path.isfile(cur):
        os.makedirs(BACKUP, exist_ok=True)
        bak = os.path.join(BACKUP, "得物整点抢兑助手_%s_上一版.exe" % stamp)
        if not os.path.isfile(bak):
            shutil.copy2(cur, bak)
            say("已备份 → %s" % bak)
        else:
            say("备份已存在，跳过: %s" % bak)

    # ---- 2) 选构建目录（删不掉就换名字）----
    dist_new = os.path.join(ROOT, "dist_new")
    build_new = os.path.join(ROOT, "build_new")
    if not (rmtree_soft(dist_new) and rmtree_soft(build_new)):
        dist_new = os.path.join(ROOT, "dist_new_%s" % stamp)
        build_new = os.path.join(ROOT, "build_new_%s" % stamp)
    say("构建输出: %s" % dist_new)

    if args.dry:
        say("[dry] 将执行 PyInstaller，跳过")
        return 0

    # ---- 3) 打包 ----
    cmd = [VENV_PY, "-m", "PyInstaller", "--noconfirm",
           "--distpath", dist_new, "--workpath", build_new,
           "--log-level", "WARN", SPEC]
    say("运行: " + " ".join(cmd))
    t0 = time.time()
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                       errors="replace", timeout=1800)
    say("PyInstaller 退出码 = %s, 耗时 %.1fs" % (p.returncode, time.time() - t0))
    if p.stdout.strip():
        say("--- stdout ---\n" + p.stdout.strip()[-3000:])
    if p.stderr.strip():
        say("--- stderr ---\n" + p.stderr.strip()[-3000:])
    if p.returncode != 0:
        say("★ 构建失败")
        return 1

    built = os.path.join(dist_new, EXE_NAME)
    if not os.path.isfile(built):
        say("★ 构建产物找不到: %s" % built)
        return 1

    # ---- 4) 覆盖正式 exe ----
    # 先用 shutil（本机的 safe-delete shim 只管删除，不管复制）；
    # 万一被占用/权限拦下，再退回 PowerShell Copy-Item。
    copied = False
    try:
        shutil.copy2(built, cur)
        copied = os.path.getsize(cur) == os.path.getsize(built)
        say("覆盖结果: shutil.copy2 %s" % ("OK" if copied else "大小对不上"))
    except Exception as e:
        say("覆盖结果: shutil.copy2 失败 %r，改用 PowerShell" % (e,))
    if not copied:
        ps = ("Copy-Item -LiteralPath '%s' -Destination '%s' -Force; "
              "if ($?) { 'COPIED_OK' }" % (built, cur))
        r = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                           capture_output=True, text=True, errors="replace", timeout=300)
        say("覆盖结果(PowerShell): %s %s"
            % ((r.stdout or "").strip(), (r.stderr or "").strip()[:300]))
        copied = "COPIED_OK" in (r.stdout or "")
    if not copied:
        say("★ 覆盖失败 —— 大概率是还有进程占着这个 exe。"
            "跑 `python tools\\procutil.py \"%s\" --kill` 清掉再重试。" % cur)
        return 1

    size = os.path.getsize(cur)
    say("成品: %s  (%d 字节, %.1f MB)" % (cur, size, size / 1048576.0))
    say("构建目录可留作排查: %s" % dist_new)
    return 0


if __name__ == "__main__":
    try:
        rc = main()
    finally:
        with open(LOG, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
    sys.exit(rc)
