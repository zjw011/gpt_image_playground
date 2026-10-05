# -*- coding: utf-8 -*-
"""代理 IP 池（桌面版 / Web 版共用）。

这个文件是**唯一的实现**，只依赖 ``requests``（socks 另需 ``PySocks``），
不碰数据库、不碰界面 —— 所以两边都能直接用：
  * 桌面版 exe：``dewu_sniper.py`` 里 ``import dewu_proxies as PX``
  * Web 版：``webapp/proxies.py`` 只是一层转发（``from dewu_proxies import *``）

只做三件事，全部是纯函数 / 轻状态，方便单测：

1. **解析**：把用户从 IP 商那儿复制来的一行行文本，变成规范的代理记录。
   国内动态 IP 商的格式五花八门，这里全都认（见 :func:`normalize_line`）。
2. **打码 + 检测**：给界面用的脱敏显示，以及「这个代理通不通、出口 IP 是几、
   延迟多少」的探测。
3. **选择**：把「一个池子」变成「抢兑循环每次调用时返回哪个代理」的策略函数。

关于协议
--------
* ``socks5h`` 让 DNS 在代理侧解析（域名也走代理），对国内 IP 商最稳；
* ``socks5`` 本地解析 DNS；
* ``http`` 就是普通的 CONNECT 隧道。

三者都靠 ``requests`` 原生支持，但 socks 需要 ``PySocks``（requirements 里已钉）。

⚠️ 还有个常见的坑：装了代理但 ``requests`` 没用上，通常是漏了 PySocks，
   表现是 ``Missing dependencies for SOCKS support``。
"""
import re
import time
from urllib.parse import quote, unquote, urlparse

__all__ = [
    "DEFAULT_SCHEME", "SCHEMES", "CHECK_URLS",
    "normalize_line", "normalize_many", "mask", "hostport", "proxies_map",
    "is_socks", "check", "is_proxy_error", "explain", "Provider",
    "provider_from_rows", "socks_ready", "describe_pool",
]

DEFAULT_SCHEME = "socks5h"
SCHEMES = ("socks5h", "socks5", "socks4", "http", "https")

# 出口 IP 探测地址（按顺序试，第一个通的就用）
#
# ★ 国内优先，而且**必须有国内站**。
#   踩过的坑：原先三个全是国外站（api.ipify.org / ip-api.com / ifconfig.me），
#   用户买的是**国内 IP**。国内代理的出口对国外站不保证通 —— 于是好代理也被
#   测成「没测通」。国内站还能顺带确认「代理是不是只能出国内」。
#   另外 api.ipify.org 在本机直连就返回 502（上游连接被拒），本来就不该排第一。
CHECK_URLS = (
    "http://ip.3322.net/",                    # 国内，纯文本回显 IP，最快最稳
    "http://myip.ipip.net/",                  # 国内，回显 IP + 归属地
    "http://members.3322.org/dyndns/getip",   # 国内，纯文本回显
    "http://ifconfig.me/ip",                  # 国外，纯文本
    "http://ip-api.com/json",                 # 国外，JSON
)
_IP_RE = re.compile(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b")
_IP_HEADERS = ("x-forwarded-for", "x-real-ip", "x-client-ip")


# ====================================================================== 解析
def normalize_line(line, default_scheme=DEFAULT_SCHEME):
    """一行文本 → 规范化代理 dict。认不出来返回 ``(None, 原因)``。

    支持的写法::

        1.2.3.4:1080                      → socks5h://1.2.3.4:1080
        1.2.3.4:1080:user:pass            → 国内 IP 商最常见的四段式
        user:pass@1.2.3.4:1080
        socks5://user:pass@1.2.3.4:1080
        http://user:pass@1.2.3.4:8080
        1.2.3.4:1080#上海电信             → # 或 | 后面是备注

    注意：四段式按第一个冒号切，所以**密码里不能再有冒号** —— 有的话请改成
    ``user:pa:ss@1.2.3.4:1080`` 这种带 ``@`` 的写法（密码里的 ``@`` 记得转义成 %40）。
    """
    raw = str(line or "").strip()
    if not raw or raw.startswith("#") or raw.startswith("//"):
        return None, "空行/注释"

    label = ""
    for sep in ("#", "|"):
        if sep in raw:
            raw, label = raw.split(sep, 1)
            raw, label = raw.strip(), label.strip()
            break

    scheme = ""
    if "://" in raw:
        scheme, _, raw = raw.partition("://")
        scheme = scheme.strip().lower()
        if scheme not in SCHEMES:
            return None, "不认识的协议 %r（支持 %s）" % (scheme, "/".join(SCHEMES))
    scheme = scheme or (default_scheme or DEFAULT_SCHEME).lower()
    if scheme not in SCHEMES:
        scheme = DEFAULT_SCHEME

    user = pw = ""
    if "@" in raw:
        cred, _, raw = raw.rpartition("@")
        if ":" in cred:
            user, _, pw = cred.partition(":")
        else:
            user = cred
    elif raw.count(":") == 3 and not raw.startswith("["):
        # 1.2.3.4:1080:user:pass
        host, port, user, pw = raw.split(":", 3)
        raw = "%s:%s" % (host, port)

    if ":" not in raw:
        return None, "缺少端口（写成 host:port）"
    host, _, port = raw.rpartition(":")
    host = host.strip().strip("[]")
    try:
        port = int(port)
        assert 0 < port < 65536
    except Exception:
        return None, "端口不合法"
    if not host:
        return None, "缺少主机"

    cred = ""
    if user:
        cred = quote(user, safe="") + ((":" + quote(pw, safe="")) if pw else "") + "@"
    url = "%s://%s%s:%d" % (scheme, cred, host, port)

    return {
        "url": url,
        "kind": "socks" if scheme.startswith("socks") else "http",
        "scheme": scheme,
        "host": host,
        "port": port,
        "user": user,
        "has_auth": bool(user),
        "label": label,
    }, None


def normalize_many(text, default_scheme=DEFAULT_SCHEME):
    """批量解析（一行一个）。返回 ``(items, errors)``，按 url 去重。"""
    items, errors, seen = [], [], set()
    for i, line in enumerate(str(text or "").splitlines(), 1):
        if not line.strip():
            continue
        d, err = normalize_line(line, default_scheme)
        if err:
            errors.append({"line": i, "text": line.strip()[:80], "err": err})
            continue
        if d["url"] in seen:
            continue
        seen.add(d["url"])
        items.append(d)
    return items, errors


# ====================================================================== 显示
def mask(url):
    """给界面用的脱敏串：密码打掉，用户名只留前两位。"""
    if not url:
        return ""
    try:
        u = urlparse(url)
    except Exception:
        return "***"
    auth = ""
    if u.username:
        auth = u.username[:2] + "***@" if len(u.username) > 2 else "***@"
    return "%s://%s%s:%s" % (u.scheme, auth, u.hostname or "?", u.port or "")


def hostport(d):
    """``1.2.3.4:1080`` 这样的短标签（列表 / 日志里用）。"""
    if isinstance(d, str):
        try:
            u = urlparse(d)
            return "%s:%s" % (u.hostname or "?", u.port or "")
        except Exception:
            return d
    return "%s:%s" % (d.get("host") or "?", d.get("port") or "")


def proxies_map(url):
    """``requests`` 需要的 ``proxies`` 参数（空 → None，也就是直连）。"""
    if not url:
        return None
    return {"http": url, "https": url}


def is_socks(url):
    return str(url or "").lower().startswith("socks")


def socks_ready():
    """socks 代理能不能用（缺 PySocks 时 requests 会直接抛异常）。

    提前问一下，好在界面上给一句人话提示，而不是等抢兑时才报
    ``Missing dependencies for SOCKS support``。
    """
    try:
        import socks  # noqa: F401
        return True
    except Exception:
        return False


# ====================================================================== 检测
def _extract_ip(text, headers=None):
    for h in _IP_HEADERS:
        v = (headers or {}).get(h)
        if v:
            m = _IP_RE.search(str(v))
            if m:
                return m.group(1)
    m = _IP_RE.search(str(text or ""))
    return m.group(1) if m else None


def check(url, timeout=8, check_urls=None):
    """探一次代理。返回 ``(ok, exit_ip, latency_ms, err)``。

    出口 IP 拿不到但请求本身成功，也算通（有些代理会吞掉回显）。

    ``err`` 是**给人看的一句话**（见 :func:`explain`），不是 requests 那串
    ``SOCKSHTTPConnectionPool(...)`` —— 那玩意儿对用户毫无意义。

    只有「代理地址本身连不上」或「代理拒绝我们」时才会在第一个地址就放弃；
    如果只是**某个探测站**过不去，会继续试下一个（见 :func:`_proxy_dead`）。
    """
    import requests
    prox = proxies_map(url)
    urls = tuple(check_urls or CHECK_URLS)
    last_err = "没试成功"
    t0 = time.time()
    for cu in urls:
        try:
            r = requests.get(cu, proxies=prox, timeout=timeout,
                             headers={"User-Agent": "Mozilla/5.0"})
            ms = int((time.time() - t0) * 1000)
            if r.status_code >= 400:
                last_err = "探测站返回 HTTP %s" % r.status_code
                t0 = time.time()
                continue
            ip = _extract_ip(r.text[:400], r.headers)
            return True, ip or "", ms, None
        except Exception as e:
            last_err = explain(e)
            if _proxy_dead(e):
                return False, "", int((time.time() - t0) * 1000), last_err
            t0 = time.time()
    if len(urls) > 1:
        # 代理连得上，但每个探测地址都被挡 —— 说清楚，别让用户以为代理坏了
        last_err = "%d 个探测地址都不通：%s" % (len(urls), last_err)
    return False, "", int((time.time() - t0) * 1000), last_err


def _chain_text(e):
    """把异常链（``__cause__``/``__context__``）里所有类名和消息拼成一串。

    ★ 必须走整条链。以「连不上代理」为例，最外层是::

        SOCKSHTTPConnectionPool(...): Max retries exceeded with url: /
        (Caused by NewConnectionError("SOCKSConnection(...): Failed to establish
         a new connection: [WinError 10061] 由于目标计算机积极拒绝，无法连接。"))

    这句话里**既没有** "connecting to SOCKS5 proxy"，**也没有**任何能区分
    「代理挂了」和「目标挂了」的信息 —— 真正有用的那句在链尾的
    ``ProxyConnectionError: Error connecting to SOCKS5 proxy 127.0.0.1:1: ...``。
    只看最外层就什么也判断不出来。
    """
    parts, seen = [], 0
    cur = e
    while cur is not None and seen < 8:
        parts.append(type(cur).__name__)
        parts.append(str(cur).replace("\n", " "))
        nxt = cur.__cause__ or getattr(cur, "__context__", None)
        if nxt is cur:
            break
        cur, seen = nxt, seen + 1
    return " | ".join(parts)


def _proxy_dead(e):
    """异常是否说明「代理本身用不了」—— 换探测地址也没用，可以立刻放弃。

    ★ 这里踩过一个很贵的坑。
    走 socks 时 requests 的连接池类名就叫 ``SOCKSConnectionPool``，
    于是**隧道里目标连不上**的异常字符串里必然含 "SOCKSConnection"。
    早先的实现是 ``any(k in s for k in ("SOCKSConnection", ...))`` ——
    等于把「代理能用、只是这个目标站被挡了」也判成「代理死了」，
    check() 立刻 return，**根本不去试后面的探测地址**，
    一个好代理就这么被判了死刑（真实案例：国内 s5 拒了 api.ipify.org，
    三个探测地址里第一个就不通 → 用户看到「没测通」）。

    正确做法：只认那几种**与目标无关**的失败 ——
      ① 连不上代理服务器本身（ProxyConnectionError / 连 SOCKS 代理失败）
      ② 代理不接受我们（0xFF：白名单没绑，或要账号密码）
    """
    s = _chain_text(e).lower()
    for k in (
        "connecting to socks",              # PySocks: Error connecting to SOCKS5 proxy
        "can't connect to proxy",
        "cannot connect to proxy",
        "unable to connect to proxy",       # requests: 走 http(s) 代理时
        "proxyconnectionerror",
        "invalid socks",
        "authentication methods were rejected",   # 0xFF
        "socks5autherror",
        "socks5 authentication failed",
    ):
        if k in s:
            return True
    return False


def explain(err):
    """把底层异常翻译成**一句人话**，给界面显示用。

    用户看到 ``SOCKSHTTPConnectionPool(host='api.ipify.org', port=80):
    Max retries exceeded with url: / (Caused by NewConnectionError(...))``
    是没法行动的；看到「代理拒绝连接：没通过它的认证，免密 s5 靠来源 IP
    白名单认人」才知道该去服务商后台干什么。
    """
    s = _chain_text(err).lower()
    for k, msg in _HINTS:
        if k in s:
            return msg
    # 认不出来就给压短的原文，别编
    return _short(err)


# 顺序有讲究：先匹配最具体的，再匹配笼统的
_HINTS = (
    ("authentication methods were rejected",
     "代理拒绝连接：没通过它的认证。免密的 s5 靠「来源 IP 白名单」认人 —— "
     "去服务商后台把这台机器的公网 IP 加进白名单（或换成账号密码模式）"),
    ("socks5 authentication failed", "代理拒绝连接：用户名/密码不对"),
    ("connecting to socks", "连不上代理服务器本身：地址或端口不对，也可能这个 IP 已过期"),
    ("can't connect to proxy", "连不上代理服务器本身：地址或端口不对，也可能这个 IP 已过期"),
    ("cannot connect to proxy", "连不上代理服务器本身：地址或端口不对，也可能这个 IP 已过期"),
    ("unable to connect to proxy", "连不上代理服务器本身：地址或端口不对，也可能这个 IP 已过期"),
    ("invalid socks", "这个地址不是合法的 SOCKS 代理（协议或端口不对）"),
    ("general socks server failure", "代理内部故障：它自己也连不上目标站"),
    ("connection closed unexpectedly", "代理中途把连接断了：常见于并发数或频率超限"),
    ("host unreachable", "目标站不可达"),
    ("network unreachable", "网络不可达"),
    ("connection refused", "目标站拒绝了连接"),
    ("timed out", "超时：代理无响应"),
    ("timeout", "超时：代理无响应"),
)


def _short(e):
    """异常信息压短：requests 的异常字符串经常拖一大堆 URL。"""
    s = str(e or "").strip().replace("\n", " ")
    if len(s) > 160:
        s = s[:160] + "…"
    return s or type(e).__name__


def is_proxy_error(err):
    """这个异常像是「代理本身坏了」而不是「目标站点的问题」。

    用来决定要不要给这个代理记一次失败、扫进坏池。
    """
    s = str(err or "").lower()
    for k in ("proxy", "tunnel", "socks", "connect timeout", "connection refused",
              "connection reset", "remote end closed", "407", "cannot connect"):
        if k in s:
            return True
    return False


# ====================================================================== 选择
class Provider:
    """把「一个代理池」变成「抢兑循环每次要用的那个代理」。

    为什么不是每次都换一个 IP ——
        抢兑循环的目标间隔是 200ms，每次换 IP 都要重新 TCP + TLS 握手
        （走代理通常 100~300ms），一换就把节奏打没了。所以默认是
        **固定一个 IP 用完这一轮**（sticky），只有：
          * 开了 rotate 模式且攒够 ``rotate_n`` 次，或者
          * 命中风控（调用方显式 :meth:`on_risk`）
        才换下一个。换的时候调用方**必须重建 requests 会话**，把旧隧道丢掉 ——
        否则 keep-alive 会继续复用老连接，出口 IP 根本没变。
    """

    def __init__(self, items, mode="sticky", rotate_n=0, user_id=None):
        self.items = [i for i in (items or []) if i and i.get("url")]
        self.mode = mode if mode in ("sticky", "rotate") else "sticky"
        self.rotate_n = max(0, int(rotate_n or 0))
        self.user_id = user_id
        self._idx = 0
        self._cur = None
        self._used = 0
        self._why = ""
        self.switches = []          # [url, ...] 这一轮用过的，日志里回显
        if self.items:
            # 固定模式：一开始就按 user_id 定好出口，不用等到 first request
            if self.mode == "sticky" and user_id is not None:
                self._idx = self._sticky_index()
            self._cur = self._pick(self._idx)

    # ---------------------------------------------------------------- 内部
    def _pick(self, idx):
        return self.items[idx % len(self.items)]

    def _sticky_index(self):
        """固定模式：同一个账号尽量总是同一个出口 IP（按 id 取模）。"""
        if self.user_id is None or not self.items:
            return 0
        return int(self.user_id) % len(self.items)

    # ---------------------------------------------------------------- 对外
    @property
    def enabled(self):
        return bool(self.items)

    def current(self):
        return self._cur

    @property
    def current_url(self):
        return (self._cur or {}).get("url")

    @property
    def current_id(self):
        return (self._cur or {}).get("id")

    def next(self):
        """取本次请求要用的 ``proxies`` dict（没配代理就返回 None = 直连）。"""
        if not self.items:
            return None
        if self._used and self.mode == "rotate" and self.rotate_n \
                and self._used % self.rotate_n == 0:
            self.on_risk("轮换")
        self._used += 1
        return proxies_map(self.current_url)

    def on_risk(self, why="风控"):
        """换个出口 IP。返回新 url（池子空则 None）。"""
        if not self.items:
            return None
        self._idx += 1
        self._cur = self._pick(self._idx)
        self._used = 0
        self.switches.append(self.current_url)
        self._why = why
        return self.current_url

    def describe(self):
        if not self.items:
            return "未启用代理（直连服务器本机 IP）"
        n = len(self.items)
        pos = self._idx % n + 1
        return "%s（池子 %d 个，第 %d 个%s）" % (
            mask(self.current_url), n, pos,
            "，%d 次一换" % self.rotate_n if self.mode == "rotate" and self.rotate_n
            else "，本轮固定")

    # 抢兑循环用这个：先别记次数，只挑一个
    def prime(self):
        if not self.items:
            return None
        if self.mode == "sticky" and self.user_id is not None:
            self._idx = self._sticky_index()
            self._cur = self._pick(self._idx)
        return self.current_url


def provider_from_rows(rows, mode="sticky", rotate_n=0, user_id=None):
    """数据库 / JSON 里的代理行 → :class:`Provider`。``rows`` 可以是 ORM 对象或 dict。"""
    items = []
    for r in rows or []:
        url = r.get("url") if isinstance(r, dict) else getattr(r, "url", None)
        if not url:
            continue
        items.append({"url": url, "id": (r.get("id") if isinstance(r, dict)
                                         else getattr(r, "id", None))})
    return Provider(items, mode=mode, rotate_n=rotate_n, user_id=user_id)


def describe_pool(rows):
    """给界面用的一句话池子概览：``4 个（3 可用 / 1 没测）``。"""
    rows = list(rows or [])
    alive = [r for r in rows if r.get("enabled", True)]
    ok = [r for r in alive if r.get("status") == "ok"]
    bad = [r for r in alive if r.get("status") == "bad"]
    new = [r for r in alive if r.get("status") in ("", None, "untested")]
    return "%d 个（%d 可用 / %d 没测 / %d 有问题）" % (
        len(rows), len(ok), len(new), len(bad))
