# -*- coding: utf-8 -*-
"""生成 Windows 兼容的多尺寸 app.ico

关键点: 资源管理器只对 256x256 支持 PNG 压缩帧, 16/24/32/48 等小尺寸必须是
BMP/DIB 裸位图, 否则会回退显示系统默认的空白 exe 图标.
本脚本手工写 ICONDIR, 小尺寸写 DIB(含 AND 掩码), 256 写 PNG.
"""
import io
import struct
from PIL import Image, ImageDraw

SRC = r"D:\work\workbuudy\dewu\icon_src\A_modern_flat_app_icon_design__2026-09-18T01-50-34.png"
OUT = r"D:\work\workbuudy\dewu\app.ico"
RADIUS_RATIO = 236 / 1024.0          # 源图圆角半径比例
BG = (255, 255, 255)
SIZES = [16, 20, 24, 32, 48, 64, 128, 256]


def rounded_alpha(size, radius_ratio=RADIUS_RATIO, ss=4):
    """超采样生成抗锯齿的圆角矩形 alpha 遮罩"""
    big = size * ss
    r = int(round(big * radius_ratio))
    m = Image.new("L", (big, big), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, big - 1, big - 1], radius=r, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def make_master():
    """源图 -> 带透明圆角的 RGBA 母版"""
    im = Image.open(SRC).convert("RGBA")
    im = im.resize((1024, 1024), Image.LANCZOS)
    im.putalpha(rounded_alpha(1024))
    return im


def dib_bytes(img):
    """32bpp DIB (BITMAPINFOHEADER + BGRA 倒序行 + 1bpp AND 掩码)"""
    w, h = img.size
    px = img.load()
    xor = bytearray()
    for y in range(h - 1, -1, -1):          # DIB 自下而上
        row = bytearray()
        for x in range(w):
            r, g, b, a = px[x, y]
            row += bytes((b, g, r, a))
        xor += row
    # AND 掩码: 1 = 透明
    stride = ((w + 31) // 32) * 4
    and_mask = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray(stride)
        for x in range(w):
            if px[x, y][3] < 128:
                row[x // 8] |= 0x80 >> (x % 8)
        and_mask += row
    header = struct.pack(
        "<IiiHHIIiiII",
        40,          # biSize
        w,           # biWidth
        h * 2,       # biHeight (XOR + AND)
        1,           # biPlanes
        32,          # biBitCount
        0,           # biCompression = BI_RGB
        len(xor),    # biSizeImage
        0, 0, 0, 0,
    )
    return bytes(header) + bytes(xor) + bytes(and_mask)


def png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def main():
    master = make_master()
    frames = []                              # (size, is_png, data)
    for s in SIZES:
        img = master.resize((s, s), Image.LANCZOS)
        if s >= 256:
            frames.append((s, True, png_bytes(img)))
        else:
            frames.append((s, False, dib_bytes(img)))

    frames.sort(key=lambda f: -f[0])         # 大尺寸在前
    out = bytearray(struct.pack("<HHH", 0, 1, len(frames)))
    offset = 6 + 16 * len(frames)
    for s, is_png, data in frames:
        out += struct.pack(
            "<BBBBHHII",
            0 if s >= 256 else s,            # 宽, 256 记为 0
            0 if s >= 256 else s,
            0, 0, 1, 32,
            len(data), offset,
        )
        offset += len(data)
    for _, _, data in frames:
        out += data

    with open(OUT, "wb") as f:
        f.write(out)

    print("wrote", OUT, len(out), "bytes")
    for s, is_png, data in frames:
        print("  %3dx%-3d %-4s %8d" % (s, s, "PNG" if is_png else "DIB", len(data)))

    # 预览图: 实际尺寸 + 放大版
    sheet = Image.new("RGBA", (1024, 300), (245, 248, 252, 255))
    x = 20
    for s in SIZES:
        f = master.resize((s, s), Image.LANCZOS)
        sheet.alpha_composite(f, (x, 40 + (256 - s) // 2))
        big = f.resize((s * 3, s * 3), Image.NEAREST) if s <= 64 else None
        x += s + 24
    sheet.save(r"D:\work\workbuudy\dewu\icon_preview.png")
    print("preview -> icon_preview.png")


if __name__ == "__main__":
    main()
