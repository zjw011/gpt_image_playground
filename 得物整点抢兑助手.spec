# -*- mode: python ; coding: utf-8 -*-
#
# 注意: datas 里必须把 app.ico 一起打进去!
#   icon=['app.ico'] 只把图标写进 exe 的 PE 资源(资源管理器看的那个),
#   而代码里 QApplication.setWindowIcon() 需要**运行时读到图标文件**,
#   onefile 下 _MEIPASS 和 __file__ 指向的都是解包临时目录,
#   不打进 datas 就永远找不到文件 -> 图标为 null -> 任务栏显示系统默认图标。
import os

APP_ICO = os.path.join(SPECPATH, 'app.ico')

a = Analysis(
    ['dewu_gui.py'],
    pathex=[],
    binaries=[],
    datas=[(APP_ICO, '.')],
    # dewu_proxies = 代理 IP 池（dewu_sniper 里 import 的那个），显式列上更保险。
    # socks = PySocks。requests 只有在**真的用 socks 代理时**才会去 import 它，
    #   靠静态分析扫不到 —— 不显式带上，打包出来的 exe 一开代理就报
    #   "Missing dependencies for SOCKS support"。
    hiddenimports=['dewu_proxies', 'socks'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='得物整点抢兑助手',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['app.ico'],
)
