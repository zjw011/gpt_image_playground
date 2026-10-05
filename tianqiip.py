# -*- coding: utf-8 -*-
"""天启IP（tianqiip.com）客户端 —— 按需提取短效 SOCKS5 代理。

为什么必须「按需提取」，不能手工导入
------------------------------------
天启的 IP 是**按次提取、寿命只有几分钟**的（``time`` 只支持 3 / 5 / 10 / 15）。
手工往代理池里粘一个 ``ip:port`` 是没用的：粘的那一刻它是活的，等你真要用
（几十分钟后）早就过期了 —— 服务端会直接拒绝，表现就是 TCP 连不上或握手回
``0xFF``。对应它的错误码 ``451  IP未提取或已过期``。

所以正确用法是：**要用的时候（T-2 分钟）再去提一个新的**。

免密的 s5 靠「来源 IP 白名单」认人
----------------------------------
天启返回的 IP 只有 ``ip`` 和 ``port``，**没有账号密码** —— 这种代理只能靠
来源 IP 白名单认证。所以跑程序这台机器的公网 IP 必须在白名单里
（``white/add``），否则代理会在握手阶段回 ``0xFF``
（= 它的 ``407 白名单IP校验失败``）。本模块的 :meth:`TianqiIP.ensure_white`
会帮你自动维护这件事。

设计约定
--------
* 只依赖 ``requests``。桌面版 exe 和 Web 版共用**这一份实现**。
* 所有对外方法返回 ``(数据, 错误)``：成功时 ``err is None``；失败时数据为
  空、``err`` 是一句**给人看的中文**（不是原始的 ``{"code":1003}``）。
* 错误码表按文档抄全，翻译见 :func:`explain`。
"""
import re
import socket
import time
from urllib.parse import urlencode

__all__ = [
    "BASE", "PROTOCOLS", "LIVES", "DEFAULT_LIFE", "TianqiIP", "Lease",
    "explain", "describe",
]

BASE = "http://api.tianqiip.com"
URL_GETIP = BASE + "/getip"
URL_WHITE_ADD = BASE + "/white/add"
URL_WHITE_DEL = BASE + "/white/delete"
URL_WHITE_FETCH = BASE + "/white/fetch"

# port 参数：1=HTTP 2=HTTPS 3=SOCKS5
PROTOCOLS = {1: "http", 2: "https", 3: "socks5"}

# port=3 拿到的 socks5，本地用哪种 scheme 去连（DNS 在代理侧解析更稳）
SOCKS_SCHEME = "socks5h"

# time 参数：按次提取的 IP 寿命，只支持这四个值
LIVES = (3, 5, 10, 15)
DEFAULT_LIFE = 3

MAX_NUM = 200

# 白名单接口固定参数
BRAND = 2

_IP_RE = re.compile(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b")


# ====================================================================== 错误码
# 三套错误码的段号是重叠的（都有 1001~1009），所以必须知道「这是哪个接口」。
EXTRACT_CODES = {
    1000: "提取成功",
    1001: "请求格式不正确（参数拼错了）",
    1002: "单次请求数量超出最大值（num 最多 200）",
    1003: "提取密钥异常 —— secret 填错了（它和账号 key 不是一个东西）",
    1004: "套餐已过期，去续费",
    1005: "套餐提取数量已达上限",
    1006: "暂无可用 IP —— 换个地区或运营商再试",
    1007: "提取地区超出服务范围",
}

WHITE_CODES = {
    200: "操作成功",
    1001: "参数有误",
    1002: "IP 地址格式无效",
    1003: "密钥或签名不正确（key / sign 填错了）",
    1004: "参数 sign 错误",
    1005: "不是代理用户",
    1006: "添加的新 IP 数量超过最大限制",
    1007: "IP 已存在（不用重复添加）",
    1008: "IP 地址不在服务范围",
    1009: "白名单里没有这个 IP，没什么可删的",
    1101: "服务端内部错误，稍后再试",
}

# 这些是**代理使用阶段**报的错（不通过 HTTP 接口回，而是代理直接拒绝你）。
# 列在这里是为了把「握手 0xFF / TCP 连不上」翻译成能行动的话。
PROXY_CODES = {
    407: "白名单校验失败 —— 本机公网 IP 没加到天启后台的白名单里",
    430: "客户端 IP 不是国内",
    431: "代理认证口令为空（这个套餐要账号密码，你却用免密方式连了）",
    432: "代理账号密码错误",
    434: "代理节点异常",
    435: "代理 IP 状态异常",
    436: "代理 IP 未经授权，或已超出使用时长",
    451: "IP 没提取过，或者已经过期了 —— 短效 IP 就是这样，要用时现提",
    452: "套餐信息异常",
    453: "IP 提取记录不存在",
    454: "套餐不存在",
    455: "用户信息异常",
    456: "未实名",
}


def explain(code, kind="extract"):
    """错误码 → 一句人话。``kind`` 取 ``extract`` / ``white`` / ``proxy``。"""
    try:
        code = int(code)
    except (TypeError, ValueError):
        return str(code)
    table = {"extract": EXTRACT_CODES, "white": WHITE_CODES, "proxy": PROXY_CODES}
    t = table.get(kind, EXTRACT_CODES)
    msg = t.get(code)
    if msg:
        return "%d  %s" % (code, msg)
    return "未知错误码 %d" % code


def describe(item):
    """IP 条目 → 界面上一行短描述，形如 ``辽宁鞍山 · 电信``。"""
    if not item:
        return ""
    parts = []
    prov = str(item.get("prov") or "").strip()
    city = str(item.get("city") or "").strip()
    loc = prov if (prov and prov == city) else (city or prov)
    if prov and city and prov != city and prov not in city:
        loc = "%s%s" % (prov, city)
    if loc:
        parts.append(loc)
    isp = str(item.get("isp") or "").strip()
    if isp:
        parts.append(isp)
    return " · ".join(parts)


# ====================================================================== 条目
class Lease:
    """一个提取出来的 IP（含它的寿命与归属地）。"""

    __slots__ = ("ip", "port", "city", "prov", "isp", "url", "expire_at", "item")

    def __init__(self, item, prefix=None, life=DEFAULT_LIFE):
        self.item = dict(item or {})
        self.ip = str(self.item.get("ip") or "").strip()
        self.port = int(self.item.get("port") or 0)
        self.city = str(self.item.get("city") or "").strip()
        self.prov = str(self.item.get("prov") or "").strip()
        self.isp = str(self.item.get("isp") or "").strip()
        proto = int(self.item.get("_protocol") or 3)
        if not prefix:
            proto_name = SOCKS_SCHEME if proto == 3 else PROTOCOLS.get(proto, "http")
            prefix = proto_name + "://"
        # ★ prefix 是**完整前缀**（可能含 socks5h://user:pass@），
        #   不要在这里再补一次 "://" —— 那样拼出来会是 socks5h://u:p@://ip:port。
        self.url = "%s%s:%d" % (prefix, self.ip, self.port)
        self.expire_at = _parse_expire(self.item.get("expire")) or (
            int(time.time()) + max(1, int(life or DEFAULT_LIFE)) * 60)

    @property
    def left(self):
        """还剩多少秒有效（负数 = 已过期）。"""
        return int(self.expire_at - time.time())

    def alive(self, need_sec=0):
        return self.left >= int(need_sec or 0)

    def where(self):
        """归属地短描述，界面直接显示。"""
        return describe(self.item)

    def as_proxy(self):
        """给 requests 用的代理 dict，同时也是入池用的行。"""
        return {
            "url": self.url,
            "ip": self.ip,
            "port": self.port,
            "where": self.where(),
            "exit_ip": self.ip,
            "expire_at": self.expire_at,
            "left": self.left,
        }

    def __repr__(self):
        return "<Lease %s %s 剩%ds>" % (self.url, self.where() or "?", self.left)


def _parse_expire(v):
    """``expire`` 字段没有固定格式，能认就认，认不出返回 None（交给调用方按寿命算）。

    可能是 unix 秒（10 位数字），也可能是 ``2026-10-05 13:20:00`` 这类字符串。
    """
    s = str(v or "").strip()
    if not s:
        return None
    if s.isdigit():
        n = int(s)
        if n > 10 ** 12:            # 毫秒
            n //= 1000
        if n > 10 ** 9:             # 2001 年以后，当 unix 秒
            return n
        return None
    m = re.search(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?", s)
    if m:
        y, mo, d, h, mi, se = (int(x or 0) for x in m.groups())
        try:
            return int(time.mktime((y, mo, d, h, mi, se, 0, 0, -1)))
        except (OverflowError, ValueError):
            return None
    return None


# ====================================================================== 客户端
class TianqiIP:
    """天启IP 的 HTTP 接口封装。

    参数
    ----
    secret  提取秘钥（getip 用；**注意它和账号 key 不是一回事**）
    key     用户账号（白名单接口用）
    sign    用户签名（两个接口都要）
    auth_user / auth_pass
            如果这个套餐是「账号密码模式」而不是白名单模式，填这里，
            生成出来的代理 URL 会带上它们。免密套餐留空。
    protocol 1=HTTP 2=HTTPS 3=SOCKS5，默认 3
    life    IP 寿命（分钟），只支持 3/5/10/15
    """

    def __init__(self, secret="", key="", sign="", auth_user="", auth_pass="",
                 protocol=3, life=DEFAULT_LIFE, timeout=15, base=BASE,
                 region="", yys=""):
        self.secret = str(secret or "").strip()
        self.key = str(key or "").strip()
        self.sign = str(sign or "").strip()
        self.auth_user = str(auth_user or "").strip()
        self.auth_pass = str(auth_pass or "").strip()
        self.protocol = int(protocol) if int(protocol or 3) in PROTOCOLS else 3
        self.life = int(life) if int(life or 0) in LIVES else DEFAULT_LIFE
        self.timeout = int(timeout or 15)
        self.base = (base or BASE).rstrip("/")
        self.region = str(region or "").strip()
        self.yys = str(yys or "").strip()
        self.last_code = None
        self.last_raw = ""

    # -------------------------------------------------------------- 配置自检
    @property
    def configured(self):
        """能不能提取 IP —— getip 要 secret + sign。"""
        return bool(self.secret and self.sign)

    @property
    def white_configured(self):
        """能不能管白名单 —— 要 key + sign。"""
        return bool(self.key and self.sign)

    def missing(self):
        """缺哪些配置，返回中文清单（界面直接显示）。"""
        out = []
        if not self.secret:
            out.append("提取秘钥(secret)")
        if not self.sign:
            out.append("用户签名(sign)")
        return out

    def missing_white(self):
        out = list(self.missing())
        if not self.key:
            out.append("用户账号(key)")
        return out

    def __repr__(self):
        return "<TianqiIP proto=%s life=%dmin %s>" % (
            PROTOCOLS.get(self.protocol), self.life,
            "已配置" if self.configured else "缺：%s" % "/".join(self.missing()))

    # -------------------------------------------------------------- 底层请求
    def _get(self, url, params, kind="extract"):
        """发一次请求，把 ``(code, data, msg)`` 拆出来。

        网络层失败也归一成 ``(None, None, 人话)``，调用方不用管 requests 的异常。
        """
        import requests
        try:
            r = requests.get(url, params=params, timeout=self.timeout,
                             headers={"User-Agent": "Mozilla/5.0"})
        except Exception as e:
            self.last_code = None
            self.last_raw = ""
            return None, None, "请求天启接口失败：%s" % _short(e)
        self.last_raw = (r.text or "")[:400]
        try:
            j = r.json()
        except ValueError:
            self.last_code = None
            return None, None, "天启返回的不是 JSON（HTTP %s）：%s" % (r.status_code,
                                                                   self.last_raw[:120])
        code = j.get("code")
        try:
            code = int(code)
        except (TypeError, ValueError):
            code = None
        self.last_code = code
        msg = j.get("msg") or j.get("Msg") or j.get("info") or ""
        # 两个接口的「成功」码不一样：提取是 1000，白名单是 200
        ok_codes = (1000,) if kind == "extract" else (200,)
        if code in ok_codes:
            return code, j.get("data"), None
        # 1007 对白名单 add 来说是「IP 已存在」，其实等价于「已经在里面了」
        if kind == "white" and code == 1007:
            return code, j.get("data"), None
        return code, None, (explain(code, kind) if code is not None
                            else "天启返回了无法识别的内容：%s" % self.last_raw[:120])

    # -------------------------------------------------------------- 提取 IP
    def extract(self, num=1, region=None, yys=None, dedup=True,
                want_expire=True):
        """提取 IP。返回 ``(list[dict], err)``；``err is None`` 表示成功。

        返回的每个 dict 除了天启给的字段，还多一个 ``_protocol``，
        :class:`Lease` 靠它拼出正确的代理 URL。
        """
        miss = self.missing()
        if miss:
            return [], "还没配好：缺 %s" % "、".join(miss)
        n = max(1, min(MAX_NUM, int(num or 1)))
        params = {
            "secret": self.secret,
            "sign": self.sign,
            "num": n,
            "port": self.protocol,
            "type": "json",
            "mr": 1 if dedup else 2,
        }
        # ★ time 是「按次提取」的必填项，只支持 3/5/10/15
        params["time"] = self.life
        reg = (region if region is not None else self.region) or ""
        if reg:
            params["region"] = reg
        yy = (yys if yys is not None else self.yys) or ""
        if yy:
            params["yys"] = yy
        if want_expire:
            params["ts"] = 1
        params["cs"] = 1        # 显示位置（城市）
        params["ys"] = 1        # 显示运营商

        code, data, err = self._get(self.base + "/getip", params, "extract")
        if err:
            return [], err
        items = data if isinstance(data, list) else ([data] if data else [])
        out = []
        for it in items:
            if not isinstance(it, dict):
                continue
            ip = str(it.get("ip") or "").strip()
            try:
                port = int(it.get("port") or 0)
            except (TypeError, ValueError):
                port = 0
            if not ip or not port:
                continue
            row = dict(it)
            row["ip"] = ip
            row["port"] = port
            row["_protocol"] = self.protocol
            out.append(row)
        if not out:
            return [], "天启返回成功但没给出可用 IP：%s" % self.last_raw[:120]
        return out, None

    def extract_lease(self, **kw):
        """提取**一个** IP 并包成 :class:`Lease`。返回 ``(lease, err)``。"""
        items, err = self.extract(num=1, **kw)
        if err:
            return None, err
        return Lease(items[0], self._prefix(), self.life), None

    def _prefix(self):
        """拼 URL 用的**完整前缀**，形如 ``socks5h://`` 或 ``socks5h://u:p@``。

        ★ 一定要连 ``://`` 一起返回。早先这个函数在有账号密码时返回带 ``://``、
        没密码时只返回 ``socks5h``，结果拼出来是 ``socks5h1.2.3.4:1080``。
        测试里专门盯住了这个。
        """
        base = SOCKS_SCHEME if self.protocol == 3 else PROTOCOLS.get(self.protocol, "http")
        if not self.auth_user:
            return base + "://"
        cred = self.auth_user
        if self.auth_pass:
            cred += ":" + self.auth_pass
        return "%s://%s@" % (base, cred)

    # -------------------------------------------------------------- 白名单
    def _white(self, path, ips=None):
        if not self.white_configured:
            return None, None, "还没配好：缺 %s" % "、".join(self.missing_white())
        params = {"key": self.key, "brand": BRAND, "sign": self.sign}
        if ips:
            params["ip"] = ",".join(ips) if isinstance(ips, (list, tuple)) else str(ips)
        return self._get(self.base + path, params, "white")

    def white_fetch(self):
        """查白名单。返回 ``(list[str], err)``。"""
        code, data, err = self._white("/white/fetch")
        if err:
            return [], err
        if isinstance(data, list):
            return [str(x).strip() for x in data if str(x).strip()], None
        if isinstance(data, str):
            return [x.strip() for x in re.split(r"[,\s]+", data) if x.strip()], None
        return [], None

    def white_add(self, ips):
        """加白名单（多个用列表传）。返回 ``(ok, 说明)``。"""
        ips = [ips] if isinstance(ips, str) else list(ips or [])
        if not ips:
            return False, "没给要添加的 IP"
        code, _data, err = self._white("/white/add", ips)
        if err:
            return False, err
        return True, "已加入白名单：%s" % "、".join(ips)

    def white_delete(self, ips):
        ips = [ips] if isinstance(ips, str) else list(ips or [])
        if not ips:
            return False, "没给要删除的 IP"
        code, _data, err = self._white("/white/delete", ips)
        if err:
            return False, err
        return True, "已从白名单移除：%s" % "、".join(ips)

    def ensure_white(self, ip=None):
        """保证白名单里有本机公网 IP。返回 ``(ok, 说明)``。

        免密的 s5 全靠这个认人 —— 没有它，代理会在握手阶段直接回 0xFF
        （= 天启的 ``407 白名单IP校验失败``），而报错信息完全看不出是这个原因。
        """
        if not ip:
            ip, err = my_ip()
            if err:
                return False, err
        cur, err = self.white_fetch()
        if err:
            return False, err
        if ip in cur:
            return True, "%s 已经在白名单里（共 %d 条）" % (ip, len(cur))
        ok, msg = self.white_add(ip)
        if not ok:
            return False, msg
        return True, "本机公网 IP %s 已加入白名单（原 %d 条）" % (ip, len(cur))

    # -------------------------------------------------------------- 一步到位
    def one_proxy(self, also_white=True):
        """**按需取一个 IP**，并规范化成能直接用的代理信息。

        返回 ``(dict, err)``，dict 里有 ``url / ip / port / where / expire_at``。
        这是给「T-2 分钟提一个，用完即弃」那条流程用的 —— **不做复用缓存**，
        因为每个账号每次动作都该是干净的出口。
        """
        if also_white and self.white_configured:
            ok, msg = self.ensure_white()
            if not ok:
                return None, "白名单没弄好：%s" % msg
        lease, err = self.extract_lease()
        if err:
            return None, err
        return lease.as_proxy(), None


def _short(e):
    s = str(e or "").strip().replace("\n", " ")
    return s[:160] + ("…" if len(s) > 160 else "")


# ====================================================================== 工具
def my_ip(timeout=10, urls=None):
    """本机公网 IP。返回 ``(ip, err)``。

    ★ **国内站优先**。这台机器的国外流量可能走别的出口（VPN / 中转），
    拿国外站查出来的 IP 不是「天启看到你」的那个 IP，拿去加白名单会白忙。
    """
    import requests
    if not urls:
        try:
            from dewu_proxies import CHECK_URLS as urls      # 单一事实来源
        except Exception:
            urls = ("http://ip.3322.net/", "http://myip.ipip.net/",
                    "http://members.3322.org/dyndns/getip")
    last = "没试成功"
    for u in urls:
        try:
            r = requests.get(u, timeout=timeout,
                             headers={"User-Agent": "Mozilla/5.0"})
            if r.status_code >= 400:
                last = "HTTP %s" % r.status_code
                continue
            m = _IP_RE.search(r.text or "")
            if m:
                return m.group(1), None
            last = "返回里没有 IP：%s" % (r.text or "")[:60]
        except Exception as e:
            last = _short(e)
    return "", "查不到本机公网 IP：%s" % last


def tcp_ok(host, port, timeout=5):
    """TCP 能不能连上（用来在界面上快速判断「这个 IP 还活着吗」）。"""
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((str(host), int(port)))
        return True
    except Exception:
        return False
    finally:
        try:
            s.close()
        except Exception:
            pass


def headers_get(params):
    """调试用：把要发的 query string 拼出来（**secret/sign/key 打码**）。"""
    masked = {}
    for k, v in (params or {}).items():
        s = str(v)
        masked[k] = (s[:4] + "***" + s[-2:]) if k in ("secret", "sign", "key") and len(s) > 8 else s
    # safe="*" 否则 * 会被转义成 %2A，看起来就不像打码了
    return urlencode(masked, safe="*")
