# -*- coding: utf-8 -*-
"""Web 版后端包。

这里做一件事：把项目根目录加进 sys.path，好让 webapp 能直接
`import dewu_login` / `import dewu_push`（复用桌面版逆向出来的纯函数模块）。
"""
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
