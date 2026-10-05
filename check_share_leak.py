# -*- coding: utf-8 -*-
"""检查分享包里是否存在会泄露账号凭据的文件。"""
import json
import os
import re

os.chdir(r"D:\work\workbuudy\dewu\dist")

with open("accounts.json", encoding="utf-8") as f:
    d = json.load(f)
c = d[0]["list_curl"]
print("list_curl 长度:", len(c))
print("含 Cookie 头   :", "cookie" in c.lower())
print("含 x-auth-token:", "x-auth-token" in c.lower())
m = re.search(r"x-auth-token:\s*([^'\"\s]+)", c, re.I)
print("token 前 8 位  :", (m.group(1)[:8] + "...") if m else "未找到")
m2 = re.search(r"cookie:\s*([^'\"\r\n]+)", c, re.I)
if m2:
    print("cookie 长度    :", len(m2.group(1)), "| 开头:", m2.group(1)[:20] + "...")

print()
print("目录里必须排除的文件:")
for fn in sorted(os.listdir(".")):
    if fn.endswith((".json", ".log")):
        print("   %-20s %8d 字节" % (fn, os.path.getsize(fn)))
