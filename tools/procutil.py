# -*- coding: utf-8 -*-
"""按「可执行文件完整路径」精确找进程 / 杀进程。

为什么需要它（2026-10-02 踩的坑）:
    1) 打包脚本里判断「exe 是不是正在运行」，用的是
       `tasklist /FI "IMAGENAME eq 得物整点抢兑助手.exe"` + 字符串包含。
       中文镜像名一过 cp936 解码就飘，结果是 exe 明明开着却报 False，
       于是 PyInstaller 辛辛苦苦打包 60 秒，最后 Copy-Item 覆盖时报「文件被占用」。
    2) `taskkill /F /IM 得物整点抢兑助手.exe` 同样会静默失败（returncode 非 0 但被吞掉），
       表现是「验证脚本说已关闭 exe，其实进程还在」，残留一辈子。
    3) PyInstaller onefile 会同时存在两个同名进程（bootloader 父进程 + 真实子进程），
       只杀一个不够。

所以统一改成: 用 CreateToolhelp32Snapshot 枚举全部进程, 拿
QueryFullProcessImageNameW 取完整路径, 按路径精确匹配 → 拿 PID → 按 PID 杀。
"""
import ctypes
import os
import time
from ctypes import wintypes

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_TERMINATE = 0x0001
MAX_PATH = 32768

_k32 = ctypes.windll.kernel32

_k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
_k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
_k32.OpenProcess.restype = wintypes.HANDLE
_k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
_k32.CloseHandle.argtypes = [wintypes.HANDLE]
_k32.QueryFullProcessImageNameW.argtypes = [
    wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
_k32.Process32FirstW.restype = wintypes.BOOL
_k32.Process32NextW.restype = wintypes.BOOL

_INVALID_HANDLE = ctypes.c_void_p(-1).value


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]


def image_path(pid):
    """取某个 PID 的完整 exe 路径；拿不到就返回 None（通常是权限不够）。"""
    h = _k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h:
        return None
    try:
        buf = ctypes.create_unicode_buffer(MAX_PATH)
        size = wintypes.DWORD(MAX_PATH)
        if _k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
        return None
    finally:
        _k32.CloseHandle(h)


def pids_of(exe_path):
    """列出所有 exe 路径等于 exe_path 的进程 PID（含 onefile 的父/子两个进程）。"""
    want = os.path.normcase(os.path.abspath(exe_path))
    out = []
    snap = _k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == _INVALID_HANDLE:
        return out
    try:
        ent = PROCESSENTRY32W()
        ent.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = _k32.Process32FirstW(snap, ctypes.byref(ent))
        while ok:
            pid = ent.th32ProcessID
            if pid:
                p = image_path(pid)
                if p and os.path.normcase(os.path.abspath(p)) == want:
                    out.append(pid)
            ok = _k32.Process32NextW(snap, ctypes.byref(ent))
    finally:
        _k32.CloseHandle(snap)
    return out


def running(exe_path):
    return bool(pids_of(exe_path))


def kill(exe_path, wait=1.2):
    """结束所有跑着这份 exe 的进程。返回被杀的 PID 列表。

    先杀 PID 大的（子进程），再杀父进程 —— 反过来的话 bootloader 可能会重新拉起子进程。
    """
    pids = sorted(pids_of(exe_path), reverse=True)
    killed = []
    for pid in pids:
        h = _k32.OpenProcess(PROCESS_TERMINATE, False, pid)
        if not h:
            continue
        try:
            if _k32.TerminateProcess(h, 1):
                killed.append(pid)
        finally:
            _k32.CloseHandle(h)
    if killed:
        time.sleep(wait)
    return killed


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("用法: python tools/procutil.py <exe路径> [--kill]")
        sys.exit(1)
    target = sys.argv[1]
    print("目标: %s" % target)
    print("PID : %s" % (pids_of(target) or "（没有在跑）"))
    if "--kill" in sys.argv:
        print("已杀: %s" % (kill(target) or "（没有在跑）"))
        print("剩余: %s" % (pids_of(target) or "（清干净了）"))
