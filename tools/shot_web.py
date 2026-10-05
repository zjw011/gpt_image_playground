# -*- coding: utf-8 -*-
"""Web 版界面截图（无头 Edge + CDP）。

    python run_web.py                       # 先把服务跑起来
    python tools/shot_web.py [base_url] [out_dir]

会截：登录页 / 用户工作台（商品墙）/ 创建任务弹窗 / 管理后台三个页签。
"""
import base64
import json
import os
import subprocess
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))

from web_login import _WS, find_browser  # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8123"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "dist")
PORT = 9531
W, H = 1440, 1080


def free_port():
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def wait(cdp, path, tries=60):
    for _ in range(tries):
        try:
            with requests.get("http://127.0.0.1:%d%s" % (PORT, path), timeout=3) as _:
                pass
            import urllib.request
            return json.loads(urllib.request.urlopen(
                "http://127.0.0.1:%d%s" % (PORT, path), timeout=4).read())
        except Exception:
            time.sleep(0.3)
    return None


def main():
    br = find_browser()
    if not br:
        print("没找到 Edge / Chrome")
        return 1
    os.makedirs(OUT, exist_ok=True)

    # ---- 先拿两个会话 cookie（用户 + 管理员）----
    accs = json.load(open(os.path.join(ROOT, "dist", "accounts.json"), encoding="utf-8"))
    s = requests.Session()
    r = s.post(BASE + "/api/login", json={"curl": accs[0]["list_curl"]}).json()
    print("用户登录:", r.get("ok"), r.get("msg", ""))
    user_cookie = s.cookies.get("dw_sid")
    s.post(BASE + "/api/products/refresh", json={})

    pw_path = os.path.join(ROOT, "webdata", "ADMIN_PASSWORD.txt")
    admin_cookie = None
    if os.path.exists(pw_path):
        pw = open(pw_path, encoding="utf-8").read().strip()
        a = requests.Session()
        if a.post(BASE + "/api/admin/login",
                  json={"username": "admin", "password": pw}).json().get("ok"):
            admin_cookie = a.cookies.get("dw_admin")
    print("管理员 cookie:", bool(admin_cookie))

    port = free_port()
    proc = subprocess.Popen(
        [br, "--headless=new", "--remote-debugging-port=%d" % port,
         "--remote-allow-origins=*", "--no-first-run", "--no-default-browser-check",
         "--disable-gpu", "--hide-scrollbars",
         "--user-data-dir=" + os.path.join(OUT, "_shotprofile"),
         "--window-size=%d,%d" % (W, H), "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    globals()["PORT"] = port

    for _ in range(70):
        try:
            targets = json.loads(__import__("urllib.request").request.urlopen(
                "http://127.0.0.1:%d/json/list" % port, timeout=3).read())
            break
        except Exception:
            targets = None
            time.sleep(0.35)
    if not targets:
        print("浏览器调试端口没起来")
        return 1
    page = next(t for t in targets if t["type"] == "page")
    ws = _WS(page["webSocketDebuggerUrl"])
    ws.call("Page.enable")
    ws.call("Network.enable")
    ws.call("Runtime.enable")
    ws.call("Emulation.setDeviceMetricsOverride",
            {"width": W, "height": H, "deviceScaleFactor": 1, "mobile": False})

    def nav(url, wait_s=3.0):
        ws.call("Page.navigate", {"url": url})
        time.sleep(wait_s)

    def set_cookie(name, value):
        ws.call("Network.setCookie",
                {"name": name, "value": value, "domain": "127.0.0.1", "path": "/"})

    def clear_cookie(name):
        ws.call("Network.deleteCookies", {"name": name, "domain": "127.0.0.1"})

    def shot(path, full=False):
        args = {"format": "png"}
        if full:
            m = ws.call("Page.getLayoutMetrics")
            try:
                h = int(m["result"]["cssContentSize"]["height"])
                args["clip"] = {"x": 0, "y": 0, "width": W, "height": min(h, 7000),
                                "scale": 1}
                args["captureBeyondViewport"] = True
            except Exception:
                pass
        r = ws.call("Page.captureScreenshot", args, timeout=25)
        data = base64.b64decode(r["result"]["data"])
        with open(path, "wb") as f:
            f.write(data)
        print("  → %s  (%d KB)" % (os.path.basename(path), len(data) // 1024))

    # ---- ① 登录页 ----
    clear_cookie("dw_sid")
    nav(BASE + "/", 2.5)
    shot(os.path.join(OUT, "web_1_登录页.png"))

    # ---- ② 用户工作台 ----
    set_cookie("dw_sid", user_cookie)
    nav(BASE + "/", 4.0)
    shot(os.path.join(OUT, "web_2_工作台.png"), full=True)

    # ---- ③ 创建任务弹窗（点第一个商品卡片）----
    ws.call("Runtime.evaluate",
            {"expression": "document.querySelector('.pcard').click()", "awaitPromise": False})
    time.sleep(1.2)
    shot(os.path.join(OUT, "web_3_创建任务.png"))
    ws.call("Runtime.evaluate", {"expression": "APP.closeModal()"})
    time.sleep(0.4)

    # ---- ④ 推送设置弹窗 ----
    ws.call("Runtime.evaluate", {"expression": "APP.pushModal()"})
    time.sleep(1.0)
    shot(os.path.join(OUT, "web_4_推送设置.png"))
    ws.call("Runtime.evaluate", {"expression": "APP.closeModal()"})

    # ---- ⑤ 管理后台 ----
    if admin_cookie:
        clear_cookie("dw_sid")
        set_cookie("dw_admin", admin_cookie)
        nav(BASE + "/admin", 4.0)
        shot(os.path.join(OUT, "web_5_后台_兑换码.png"), full=True)
        for tab, name in (("users", "用户"), ("settings", "设置")):
            ws.call("Runtime.evaluate",
                    {"expression": "APP.adminGo('%s')" % tab})
            time.sleep(1.6)
            shot(os.path.join(OUT, "web_6_后台_%s.png" % name), full=True)

    # ---- ⑥ 手机端（390×844，iPhone 尺寸）----
    print("  -- 手机端 --")
    ws.call("Emulation.setDeviceMetricsOverride",
            {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True})
    globals()["W"] = 390
    clear_cookie("dw_admin")
    nav(BASE + "/", 2.5)
    shot(os.path.join(OUT, "web_m1_登录页.png"))
    set_cookie("dw_sid", user_cookie)
    nav(BASE + "/", 4.0)
    shot(os.path.join(OUT, "web_m2_工作台.png"), full=True)
    # 商品墙很长，滚到「我的任务」单独截一张（顺便验证任务卡片在手机上的排版）
    ws.call("Runtime.evaluate", {"expression":
            "var c=document.querySelectorAll('.cardt')[2]; if(c) c.scrollIntoView({block:'start'});"})
    time.sleep(1.0)
    shot(os.path.join(OUT, "web_m5_任务卡片.png"))
    ws.call("Runtime.evaluate", {"expression":
            "var c=document.querySelectorAll('.cardt')[3]; if(c) c.scrollIntoView({block:'start'});"})
    time.sleep(0.7)
    shot(os.path.join(OUT, "web_m6_日志.png"))
    ws.call("Runtime.evaluate", {"expression": "window.scrollTo(0,0)"})
    time.sleep(0.5)
    ws.call("Runtime.evaluate", {"expression": "document.querySelector('.pcard').click()"})
    time.sleep(1.2)
    shot(os.path.join(OUT, "web_m3_创建任务.png"))
    ws.call("Runtime.evaluate", {"expression": "APP.closeModal()"})
    time.sleep(0.4)
    if admin_cookie:
        clear_cookie("dw_sid")
        set_cookie("dw_admin", admin_cookie)
        nav(BASE + "/admin", 4.0)
        shot(os.path.join(OUT, "web_m4_后台.png"), full=True)

    # ---- 控制台有没有报错 ----
    try:
        r = ws.call("Runtime.evaluate", {"expression":
                    "JSON.stringify(window.__errs||[])"})
        print("  页面错误:", r["result"].get("value"))
    except Exception:
        pass

    ws.close()
    try:
        proc.terminate()
    except Exception:
        pass
    print("\n截图已存入: %s" % OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
