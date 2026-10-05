# -*- coding: utf-8 -*-
"""探针: 密码登录拿到的 token, 能不能直接拉 exchange_list?

背景
----
桌面版拉列表用的是「用户自己抓包的 H5 请求头」(platform:h5 / appid:h5 /
duToken / shumeiId / SK ...)，而 dewu_login.login() 走的是 App 端点，
用的是 App 风格请求头 (platform:iPhone / appId:duapp / dudeviceTrait ...)。

Web 版要「账号密码登录」，就必须回答一个问题:
    用 App 头 + 登录得到的 Bearer token, 能不能拉 exchange_list ?
本脚本做三组对照实验:

  A. H5 抓包头（账号 curl 原样）            ← 已知可行, 基准
  B. App 头（dewu_login.DEVICE_HEADERS）+ 同一个 Bearer token
  C. H5 头骨架 + 硬编码设备值（模拟"没有抓包"的 Web 用户）

只做 GET, 不改任何数据。
"""
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import requests  # noqa: E402

import dewu_login as LOGIN  # noqa: E402
from dewu_sniper import parse_curl  # noqa: E402

ACCOUNTS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                        "dist", "accounts.json")
LIST_PATH = "/hacking-game-platform/v1/gameplay/branch/exchange_list"
BASE = "https://app.dewu.com"
DROP = {"Host", "Content-Length", "Accept-Encoding", "Connection",
        "Sec-Fetch-Dest", "Sec-Fetch-Site", "Sec-Fetch-Mode", "traceparent"}


def get(url, headers, tag):
    h = {k: v for k, v in headers.items() if k not in DROP}
    try:
        r = requests.get(url, headers=h, timeout=10)
        raw = r.content
        txt = raw.decode("utf-8", "replace")
        try:
            j = json.loads(txt)
        except Exception:
            j = None
        code = (j or {}).get("code")
        msg = (j or {}).get("msg")
        n = len(((j or {}).get("data") or {}).get("prizes") or [])
        bal = ((j or {}).get("data") or {}).get("balance")
        print("  %-4s HTTP %-4s code=%-12s msg=%-24s 商品数=%-4s 余额=%s"
              % (tag, r.status_code, code, str(msg)[:24], n, bal))
        if code != 200:
            print("       原文前 200 字: %s" % txt[:200].replace("\n", " "))
        return code
    except Exception as e:
        print("  %-4s 异常: %r" % (tag, e))
        return None


def main():
    accs = json.load(open(ACCOUNTS, encoding="utf-8"))
    acc = accs[0]
    url, h5_headers, _, _ = parse_curl(acc["list_curl"])
    # 从 curl 里抠出 Bearer token
    bearer = None
    for k, v in h5_headers.items():
        if k.lower() == "x-auth-token" and v:
            bearer = v
    print("账号: %s" % acc["name"])
    print("URL : %s" % url[:110])
    print("token: %s…" % (bearer or "")[:38])
    print()

    print("【A】H5 抓包头原样（基准，应 200）")
    get(url, dict(h5_headers), "A")

    print()
    print("【B】App 头 (dewu_login.DEVICE_HEADERS) + 同一 Bearer token")
    app_h = dict(LOGIN.DEVICE_HEADERS)
    app_h["x-auth-token"] = bearer
    app_h["Cookie"] = "x-auth-token=" + (bearer or "")
    get(url, app_h, "B")

    print()
    print("【C】H5 头骨架 + 硬编码设备值（模拟没抓包的 Web 用户）")
    synth = {
        "platform": "h5", "appid": "h5", "appVersion": "5.99.6",
        "channel": "App Store", "deviceTrait": "iPhone", "device_model": "iPhone 17",
        "networktype": "WIFI", "countryCode": "CN", "isRoot": "0",
        "emu": "0", "isProxy": "0", "imei": "", "Accept": "*/*",
        "Origin": "https://cdn-m.dewu.com", "Referer": "https://cdn-m.dewu.com/",
        "Accept-Language": "zh-CN,zh-Hans;q=0.9",
        "User-Agent": LOGIN.DEVICE_HEADERS["webua"],
        "ua": LOGIN.DEVICE_HEADERS["webua"],
        "shumeiId": LOGIN.DEVICE_HEADERS["shumeiid"],
        "SK": LOGIN.DEVICE_HEADERS["SK"],
        "duid": LOGIN.DEVICE_BODY["duid"],
        "cookieToken": (bearer or "").replace("Bearer ", ""),
        "duToken": (bearer or "").replace("Bearer ", ""),
        "x-auth-token": bearer,
        "Cookie": "duToken=" + (bearer or "").replace("Bearer ", ""),
    }
    get(url, synth, "C")

    print()
    print("【D】B 变体: App 头 + 只保留 x-auth-token, 去掉 Cookie")
    app_h2 = dict(LOGIN.DEVICE_HEADERS)
    app_h2["x-auth-token"] = bearer
    app_h2.pop("Cookie", None)
    get(url, app_h2, "D")


if __name__ == "__main__":
    main()
