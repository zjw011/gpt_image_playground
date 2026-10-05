# -*- coding: utf-8 -*-
"""集成自检：编译 + 跨渠道去重 + GUI 可构造"""
import os
import sys
import json
import tempfile
import py_compile

BASE = r"D:\work\workbuudy\dewu"
sys.path.insert(0, BASE)

print("=== 1) 语法编译 ===")
for f in ("dewu_sniper.py", "dewu_gui.py", "web_login.py"):
    p = os.path.join(BASE, f)
    try:
        py_compile.compile(p, doraise=True)
        print("  OK  ", f)
    except Exception as e:
        print("  FAIL", f, e)
        sys.exit(1)

print()
print("=== 2) 跨渠道去重（同一 x-auth-token，不同 Cookie）===")
import dewu_sniper as DS  # noqa: E402

TOK = "Bearer eyJhbGciOiJIUzI1NiJ9.FAKETOKENFOR.TEST"

def mk_curl(cookie_value, token=TOK):
    return ("curl 'https://app.dewu.com/hacking-game-platform/v1/gameplay/branch/"
            "exchange_list?activity=20260917&sign=abc' "
            "-H 'appid: h5' -H 'Cookie: %s' -H 'x-auth-token: %s'" % (cookie_value, token))

tmp = os.path.join(tempfile.gettempdir(), "dewu_test_accounts.json")
if os.path.exists(tmp):
    os.remove(tmp)

old_path, old_accounts, old_next = DS.ACCOUNTS_PATH, list(DS.M.accounts), DS.M._next_account_id
DS.ACCOUNTS_PATH = tmp
DS.M.accounts = []
DS.M._next_account_id = 1

try:
    r1 = DS.M.add_account("测试账号", mk_curl("aaa=111; sk=xxx"))
    print("  第1次导入:", r1.get("ok"), "| updated =", r1.get("updated"), "| 账号数 =", len(DS.M.accounts))

    # 换一整组 Cookie（模拟浏览器登录抓到的），token 不变 → 应判为同一账号并更新
    r2 = DS.M.add_account("", mk_curl("bbb=222; ccc=333; dwsm=zzz"))
    print("  第2次导入:", r2.get("ok"), "| updated =", r2.get("updated"), "| 账号数 =", len(DS.M.accounts))

    # 再来一个不同 token → 应是新账号
    r3 = DS.M.add_account("", mk_curl("bbb=222", TOK + "-DIFFERENT"))
    print("  第3次导入:", r3.get("ok"), "| updated =", r3.get("updated"), "| 账号数 =", len(DS.M.accounts))

    ok = (r1.get("ok") and not r1.get("updated")
          and r2.get("ok") and r2.get("updated")
          and r3.get("ok") and not r3.get("updated")
          and len(DS.M.accounts) == 2)
    print("  结论:", "PASS ✓" if ok else "FAIL ✗")
finally:
    DS.ACCOUNTS_PATH = old_path
    DS.M.accounts = old_accounts
    DS.M._next_account_id = old_next

print()
print("=== 3) GUI 构造冒烟 ===")
os.environ.setdefault("QT_QPA_PLATFORM", "windows")
try:
    from PySide6.QtWidgets import QApplication
    from PySide6.QtCore import QTimer
    import dewu_gui
    app = QApplication.instance() or QApplication([])
    w = dewu_gui.MainWindow()
    w.show()
    QTimer.singleShot(1500, app.quit)
    app.exec()
    print("  MainWindow 构造 + 显示 + 退出 正常 ✓")
    print("  账号区按钮:", [b.text() for b in w.findChildren(dewu_gui.QPushButton)
                           if "网页登录" in b.text() or "导入账号" in b.text()])
except Exception as e:
    import traceback
    traceback.print_exc()
    print("  GUI 冒烟失败:", e)

print()
print("DONE")
