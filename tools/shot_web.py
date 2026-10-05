# -*- coding: utf-8 -*-
"""Web 版界面截图（无头 Edge + CDP）。

    python run_web.py                       # 先把服务跑起来
    python tools/shot_web.py [base_url] [out_dir]

桌面端：登录 / 概览 / 商品 / 创建任务 / 任务 / 日志 / 设置 / 后台四页
手机端：登录 / 概览 / 商品 / 任务 / 设置 / 后台
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


def main():
    br = find_browser()
    if not br:
        print("没找到 Edge / Chrome")
        return 1
    os.makedirs(OUT, exist_ok=True)

    # ---- 会话 cookie（用户 + 管理员）----
    accs = json.load(open(os.path.join(ROOT, "dist", "accounts.json"), encoding="utf-8"))
    s = requests.Session()
    r = s.post(BASE + "/api/login", json={"curl": accs[0]["list_curl"]}).json()
    print("用户登录:", r.get("ok"), r.get("msg", ""))
    user_cookie = s.cookies.get("dw_sid")
    s.post(BASE + "/api/products/refresh", json={})

    aw = requests.Session()
    admin_cookie = None
    pw_path = os.path.join(ROOT, "webdata", "ADMIN_PASSWORD.txt")
    if os.path.exists(pw_path):
        pw = open(pw_path, encoding="utf-8").read().strip()
        # 用户名可能被改过（默认 admin，本项目已改成 xiaole）
        for uname in (os.environ.get("ADMIN_USER"), "admin", "xiaole"):
            if not uname:
                continue
            if aw.post(BASE + "/api/admin/login",
                       json={"username": uname, "password": pw}).json().get("ok"):
                admin_cookie = aw.cookies.get("dw_admin")
                print("管理员：", uname)
                break
    print("管理员 cookie:", bool(admin_cookie))

    # 造一个「等待中」的任务，任务页/概览页才有东西可看；截完删掉。
    # 注意：全局开了「必须填兑换码」，所以得先让管理员发一个一次性码。
    made_task = None
    made_proxies = []
    st = s.get(BASE + "/api/state").json()
    ps = [p for p in st.get("products", []) if not p.get("outOfStock")]
    if ps and admin_cookie:
        code = ""
        g = aw.post(BASE + "/api/admin/codes/generate",
                    json={"count": 1, "quota": 1, "prefix": "SHOT",
                          "note": "截图演示（用完即弃）"}).json()
        if g.get("ok") and g.get("codes"):
            code = g["codes"][0]
        body = {"cId": ps[0]["cId"], "time": "10:00:00", "lead_ms": 300,
                "interval_ms": 200, "max_attempts": 600, "fallback": True}
        if code:
            body["code"] = code
        j = s.post(BASE + "/api/tasks", json=body).json()
        if j.get("ok"):
            made_task = j["task_id"]
            print("演示任务:", made_task, "（码 %s）" % code)
        else:
            print("演示任务没建上：", j.get("msg"))

    # 代理池里放几条假数据，"设置 → 代理 IP" 卡和"后台 → 代理 IP"页才有内容可看；截完删掉。
    if admin_cookie:
        before_ids = {p["id"] for p in
                      aw.get(BASE + "/api/admin/proxies").json().get("proxies", [])}
        aw.post(BASE + "/api/admin/proxies/import",
                json={"text": "112.17.36.108:1080:dewu:shot1#杭州电信 · 独享\n"
                              "120.79.44.21:1080:dewu:shot2#阿里云 · 独享\n"
                              "47.98.120.6:1080:dewu:shot3#杭州 · 独享\n"
                              "39.108.88.240:1080:dewu:shot4#深圳 · 备用\n"
                              "121.40.11.77:1080:dewu:shot5#上海 · 备用",
                      "scheme": "socks5h", "label": "截图演示（用完即弃）"})
        lst = aw.get(BASE + "/api/admin/proxies").json().get("proxies", [])
        made_proxies = [p["id"] for p in lst if p["id"] not in before_ids]
        # 造几条「已测过」的痕迹，免得整页都是「没测过」
        for i, p in enumerate([x for x in lst if x["id"] in made_proxies][:4]):
            aw.post(BASE + "/api/admin/proxies/%d" % p["id"],
                    json={"exit_ip": p["hostport"].split(":")[0], "latency_ms": 186 + i * 47,
                          "status": "ok" if i < 3 else "bad"})
        if made_proxies:
            aw.post(BASE + "/api/admin/proxies/auto_assign", json={"only_ok": False})
            aw.post(BASE + "/api/admin/settings", json={"proxy_enabled": True})
            s.post(BASE + "/api/settings",
                   json={"proxy": {"enabled": True, "mode": "sticky", "rotate_n": 20}})
            # 首页那个用户列表里的号可能不止一个，auto_assign 不一定轮到我们登录的这个 →
            # 显式把第 1 个代理绑给当前用户，设置页/概览页才有「当前出口」可看。
            uid = (s.get(BASE + "/api/me").json().get("user") or {}).get("id")
            if uid and made_proxies:
                aw.post(BASE + "/api/admin/proxies/%d" % made_proxies[0],
                        json={"bound_user_id": uid})
            _me = s.get(BASE + "/api/me").json()
            print("演示代理:", made_proxies, "· 用户%d" % (uid or 0),
                  "proxy.enabled =", (_me.get("settings") or {}).get("proxy", {}).get("enabled"),
                  "· assigned =", (_me.get("proxy") or {}).get("assigned"))

    port = free_port()
    proc = subprocess.Popen(
        [br, "--headless=new", "--remote-debugging-port=%d" % port,
         "--remote-allow-origins=*", "--no-first-run", "--no-default-browser-check",
         "--disable-gpu", "--hide-scrollbars",
         "--user-data-dir=" + os.path.join(OUT, "_shotprofile"),
         "--window-size=%d,%d" % (W, H), "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

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

    def js(expr, wait=0.0):
        ws.call("Runtime.evaluate", {"expression": expr, "awaitPromise": False})
        if wait:
            time.sleep(wait)

    def nav(url, wait_s=3.0):
        ws.call("Page.navigate", {"url": url})
        time.sleep(wait_s)

    def set_cookie(name, value):
        ws.call("Network.setCookie",
                {"name": name, "value": value, "domain": "127.0.0.1", "path": "/"})

    def clear_cookie(name):
        ws.call("Network.deleteCookies", {"name": name, "domain": "127.0.0.1"})

    def shot(name, full=False, width=None):
        args = {"format": "png"}
        if full:
            m = ws.call("Page.getLayoutMetrics")
            try:
                h = int(m["result"]["cssContentSize"]["height"])
                args["clip"] = {"x": 0, "y": 0,
                                "width": width or W, "height": min(h, 7000), "scale": 1}
                args["captureBeyondViewport"] = True
            except Exception:
                pass
        r = ws.call("Page.captureScreenshot", args, timeout=30)
        data = base64.b64decode(r["result"]["data"])
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(data)
        print("  → %s  (%d KB)" % (name, len(data) // 1024))

    # ================================================== ① 登录页
    clear_cookie("dw_sid")
    nav(BASE + "/", 2.5)
    shot("web_1_登录页.png")

    # ================================================== ② 用户端各页
    set_cookie("dw_sid", user_cookie)
    nav(BASE + "/", 4.0)
    shot("web_2_概览.png", full=True)

    js("APP.go('products')", 1.4)
    shot("web_3_商品.png")

    js("document.querySelector('.pcard').click()", 1.2)
    shot("web_4_创建任务.png")
    js("APP.closeModal()", 0.4)

    js("APP.go('tasks')", 1.2)
    shot("web_5_任务.png")

    js("APP.go('settings')", 1.4)
    shot("web_6_设置.png", full=True)
    # ★ 用户端做减法后的自检：公告卡在、二维码真的加载出来了（不是裂图）、
    #   代理 IP / 每日答题 / 库存监听 三张卡确实没了。
    _chk = ws.call("Runtime.evaluate", {"returnByValue": True, "awaitPromise": True, "expression":
        """(() => {
             const q = (s) => document.querySelector(s);
             const img = q('#sec-notice img');
             const link = q('#sec-push a[href*="pushplus"]');
             return JSON.stringify({
               notice: !!q('#sec-notice'),
               qrLoaded: !!(img && img.complete && img.naturalWidth > 0),
               qrW: img ? img.naturalWidth : 0,
               pushLink: link ? link.href : '',
               goneProxy: !q('#sec-proxy'),
               goneAnswer: !q('#sec-answer'),
               goneWatch: !q('#sec-watch'),
               headWatchPill: !!q('#pillWatch'),
             });
           })()"""})
    print("  设置页自检:", _chk["result"]["result"].get("value"))

    js("APP.go('logs')", 1.2)
    shot("web_7_日志.png")

    # ================================================== ③ 管理后台
    if admin_cookie:
        clear_cookie("dw_sid")
        set_cookie("dw_admin", admin_cookie)
        nav(BASE + "/admin", 4.0)
        shot("web_a1_后台_概览.png", full=True)
        for tab, name in (("codes", "兑换码"), ("users", "用户"),
                          ("proxies", "代理IP"), ("settings", "设置")):
            js("APP.adminGo('%s')" % tab, 1.8)
            shot("web_a2_后台_%s.png" % name, full=True)

    # ================================================== ④ 手机端
    print("  -- 手机端 390x844 --")
    ws.call("Emulation.setDeviceMetricsOverride",
            {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True})
    clear_cookie("dw_admin")
    nav(BASE + "/", 2.5)
    shot("web_m1_登录页.png")
    set_cookie("dw_sid", user_cookie)
    nav(BASE + "/", 4.0)
    shot("web_m2_概览.png", full=True, width=390)
    for v, name in (("products", "商品"), ("tasks", "任务"), ("settings", "设置")):
        js("APP.go('%s')" % v, 1.6)
        shot("web_m3_%s.png" % name, width=390)
    js("APP.go('products')", 1.4)
    js("document.querySelector('.pcard').click()", 1.2)
    shot("web_m4_创建任务.png", width=390)
    js("APP.closeModal()", 0.4)
    if admin_cookie:
        clear_cookie("dw_sid")
        set_cookie("dw_admin", admin_cookie)
        nav(BASE + "/admin", 4.0)
        shot("web_m5_后台.png", width=390)

    # ================================================== 收尾
    try:
        r = ws.call("Runtime.evaluate", {"expression": "JSON.stringify(window.__errs||[])"})
        print("  页面错误:", r["result"].get("value"))
    except Exception:
        pass
    ws.close()
    try:
        proc.terminate()
    except Exception:
        pass

    if made_task:
        try:
            s.post(BASE + "/api/tasks/%d/delete" % made_task, json={})
            print("已清理演示任务", made_task)
        except Exception:
            pass

    if made_proxies:
        try:
            aw.post(BASE + "/api/admin/settings", json={"proxy_enabled": False})
            s.post(BASE + "/api/settings", json={"proxy": {"enabled": False}})
            aw.post(BASE + "/api/admin/proxies/delete", json={"ids": made_proxies})
            print("已清理演示代理", len(made_proxies))
        except Exception:
            pass

    print("\n截图已存入: %s" % OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
