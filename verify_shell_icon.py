# -*- coding: utf-8 -*-
"""向 Windows Shell 询问"这个 exe 在资源管理器里显示什么图标", 并导出为 PNG.

原理: 调 SHGetFileInfoW(SHGFI_ICON) 拿到 Shell 实际返回的 HICON,
再经 GetDIBits 转成位图存盘. 这是唯一能证明图标真的生效的办法.
"""
import ctypes
import os
import shutil
import sys
import uuid
from ctypes import wintypes

from PIL import Image

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
shell32 = ctypes.windll.shell32

user32.GetIconInfo.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
user32.GetIconInfo.restype = wintypes.BOOL
user32.DestroyIcon.argtypes = [wintypes.HANDLE]
user32.GetDC.argtypes = [wintypes.HWND]
user32.GetDC.restype = wintypes.HDC
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.DeleteDC.argtypes = [wintypes.HDC]
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HANDLE]
gdi32.SelectObject.restype = wintypes.HANDLE
gdi32.GetObjectW.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p]
gdi32.GetObjectW.restype = ctypes.c_int
gdi32.GetDIBits.argtypes = [
    wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT,
    ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT,
]
gdi32.GetDIBits.restype = ctypes.c_int
gdi32.DeleteObject.argtypes = [wintypes.HANDLE]
shell32.SHGetFileInfoW.argtypes = [
    ctypes.c_wchar_p, wintypes.DWORD, ctypes.c_void_p, wintypes.UINT, wintypes.UINT,
]
shell32.SHGetFileInfoW.restype = ctypes.c_void_p

SHGFI_ICON = 0x000000100
SHGFI_LARGEICON = 0x000000000
SHGFI_SMALLICON = 0x000000001
SHGFI_SHELLICONSIZE = 0x000000004


class SHFILEINFOW(ctypes.Structure):
    _fields_ = [
        ("hIcon", wintypes.HANDLE),
        ("iIcon", ctypes.c_int),
        ("dwAttributes", wintypes.DWORD),
        ("szDisplayName", wintypes.WCHAR * 260),
        ("szTypeName", wintypes.WCHAR * 80),
    ]


class ICONINFO(ctypes.Structure):
    _fields_ = [
        ("fIcon", wintypes.BOOL),
        ("xHotspot", wintypes.DWORD),
        ("yHotspot", wintypes.DWORD),
        ("hbmMask", wintypes.HBITMAP),
        ("hbmColor", wintypes.HBITMAP),
    ]


class BITMAP(ctypes.Structure):
    _fields_ = [
        ("bmType", wintypes.LONG),
        ("bmWidth", wintypes.LONG),
        ("bmHeight", wintypes.LONG),
        ("bmWidthBytes", wintypes.LONG),
        ("bmPlanes", wintypes.WORD),
        ("bmBitsPixel", wintypes.WORD),
        ("bmBits", ctypes.c_void_p),
    ]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


def hicon_to_image(hicon):
    """HICON -> PIL.Image (RGBA)"""
    ii = ICONINFO()
    if not user32.GetIconInfo(hicon, ctypes.byref(ii)):
        raise OSError("GetIconInfo failed")

    bm = BITMAP()
    gdi32.GetObjectW(ii.hbmColor, ctypes.sizeof(bm), ctypes.byref(bm))
    w, h = bm.bmWidth, bm.bmHeight

    hdc = user32.GetDC(0)
    memdc = gdi32.CreateCompatibleDC(hdc)

    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth = w
    bi.biHeight = -h              # 负数 = 自上而下
    bi.biPlanes = 1
    bi.biBitCount = 32
    bi.biCompression = 0          # BI_RGB

    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.SelectObject(memdc, ii.hbmColor)
    got = gdi32.GetDIBits(memdc, ii.hbmColor, 0, h, buf, ctypes.byref(bi), 0)

    gdi32.DeleteDC(memdc)
    user32.ReleaseDC(0, hdc)

    if got == 0:
        raise OSError("GetDIBits failed")

    img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).copy()

    # 纯 32bpp 图标可能 alpha 全 0, 这时用 AND 掩码反推
    if not img.getchannel("A").getextrema()[1]:
        mb = BITMAP()
        gdi32.GetObjectW(ii.hbmMask, ctypes.sizeof(mb), ctypes.byref(mb))
        mbi = BITMAPINFOHEADER()
        mbi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        mbi.biWidth = w
        mbi.biHeight = -h
        mbi.biPlanes = 1
        mbi.biBitCount = 1
        stride = ((w + 31) // 32) * 4
        mbuf = ctypes.create_string_buffer(stride * h)
        hdc = user32.GetDC(0)
        memdc = gdi32.CreateCompatibleDC(hdc)
        gdi32.SelectObject(memdc, ii.hbmMask)
        gdi32.GetDIBits(memdc, ii.hbmMask, 0, h, mbuf, ctypes.byref(mbi), 0)
        gdi32.DeleteDC(memdc)
        user32.ReleaseDC(0, hdc)
        a = Image.new("L", (w, h))
        ap = a.load()
        for y in range(h):
            base = y * stride
            for x in range(w):
                bit = (mbuf[base + x // 8] >> (7 - (x % 8))) & 1
                ap[x, y] = 0 if bit else 255
        img.putalpha(a)

    if ii.hbmColor:
        gdi32.DeleteObject(ii.hbmColor)
    if ii.hbmMask:
        gdi32.DeleteObject(ii.hbmMask)
    return img


def shell_icon(path, small=False, shell_size=True):
    flags = SHGFI_ICON | (SHGFI_SMALLICON if small else SHGFI_LARGEICON)
    if shell_size:
        flags |= SHGFI_SHELLICONSIZE
    info = SHFILEINFOW()
    r = shell32.SHGetFileInfoW(
        ctypes.c_wchar_p(path), 0, ctypes.byref(info), ctypes.sizeof(info), flags
    )
    if not r or not info.hIcon:
        raise OSError("SHGetFileInfo failed for %s" % path)
    try:
        return hicon_to_image(info.hIcon)
    finally:
        user32.DestroyIcon(info.hIcon)


def probe(exe, tag):
    """拷到全新文件名再问 Shell, 绕开图标缓存"""
    tmp = os.path.join(
        os.environ.get("TEMP", "."), "probe_%s_%s.exe" % (tag, uuid.uuid4().hex[:8])
    )
    shutil.copy2(exe, tmp)
    try:
        big = shell_icon(tmp, small=False)
        sml = shell_icon(tmp, small=True)
        return big, sml, tmp
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


if __name__ == "__main__":
    target = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "shell_icon_probe.png"
    big, sml, tmp = probe(target, "shell")
    print("larger :", big.size, "alpha_max =", big.getchannel("A").getextrema()[1])
    print("smaller:", sml.size, "alpha_max =", sml.getchannel("A").getextrema()[1])

    pad = 12
    W = 16 + big.width + 16 + sml.width + 16
    H = 8 + max(big.height, sml.height, 64) + 8
    sheet = Image.new("RGBA", (W, H), (245, 248, 252, 255))
    sheet.alpha_composite(big, (8, (H - big.height) // 2))
    sheet.alpha_composite(sml, (8 + big.width + 16, (H - sml.height) // 2))
    sheet.save(out)
    print("saved ->", out)
