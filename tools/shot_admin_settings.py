# -*- coding: utf-8 -*-
"""管理后台「全局设置」整页截图（无头 Edge + CDP）。

    python run_web.py                           # 先把服务跑起来
    python tools/shot_admin_settings.py [base_url] [out_png]

比 shot_web.py 轻：只打一页，用来改管理端界面之后快速看一眼。
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

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "dist", "admin_settings.png")
W, H = 1360, 940


def free_port(start=9541, tries=60):
    import socket
    for p in range(start, start + tries):
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", p))
            return p
        except OSError:
            continue
        finally:
            s.close()
    raise RuntimeError("没有空闲端口")


def admin_cookie():
    """登一次管理员，拿到 dw_admin。用户名可能被改过 → 依次兜底。"""
    pw_path = os.path.join(ROOT, "webdata", "ADMIN_PASSWORD.txt")
    if not os.path.exists(pw_path):
        print("缺少 webdata/ADMIN_PASSWORD.txt")
        return None
    pw = open(pw_path, encoding="utf-8").read().strip()
    s = requests.Session()
    for uname in (os.environ.get("ADMIN_USER"), "admin", "xiaole"):
        if not uname:
            continue
        try:
            j = s.post(BASE + "/api/admin/login",
                       json={"username": uname, "password": pw}).json()
        except Exception as e:                       # noqa: BLE001
            print("登录请求失败：%r" % (e,))
            return None
        if j.get("ok"):
            print("管理员：", uname)
            return s.cookies.get("dw_admin")
    print("管理员登录失败（试过 ADMIN_USER / admin / xiaole）")
    return None


def main():
    br = find_browser()
    if not br:
        print("没找到 Edge / Chrome")
        return 1
    ck = admin_cookie()
    if not ck:
        return 1
    os.makedirs(os.path.dirname(OUT), exist_ok=True)

    port = free_port()
    profile = os.path.join(ROOT, "webdata", "_shot_profile")
    proc = subprocess.Popen(
        [br, "--headless=new", "--disable-gpu", "--no-first-run",
         "--remote-debugging-port=%d" % port,
         "--user-data-dir=%s" % profile, "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    ws = None
    try:
        import urllib.request
        targets = None
        for _ in range(70):
            try:
                targets = json.loads(urllib.request.urlopen(
                    "http://127.0.0.1:%d/json/list" % port, timeout=3).read())
                break
            except Exception:                        # noqa: BLE001
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
        ws.call("Page.navigate", {"url": BASE + "/"})
        time.sleep(3.0)
        _shot(ws, os.path.join(os.path.dirname(OUT), "web_1_登录页.png"))
        ws.call("Network.setCookie",
                {"name": "dw_admin", "value": ck, "domain": "127.0.0.1", "path": "/"})
        ws.call("Page.navigate", {"url": BASE + "/admin"})
        time.sleep(4.0)
        ws.call("Runtime.evaluate",
                {"expression": "APP.adminGo('settings')", "awaitPromise": False})
        time.sleep(2.0)
        _shot(ws, OUT, full=True)
    finally:
        if ws is not None:
            ws.close()
        proc.terminate()
    return 0


def _shot(ws, path, full=False):
    args = {"format": "png"}
    if full:
        m = ws.call("Page.getLayoutMetrics")
        h = int(m["result"]["cssContentSize"]["height"])
        args["clip"] = {"x": 0, "y": 0, "width": W, "height": min(max(h, H), 6000),
                        "scale": 1}
        args["captureBeyondViewport"] = True
    r = ws.call("Page.captureScreenshot", args, timeout=40)
    data = base64.b64decode(r["result"]["data"])
    with open(path, "wb") as f:
        f.write(data)
    print("  → %s  (%d KB)" % (path, len(data) // 1024))


if __name__ == "__main__":
    sys.exit(main())
