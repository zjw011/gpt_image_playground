# -*- coding: utf-8 -*-
"""Web 版的「天启IP」配置 + 客户端构造。

真正的实现在仓库根目录 :mod:`tianqiip`（桌面版 exe 和 Web 版共用，
和 `dewu_proxies.py` 同一个理由：桌面包里不该有 webapp/ 这棵依赖树）。

这里只干两件事：
  1. 把天启的凭据存在 ``Setting["tianqi"]`` 里（管理员在后台填）；
  2. 按这份配置造一个 :class:`tianqiip.TianqiIP`，给「抢兑前 2 分钟提一个
     短效 IP → 用**同一个 IP** 登录 → 到点兑换」那条流程用。
"""
import datetime
import os
import sys
import threading
import time
from urllib.parse import urlsplit, parse_qs

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import tianqiip                                        # noqa: E402
from .security import redact_message

_WHITE_LOCK = threading.Lock()
_WHITE_CACHE = {}
_LEASE_LOCK = threading.Lock()
_ACTIVE_IPS = {}
KEY = "tianqi"
# 抢兑前多久开始提 IP 并登录（秒）。用户要的「提前 2 分钟」。
LEAD_LOGIN_SEC = 120
# 提多长时间的 IP：3 分钟够走完「登录 + 等开抢 + 兑换重试」。
DEFAULT_LIFE = 3

FIELDS = ("auto_white", "enabled", "secret", "sign", "key", "auth_user", "auth_pass",
          "protocol", "life", "region", "yys")
MASK_FIELDS = ("secret", "sign", "key", "auth_pass")

DEFAULTS = {
    "enabled": False,
    "auto_white": True,
    "secret": "",          # 提取秘钥（getip 用）★ 和 key 不是一回事
    "sign": "",            # 用户签名（两个接口都要）
    "key": "",             # 用户账号（白名单接口用）
    "auth_user": "",       # 账号密码模式的用户名（免密套餐留空）
    "auth_pass": "",
    "protocol": 3,         # 1=HTTP 2=HTTPS 3=SOCKS5
    "life": DEFAULT_LIFE,  # 只支持 3/5/10/15 分钟
    "region": "",          # 指定省份（留空 = 不限）
    "yys": "",             # 指定运营商（留空 = 不限）
    "last_ok_at": "",
    "last_err": "",
    "last_where": "",
}


def cfg():
    from .db import get_setting
    v = get_setting(KEY) or {}
    if not isinstance(v, dict):
        v = {}
    out = dict(DEFAULTS)
    for k in DEFAULTS:
        if k in v and v[k] not in (None, ""):
            out[k] = v[k]
    for k in ("enabled", "auto_white"):
        out[k] = bool(v.get(k, DEFAULTS[k]))
    try:
        out["protocol"] = int(out["protocol"] or 3)
    except (TypeError, ValueError):
        out["protocol"] = 3
    try:
        out["life"] = int(out["life"] or DEFAULT_LIFE)
    except (TypeError, ValueError):
        out["life"] = DEFAULT_LIFE
    out["life"] = DEFAULT_LIFE
    if out["protocol"] not in tianqiip.PROTOCOLS:
        out["protocol"] = 3
    return out


def parse_api_url(url):
    """只解析配置，不发网络请求；不存储或回显包含密钥的完整链接。"""
    try:
        parsed = urlsplit(str(url).strip())
        if (parsed.scheme not in ("http", "https") or
                parsed.hostname != "api.tianqiip.com" or
                parsed.path != "/getip" or parsed.username or parsed.password or
                parsed.port not in (None, 80, 443) or parsed.fragment):
            raise ValueError()
        params = parse_qs(parsed.query, keep_blank_values=True)
        if any(len(values) != 1 for values in params.values()):
            raise ValueError()
        secret = params.get("secret", [""])[0].strip()
        sign = params.get("sign", [""])[0].strip()
        protocol = int(params.get("port", ["3"])[0])
        if not secret or not sign or protocol not in (1, 2, 3):
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError("请输入有效的天启 /getip 提取链接，必须包含 secret 和 sign") from None
    return {"secret": secret, "sign": sign, "protocol": protocol, "life": 3,
            "region": params.get("region", [""])[0],
            "yys": params.get("yys", [""])[0]}


def save_cfg(**kw):
    from .db import get_setting, put_setting
    cur = cfg()
    str_fields = ("secret", "sign", "key", "auth_user", "auth_pass",
                  "region", "yys", "last_ok_at", "last_err", "last_where")
    for k in str_fields:
        if k in kw and kw[k] is not None:
            cur[k] = str(kw[k]).strip()
    for field in ("enabled", "auto_white"):
        if field in kw and kw[field] is not None:
            cur[field] = bool(kw[field])
    for k, lo, hi in (("protocol", 1, 3), ("life", 3, 15)):
        if k in kw and kw[k] not in (None, ""):
            try:
                cur[k] = max(lo, min(hi, int(kw[k])))
            except (TypeError, ValueError):
                pass
    cur["life"] = DEFAULT_LIFE
    put_setting(KEY, cur)
    return cur


def _mask(v):
    s = str(v or "")
    if not s:
        return ""
    # 一定带星号：前端「回显的是打码值」就靠这个判据，别出现纯原文的边界情况
    if len(s) <= 6:
        return s[0] + "*" * max(1, len(s) - 1)
    return s[:2] + "*" * (len(s) - 2)


def public_view():
    """给界面看的配置：**密钥只回打码值**。"""
    c = cfg()
    out = {k: c[k] for k in ("enabled", "auto_white", "protocol", "life", "region", "yys",
                             "last_ok_at", "last_err", "last_where")}
    for k in FIELDS:
        if k in MASK_FIELDS:
            out[k] = _mask(c[k])
            out["has_" + k] = bool(c[k])
    out["auth_user"] = c["auth_user"]
    out["configured"] = configured()
    out["ready"] = ready()
    return out


def configured():
    """能不能提取 IP（getip 要 secret + sign）。"""
    c = cfg()
    return bool(c["secret"] and c["sign"])


def ready():
    """开没开 + 配没配好 —— 抢兑线程就按这个决定「提 IP 还是直连」。"""
    return bool(cfg()["enabled"] and configured())


class WebTianqiIP(tianqiip.TianqiIP):
    def _get(self, url, params, kind):
        # 每次调用只有一个 GET，禁止重定向，不重试。
        import requests
        try:
            response = requests.get(url, params=params, timeout=self.timeout,
                                    allow_redirects=False)
            if response.status_code != 200:
                return None, None, "天启 HTTP 状态异常，本轮不会重试提取"
            response.encoding = "utf-8"
            data = response.json()
        except (requests.RequestException, ValueError):
            return None, None, "天启请求失败或响应不是 JSON，本轮不会重试提取"
        if not isinstance(data, dict):
            return None, None, "天启返回格式错误"
        try:
            code = int(data.get("code"))
        except (TypeError, ValueError):
            return None, None, "天启返回缺少状态码"
        self.last_code = code
        if code in ((1000,) if kind == "extract" else (200, 1007)):
            return code, data.get("data"), None
        return code, None, tianqiip.explain(code, kind)

    def extract(self, **kwargs):
        # 一次只取一个 IP，统一最短租期与返回格式。
        self.life = 3
        params = {"secret": self.secret, "sign": self.sign, "num": 1,
                  "type": "json", "port": self.protocol, "time": 3,
                  "ts": 1, "ys": 1, "cs": 1, "mr": 1}
        if self.region:
            params["region"] = self.region
        if self.yys:
            params["yys"] = self.yys
        _, data, err = self._get(self.base + "/getip", params, "extract")
        if err:
            return [], err
        if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
            return [], "天启应返回一个代理，本轮不会重试提取"
        item = dict(data[0])
        try:
            import ipaddress
            ipaddress.ip_address(str(item.get("ip")))
            port = int(item.get("port"))
            if not 1 <= port <= 65535:
                raise ValueError()
        except (ValueError, TypeError):
            return [], "天启返回的 IP 或端口无效"
        item["_protocol"] = self.protocol
        return [item], None


def client(need_white=True):
    """按配置造一个 :class:`tianqiip.TianqiIP`；没配好返回 ``(None, 原因)``。"""
    c = cfg()
    ip = WebTianqiIP(
        secret=c["secret"], key=c["key"], sign=c["sign"],
        auth_user=c["auth_user"], auth_pass=c["auth_pass"],
        protocol=c["protocol"], life=c["life"],
        region=c["region"], yys=c["yys"])
    need_white = need_white and c["auto_white"]
    miss = ip.missing_white() if need_white and not (ip.auth_user and ip.auth_pass) else ip.missing()
    if miss:
        return None, "天启IP 还没配好，缺：%s" % "、".join(miss)
    return ip, ""


def one_proxy(need_white=True, life=None):
    """取一个**现提现用**的短效 IP。返回 ``(proxy_dict, err)``。

    ``proxy_dict`` 形如 ``{url, ip, port, where, expire_at, left}`` ——
    ``url`` 直接就是 ``socks5h://ip:port``，能喂给 requests 的 ``proxies``。
    """
    need_white = bool(need_white and cfg()["auto_white"])
    ip, err = client(need_white=need_white)
    if ip is None:
        return None, err
    if life and int(life) in tianqiip.LIVES:
        ip.life = int(life)
    if need_white and not (ip.auth_user and ip.auth_pass):
        fingerprint = (ip.key, ip.sign)
        with _WHITE_LOCK:
            if time.monotonic() >= _WHITE_CACHE.get(fingerprint, 0):
                ok, msg = ip.ensure_white()
                if not ok:
                    save_cfg(last_err="白名单失败")
                    return None, "白名单失败：%s" % redact_message(msg, (ip.secret, ip.sign, ip.key, ip.auth_pass))
                _WHITE_CACHE.clear()
                _WHITE_CACHE[fingerprint] = time.monotonic() + 300
    item, err = ip.extract_lease()
    if err:
        err = redact_message(err, (ip.secret, ip.sign, ip.key, ip.auth_pass))
        save_cfg(last_err=str(err)[:200])
        return None, err
    d = item.as_proxy()
    # 按出口 IP 去重（同 IP 不同端口也不能分给两个任务）。
    with _LEASE_LOCK:
        now = time.time()
        for address in list(_ACTIVE_IPS):
            if _ACTIVE_IPS[address] <= now:
                del _ACTIVE_IPS[address]
        address = d.get("ip")
        if address in _ACTIVE_IPS:
            save_cfg(last_err="平台返回了已占用的 IP，本轮停止")
            return None, "平台返回了已占用的 IP，本轮停止；不会再次付费提取"
        _ACTIVE_IPS[address] = d.get("expire_at") or now + ip.life * 60
    where = d.get("where") or ""
    save_cfg(last_ok_at=datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
             last_err="", last_where=where)
    return d, ""


def proxies_map(url):
    """天启的 proxy url → requests 的 ``proxies`` dict。"""
    from . import proxies as PX
    return PX.proxies_map(url)
