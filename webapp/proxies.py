# -*- coding: utf-8 -*-
"""Web 版的 ``proxies`` 模块 —— 只是对根目录 :mod:`dewu_proxies` 的转发。

真正的实现放在仓库根目录 ``dewu_proxies.py``，因为那份要同时给
**桌面版 exe**（`dewu_sniper.py`）和 **Web 版**（这里）用：
桌面包里没有、也不该有 ``webapp/`` 这棵依赖树（sqlalchemy / fastapi 一大串）。

所以：改代理逻辑请改 ``dewu_proxies.py``，这个文件不要加东西。
"""
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import dewu_proxies as _impl                                    # noqa: E402
from dewu_proxies import *                                      # noqa: E402,F401,F403
from dewu_proxies import __all__ as _all                        # noqa: E402

__all__ = list(_all)

# 兜底：万一某个名字没进 __all__，也让 `from . import proxies as PX; PX.xxx` 能取到
for _k in dir(_impl):
    if not _k.startswith("__") and _k not in globals():
        globals()[_k] = getattr(_impl, _k)
del _k, _impl
