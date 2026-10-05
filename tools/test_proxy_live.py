# -*- coding: utf-8 -*-
"""代理 IP 链路的**真机验证**（不是 mock）。

思路
----
本机起一个极小的 HTTP 正向代理（支持 CONNECT 隧道 + 绝对 URI 的 GET 转发），
把它当成「用户买来的 IP」导入池子，然后让 Web 版真的通过它去请求得物。

能证明三件事：
  ① ``check()`` 探测出口 IP / 延迟是真的在工作（代理侧记下了被访问的地址）；
  ② ``/api/probe``（走兑换接口，不扣币）确实是**穿过代理**出去的，
     代理侧的 CONNECT 目标里必须出现 app.dewu.com；
  ③ 关掉代理之后再跑一次，代理侧不再收到任何请求 —— A/B 对照。

    python run_web.py                 # 先起服务
    python tools/test_proxy_live.py
"""
import asyncio
import json
import os
import socket
import sys
import threading
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mini_proxy import MiniProxy, free_port   # noqa: E402  （桌面版真机测试共用）

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8123"
PASS = FAIL = 0
FAILED = []


def ck(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ✓ %s" % name)
    else:
        FAIL += 1
        FAILED.append(name)
        print("  ✗ %s   %s" % (name, extra))


def sec(t):
    print("\n" + "=" * 68 + "\n" + t + "\n" + "=" * 68)


# ====================================================================== 主流程
def main():
    accs_path = os.path.join(ROOT, "dist", "accounts.json")
    if not os.path.exists(accs_path):
        print("缺少 dist/accounts.json，跑不了")
        return 1
    accs = json.load(open(accs_path, encoding="utf-8"))

    pw_path = os.path.join(ROOT, "webdata", "ADMIN_PASSWORD.txt")
    if not os.path.exists(pw_path):
        print("缺少 webdata/ADMIN_PASSWORD.txt（管理员随机密码），跑不了")
        return 1
    pw = open(pw_path, encoding="utf-8").read().strip()

    admin = requests.Session()
    # 用户名可能被改过（默认 admin，本项目已改成 xiaole）
    admin_ok = False
    for uname in (os.environ.get("ADMIN_USER"), "admin", "xiaole"):
        if not uname:
            continue
        if admin.post(BASE + "/api/admin/login",
                      json={"username": uname, "password": pw}).json().get("ok"):
            admin_ok = True
            break
    if not admin_ok:
        print("管理员登录失败")
        return 1
    user = requests.Session()
    if not user.post(BASE + "/api/login",
                     json={"curl": accs[0]["list_curl"]}).json().get("ok"):
        print("用户登录失败")
        return 1

    # 记下原始状态，测完恢复
    before = admin.get(BASE + "/api/admin/settings").json().get("settings", {})
    before_proxy_cfg = user.get(BASE + "/api/proxy").json()["proxy"]
    made_pid = None
    mp = MiniProxy()

    try:
        sec("① 起一个本机正向代理（假装是你买的国内 IP）")
        port = mp.start()
        ck("迷你代理在监听 127.0.0.1:%d" % port, port > 0)

        sec("② 导入池子并让 check() 探测")
        j = admin.post(BASE + "/api/admin/proxies/import",
                       json={"text": mp.url + "#本机测试代理", "scheme": "http",
                             "label": "live-test"}).json()
        ck("导入成功", j.get("added") == 1, j)
        pid = [p for p in admin.get(BASE + "/api/admin/proxies").json()["proxies"]
               if p["label"] == "live-test" or p["hostport"].endswith(str(port))]
        ck("能在列表里找到这个代理", len(pid) == 1, pid)
        if pid:
            made_pid = pid[0]["id"]

        j = admin.post(BASE + "/api/admin/proxies/check",
                       json={"ids": [made_pid]}).json()
        r0 = (j.get("results") or [{}])[0]
        ck("check() 判定为可用", r0.get("ok") is True, r0)
        ck("check() 探到了出口 IP", bool(r0.get("exit_ip")), r0)
        ck("check() 报出了延迟", (r0.get("latency_ms") or 0) > 0, r0)
        ck("代理侧确实收到了明文转发请求", len(mp.gets) > 0, mp.gets[:3])

        sec("③ 打开总开关 + 用户启用代理 + 绑定到这个代理")
        admin.post(BASE + "/api/admin/settings", json={"proxy_enabled": True})
        user.post(BASE + "/api/settings",
                  json={"proxy": {"enabled": True, "mode": "sticky", "rotate_n": 20}})
        j = user.post(BASE + "/api/proxy/rotate", json={"id": made_pid}).json()
        ck("绑定成功", j.get("ok") is True, j)
        ck("出口显示的是这个代理",
           str(port) in (j.get("proxy", {}).get("current") or ""),
           j.get("proxy", {}).get("current"))
        px = user.get(BASE + "/api/proxy").json()["proxy"]
        ck("ready=True（真的会走代理）", px.get("ready") is True, px)

        sec("④ 兑换接口必须穿过代理（A/B 对照）")
        mp.connects.clear()
        mp.gets.clear()
        res = user.post(BASE + "/api/probe", json={}).json()
        hit = [t for t in mp.connects if "dewu.com" in t]
        ck("代理侧看到了到 app.dewu.com 的 CONNECT", bool(hit), mp.connects)
        ck("探针本身给了可读结论", isinstance(res.get("msg"), str) and res.get("msg"),
           str(res.get("msg"))[:160])
        # 假 IP 那会儿会报「代理层错误」；这里真代理通了，结论不该是代理错误
        ck("结论不是「代理层错误」", "SOCKS" not in str(res.get("msg")),
           str(res.get("msg"))[:160])

        sec("⑤ 关掉代理再跑一次 —— 代理侧不该再收到任何请求")
        user.post(BASE + "/api/settings", json={"proxy": {"enabled": False}})
        mp.connects.clear()
        mp.gets.clear()
        res2 = user.post(BASE + "/api/probe", json={}).json()
        ck("代理侧没有新的 CONNECT（证明前面那次确实是走代理的）",
           not [t for t in mp.connects if "dewu.com" in t], mp.connects)
        ck("直连的探针也给了结论", isinstance(res2.get("msg"), str) and res2.get("msg"),
           str(res2.get("msg"))[:160])

    finally:
        # ---- 收尾：把状态恢复回去 ----
        try:
            if before_proxy_cfg.get("assigned_id"):
                user.post(BASE + "/api/proxy/rotate",
                          json={"id": before_proxy_cfg["assigned_id"]})
            user.post(BASE + "/api/settings", json={"proxy": {
                "enabled": bool(before_proxy_cfg.get("enabled")),
                "mode": before_proxy_cfg.get("mode") or "sticky",
                "rotate_n": before_proxy_cfg.get("rotate_n") or 20,
                "also_list": bool(before_proxy_cfg.get("also_list")),
            }})
            admin.post(BASE + "/api/admin/settings", json={
                "proxy_enabled": bool(before.get("proxy_enabled")),
                "proxy_required": bool(before.get("proxy_required")),
            })
            if made_pid:
                admin.post(BASE + "/api/admin/proxies/delete", json={"ids": [made_pid]})
        except Exception as e:
            print("  收尾时出错（不影响结论）：%r" % (e,))
        mp.stop()

    print("\n" + "=" * 68)
    print("  通过 %d 项 / 失败 %d 项" % (PASS, FAIL))
    if FAILED:
        for f in FAILED:
            print("   ✗ %s" % f)
    print("=" * 68)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
