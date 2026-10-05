# -*- coding: utf-8 -*-
"""得物「手机号 + 密码」免抓包登录。

从得物 APK 里逆向出的两处客户端加密（完全离线可复现，不需要抓包）：
  1. userName = AES-128-ECB(手机号, key="mobile0123456789") 的十六进制 + "_1"
     （密钥 mobile0123456789 是 APK 里硬编码的字符串常量）
  2. password = md5(明文密码 + "du")

登录成功后服务端在【响应头 X-Auth-Token】里直接返回真实账号 token（有效期 365 天）。
另外实测：URL 上的 newSign 签名服务端并不校验。

注意：登录还必须携带一组真实的设备指纹请求头（数美风控 shumeiid/SK/adi/ltk/stoken/edk/dhw/rtk
等，服务端会校验其有效性）。默认值取自抓包，可在 exe 同目录放 device.json 覆盖。
"""

import base64
import gzip
import hashlib
import json
import os
import ssl
import time
import urllib.error
import urllib.request
import zlib

LOGIN_URL = ("https://app.dewu.com/api/v1/app/user_core/users/unionLogin"
             "?newSign=1888241205ce19ad5d1766221c2c3e6a")
AES_KEY = b"mobile0123456789"
PHONE_SUFFIX = "_1"

# ---------------------------------------------------------------- AES-128-ECB
_SBOX = bytes.fromhex(
    "637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0"
    "b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b275"
    "09832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cf"
    "d0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2"
    "cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdb"
    "e0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08"
    "ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9e"
    "e1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16")
_RCON = (0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36)


def _xtime(a):
    a <<= 1
    return (a ^ 0x1b) & 0xff if a & 0x100 else a


def _key_schedule(key):
    w = [list(key[i * 4:i * 4 + 4]) for i in range(4)]
    for i in range(4, 44):
        t = list(w[i - 1])
        if i % 4 == 0:
            t = t[1:] + t[:1]
            t = [_SBOX[b] for b in t]
            t[0] ^= _RCON[i // 4 - 1]
        w.append([w[i - 4][j] ^ t[j] for j in range(4)])
    return [sum(w[r * 4:r * 4 + 4], []) for r in range(11)]


def _encrypt_block(rk, block):
    s = [[block[r + 4 * c] for c in range(4)] for r in range(4)]

    def ark(k):
        for c in range(4):
            for r in range(4):
                s[r][c] ^= k[4 * c + r]

    def sub():
        for r in range(4):
            for c in range(4):
                s[r][c] = _SBOX[s[r][c]]

    def shift():
        for r in range(1, 4):
            s[r] = s[r][r:] + s[r][:r]

    def mix():
        for c in range(4):
            a0, a1, a2, a3 = s[0][c], s[1][c], s[2][c], s[3][c]
            t = a0 ^ a1 ^ a2 ^ a3
            s[0][c] = a0 ^ t ^ _xtime(a0 ^ a1)
            s[1][c] = a1 ^ t ^ _xtime(a1 ^ a2)
            s[2][c] = a2 ^ t ^ _xtime(a2 ^ a3)
            s[3][c] = a3 ^ t ^ _xtime(a3 ^ a0)

    ark(rk[0])
    for rnd in range(1, 10):
        sub(); shift(); mix(); ark(rk[rnd])
    sub(); shift(); ark(rk[10])
    return bytes(s[r][c] for c in range(4) for r in range(4))


_KS_CACHE = {}


def aes128_ecb_encrypt(key, data):
    rk = _KS_CACHE.get(key)
    if rk is None:
        rk = _key_schedule(key)
        _KS_CACHE[key] = rk
    out = bytearray()
    for i in range(0, len(data), 16):
        out += _encrypt_block(rk, data[i:i + 16])
    return bytes(out)


# ---------------------------------------------------------------- 两个加密
def encrypt_username(phone, key=AES_KEY, suffix=PHONE_SUFFIX):
    """手机号 -> userName（抓包里的 596d22ad..._1 就是这么来的）"""
    pt = str(phone).strip().encode("utf-8")
    pad = 16 - (len(pt) % 16)
    pt = pt + bytes([pad]) * pad
    return aes128_ecb_encrypt(key, pt).hex() + suffix


def md5_password(password, salt="du"):
    """明文密码 -> password 字段（md5(密码 + "du")）"""
    return hashlib.md5((str(password) + salt).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- 设备指纹头
# 服务端会校验这些头的有效性，缺失 → 401，值被伪造 → 460（风控）
DEVICE_HEADERS = {
    "platform": "iPhone", "dudeviceTrait": "iPhone12,1", "dhwapp": "dewu",
    "isRoot": "0", "sks": "0,idw2", "fcuuid": "UUID5cbf67dc0ca447ce9fd268b3eb842229",
    "emu": "0", "isProxy": "0",
    "shumeiid": "202311100852044fe93c6d40e8792ed3d6dd8bff2822ac61b083b6d92adf57",
    "User-Agent": ("DUApp/5.98.1 (com.siwuai.duapp; build:5.98.1.550; iOS 17.4.1) "
                   "DuNetClient/118.0.5953.0"),
    "appId": "duapp", "adi": "EjwJj_0TMsFi6VWzW7ntExGJk8VW_mK157GpJSYaIfU=",
    "v": "5.98.1", "mode": "0",
    # ⚠ 这个 timestamp 必须保持抓包时的原值：整套设备指纹头（数美风控）与它绑定，
    #   换成当前时间会被服务端判为风控异常（code=460）。实测位置无关，只有取值敏感。
    "timestamp": "1789785391620",
    "ltk": "8joov1bTx17OE5gDKrU99kigforFONbHSQPtslPQv9gYW9Ts9FC1",
    "skc": "IPrMsQDfGeOzB8azSdRe4", "brand": "Apple",
    "stoken": ("BQBqrfUTXELh8hUFzmSR1MpG6FUIcFdyJgSdha_W6ig4sXhKiixE9_wPRj0Ob5XV0uAOZmPvUB6"
               "ym74yHZ8CFBiUyQ"),
    "SK": ("9MPeIeDymUWCTljquJhTcAWowS0Z1mwwFZ35ycOeVqOGjIYTcjDIs4dkYycyC4vRbr1IXk8X557v"
           "2kGon3AkSU8Qx11x"),
    "app_build": "5.98.1.550",
    "webua": ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 "
              "(KHTML, like Gecko) Mobile/15E148"),
    "dhw": "551f9a3402a00789b2404cede43358dbb5f8098f1c2292881f9d",
    "Content-Type": "application/json",
    "token": "JLIjsdLjfsdII%3D%7CMTQxODg3MDczNA%3D%3D%7C07aaal32795abdeff41cc9633329932195",
    "edk": ("7d7d616c355d5d414c3d6b6a6e3e3f6c6b386b693c3c3f6b6d316e6c3a3e306a3b6d6a303c"
            "3a3a3a31"),
    "rtk": "XsUSxLJU3ri5SFrIuDFB0enbBLDc", "rccap": "0",
    "Accept-Language": "zh-Hans-CN;q=1.0, en-CN;q=0.9",
    "ipvx": "223.88.71.134",
}
DEVICE_BODY = {
    "duid": ("13dc56204c7e3ee1fd15597980a856034447a6dc03193868054a2917344fa9d5"
             "6c4574a787b993c81c8e9ca6d913e8b1"),
    "shumeiid": DEVICE_HEADERS["shumeiid"],
    "token": DEVICE_HEADERS["token"],
}
DEFAULT_ACTIVITY = "20260917"


def load_override(path):
    """允许用同目录的 device.json 覆盖设备指纹（换手机/换账号后可用）"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        return None
    return d if isinstance(d, dict) else None


# ---------------------------------------------------------------- 登录
def _decode(raw):
    if raw[:2] == b"\x1f\x8b":
        return gzip.decompress(raw)
    if raw[:2] == b"\x78\x9c":
        return zlib.decompress(raw)
    return raw


def _jwt_user_id(token):
    try:
        part = token.replace("Bearer ", "").split(".")[1]
        part += "=" * (-len(part) % 4)
        return json.loads(base64.urlsafe_b64decode(part)).get("userId")
    except Exception:
        return None


def _send_login(headers, data, timeout, proxies=None):
    """发登录请求，返回 ``(status, headers, raw)``。

    ``proxies is None`` 时走原来的 urllib 路径 —— **桌面版的行为一个字节都不变**。
    给了 ``proxies``（``{"http": ..., "https": ...}``）才换成 requests：
    urllib 自己不带 SOCKS，而短效 IP 基本都是 socks5h。
    """
    if not proxies:
        req = urllib.request.Request(LOGIN_URL, data=data, headers=headers, method="POST")
        ctx = ssl.create_default_context()
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()
    import requests                                    # 懒加载：直连用不到它
    r = requests.post(LOGIN_URL, data=data, headers=headers, timeout=timeout,
                      proxies=proxies)
    return r.status_code, dict(r.headers), r.content


def login(phone, password, activity=None, override=None, timeout=25, proxies=None):
    """手机号 + 密码 登录，返回:
    {ok, token, user_id, activity, msg}

    ``proxies`` 给了就走代理登录 —— 「开抢前 2 分钟提一个短效 IP、
    用**同一个 IP** 登录再兑换」靠的就是它（一个号一个出口）。
    """
    phone = str(phone).strip()
    if not phone.isdigit() or len(phone) != 11:
        return {"ok": False, "msg": "请输入 11 位手机号"}
    if not password:
        return {"ok": False, "msg": "请输入密码"}

    ov = override if isinstance(override, dict) else {}
    headers = dict(DEVICE_HEADERS)
    headers.update(ov.get("headers") or {})
    body_dev = dict(DEVICE_BODY)
    body_dev.update(ov.get("body") or {})
    # 注意：不要把 headers["timestamp"] 改成当前时间 —— 见 DEVICE_HEADERS 里的说明。
    # 请求体里的 timestamp 用当前时间没问题（实测不影响）。
    now_ms = str(int(time.time() * 1000))

    body = {
        "app_build": "5.98.1.550", "appId": "duapp", "brand": "Apple",
        "cipherParam": "userName", "countryCode": 86,
        "emu": "0", "isProxy": "0", "isRoot": "0", "mode": "0",
        "password": md5_password(password),
        "platform": "iPhone",
        "timestamp": now_ms, "type": "pwd",
        "userName": encrypt_username(phone), "v": "5.98.1",
    }
    body.update(body_dev)

    data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    try:
        status, hdrs, raw = _send_login(headers, data, timeout, proxies)
    except Exception as e:
        return {"ok": False, "msg": "网络错误：%r" % e}

    raw = _decode(raw)
    try:
        js = json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        js = {}
    code = js.get("code")

    tok = None
    for k, v in hdrs.items():
        if k.lower() == "x-auth-token":
            tok = v
            break

    if status == 200 and tok:
        return {"ok": True, "token": tok, "user_id": _jwt_user_id(tok),
                "activity": activity or DEFAULT_ACTIVITY, "msg": "登录成功"}
    if code == 460 or status == 401 and not tok:
        return {"ok": False, "code": code,
                "msg": "登录被拒绝（code=%s）。\n\n"
                       "可能原因：\n"
                       "· 手机号或密码不对\n"
                       "· 设备指纹头已失效，需要重新抓一次包并在 device.json 里更新\n"
                       "· 短时间内请求过多，被风控，稍后再试" % code}
    return {"ok": False, "code": code, "msg": "登录失败：HTTP %s code=%s" % (status, code)}


def build_list_curl(token, activity=None, override=None):
    """用登录拿到的 token 拼出与「抓包 curl」等价的字符串，
    这样能直接复用现有的账号导入/去重/刷新逻辑。"""
    ov = override if isinstance(override, dict) else {}
    headers = dict(DEVICE_HEADERS)
    headers.update(ov.get("headers") or {})
    act = str(activity or DEFAULT_ACTIVITY)
    parts = ["curl 'https://app.dewu.com/hacking-game-platform/v1/gameplay/branch/"
             "exchange_list?activity=%s'" % act]
    merged = dict(headers)
    merged["x-auth-token"] = token
    for k, v in merged.items():
        if k.lower() in ("content-type", "accept-encoding", "host", "content-length"):
            continue
        parts.append("-H '%s: %s'" % (k, v))
    return " ".join(parts)
