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

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import tianqiip                                        # noqa: E402

KEY = "tianqi"
# 抢兑前多久开始提 IP 并登录（秒）。用户要的「提前 2 分钟」。
LEAD_LOGIN_SEC = 120
# 提多长时间的 IP：3 分钟够走完「登录 + 等开抢 + 兑换重试」。
DEFAULT_LIFE = 3

FIELDS = ("enabled", "secret", "sign", "key", "auth_user", "auth_pass",
          "protocol", "life", "region", "yys")
MASK_FIELDS = ("secret", "sign", "key", "auth_pass")

DEFAULTS = {
    "enabled": False,
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
    for k in ("enabled",):
        out[k] = bool(v.get(k))
    try:
        out["protocol"] = int(out["protocol"] or 3)
    except (TypeError, ValueError):
        out["protocol"] = 3
    try:
        out["life"] = int(out["life"] or DEFAULT_LIFE)
    except (TypeError, ValueError):
        out["life"] = DEFAULT_LIFE
    if out["life"] not in tianqiip.LIVES:
        out["life"] = DEFAULT_LIFE
    if out["protocol"] not in tianqiip.PROTOCOLS:
        out["protocol"] = 3
    return out


def save_cfg(**kw):
    from .db import get_setting, put_setting
    cur = cfg()
    str_fields = ("secret", "sign", "key", "auth_user", "auth_pass",
                  "region", "yys", "last_ok_at", "last_err", "last_where")
    for k in str_fields:
        if k in kw and kw[k] is not None:
            cur[k] = str(kw[k]).strip()
    if "enabled" in kw and kw["enabled"] is not None:
        cur["enabled"] = bool(kw["enabled"])
    for k, lo, hi in (("protocol", 1, 3), ("life", 3, 15)):
        if k in kw and kw[k] not in (None, ""):
            try:
                cur[k] = max(lo, min(hi, int(kw[k])))
            except (TypeError, ValueError):
                pass
    if cur["life"] not in tianqiip.LIVES:
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
    out = {k: c[k] for k in ("enabled", "protocol", "life", "region", "yys",
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


def client(need_white=True):
    """按配置造一个 :class:`tianqiip.TianqiIP`；没配好返回 ``(None, 原因)``。"""
    c = cfg()
    ip = tianqiip.TianqiIP(
        secret=c["secret"], key=c["key"], sign=c["sign"],
        auth_user=c["auth_user"], auth_pass=c["auth_pass"],
        protocol=c["protocol"], life=c["life"],
        region=c["region"], yys=c["yys"])
    miss = ip.missing_white() if need_white else ip.missing()
    if miss:
        return None, "天启IP 还没配好，缺：%s" % "、".join(miss)
    return ip, ""


def one_proxy(need_white=True, life=None):
    """取一个**现提现用**的短效 IP。返回 ``(proxy_dict, err)``。

    ``proxy_dict`` 形如 ``{url, ip, port, where, expire_at, left}`` ——
    ``url`` 直接就是 ``socks5h://ip:port``，能喂给 requests 的 ``proxies``。
    """
    ip, err = client(need_white=need_white)
    if ip is None:
        return None, err
    if life and int(life) in tianqiip.LIVES:
        ip.life = int(life)
    item, err = ip.extract_lease()
    if err:
        save_cfg(last_err=str(err)[:200])
        return None, err
    d = item.as_proxy()
    where = d.get("where") or ""
    save_cfg(last_ok_at=datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
             last_err="", last_where=where)
    return d, ""


def proxies_map(url):
    """天启的 proxy url → requests 的 ``proxies`` dict。"""
    from . import proxies as PX
    return PX.proxies_map(url)
