# -*- coding: utf-8 -*-
"""
网页登录助手（免抓包）

原理
----
调用系统自带的 Edge / Chrome，打开得物官方 H5 页面。用户在**真实页面上自己登录**
（手机号 + 验证码，或账号密码），然后进入「金币兑换」活动页。
本模块通过浏览器的 DevTools 协议(CDP)观察该浏览器发出的网络请求，
一旦看到得物列表接口（URL 含 exchange_list）的请求，就把它的
URL + 完整请求头（含 x-auth-token）原样导出成一段等价 curl。

效果与手动抓包完全一致，但：
  · 不用装抓包工具、不用装证书；
  · 不用复制几千字符的 curl（不会碰到 2048 截断、输入法改引号那些坑）；
  · 不解析、不伪造、不绕过任何登录签名 —— 登录是用户本人在官方页面上完成的。

浏览器使用**独立 profile 目录**（与用户日常浏览器隔离），登录态可跨次保留：
下一次打开时通常已经是登录状态，只需点进活动页即可。
"""
import os
import json
import time
import socket
import struct
import base64
import subprocess
import threading
import urllib.request

BROWSER_PATHS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]

# 用移动端 UA，让站点走 H5 分支（与抓包里的 appid: h5 / platform: h5 一致）
MOBILE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) "
             "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1")

DEFAULT_START = "https://www.dewu.com/"
DEFAULT_KEYWORD = "exchange_list"

# 生成 curl 时要丢掉的「传输层」头（由客户端自己决定，不该写死在请求里）
HOP_HEADERS = {
    "host", "content-length", "connection", "accept-encoding", "proxy-connection",
    "upgrade-insecure-requests", "te", "trailer", "transfer-encoding", "keep-alive",
}


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def find_browser():
    """返回可用的 Edge / Chrome 可执行文件路径，找不到返回 None"""
    for p in BROWSER_PATHS:
        if os.path.exists(p):
            return p
    return None


def default_profile_dir():
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(base, "得物整点抢兑助手", "browser_profile")


def _free_port(start=9411, tries=40):
    for p in range(start, start + tries):
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", p))
            return p
        except OSError:
            continue
        finally:
            s.close()
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _shell_quote(s):
    """POSIX 单引号安全包裹（shlex.split 可直接还原）"""
    return "'" + str(s).replace("'", "'\\''") + "'"


def _ci_get(headers, name):
    """大小写不敏感取请求头"""
    low = name.lower()
    for k, v in (headers or {}).items():
        if k.lower() == low:
            return v
    return None


def build_curl(url, headers, method="GET", body=None):
    """把 URL + 请求头拼成一段等价 curl（可被 dewu_sniper.parse_curl 解析）"""
    parts = ["curl %s" % _shell_quote(url)]
    m = (method or "GET").upper()
    if m != "GET":
        parts.append("-X %s" % m)
    for k, v in (headers or {}).items():
        if not k or k.startswith(":"):
            continue
        if k.lower() in HOP_HEADERS:
            continue
        if v is None:
            continue
        parts.append("-H %s" % _shell_quote("%s: %s" % (k, v)))
    if body:
        parts.append("--data-raw %s" % _shell_quote(body))
    return " ".join(parts)


def activity_of(url):
    import re
    m = re.search(r"[?&]activity=([^&\s]+)", url or "")
    return m.group(1) if m else ""


# --------------------------------------------------------------------------- #
# 极简 WebSocket 客户端（纯标准库，避免给 exe 增加依赖）
# --------------------------------------------------------------------------- #
class _WS:
    def __init__(self, url, timeout=12):
        assert url.startswith("ws://"), url
        rest = url[5:]
        hostport, _, path = rest.partition("/")
        path = "/" + path
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\n\r\n" % (path, hostport, key))
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            d = self.sock.recv(4096)
            if not d:
                raise IOError("握手中断")
            buf += d
        head, _, self.buf = buf.partition(b"\r\n\r\n")
        if b"101" not in head.split(b"\r\n")[0]:
            raise IOError("WebSocket 握手失败")
        self._id = 0

    # ---- 发送 ----
    def send(self, text):
        payload = text.encode()
        mask = os.urandom(4)
        n = len(payload)
        h = bytearray([0x81])
        if n < 126:
            h.append(0x80 | n)
        elif n < 65536:
            h.append(0x80 | 126)
            h += struct.pack(">H", n)
        else:
            h.append(0x80 | 127)
            h += struct.pack(">Q", n)
        h += mask
        self.sock.sendall(bytes(h) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    # ---- 接收 ----
    def _need(self, n):
        while len(self.buf) < n:
            d = self.sock.recv(65536)
            if not d:
                raise IOError("连接关闭")
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def poll(self, timeout=0.2):
        """读一条完整消息；超时返回 None（部分帧会留在缓冲区，可安全重入）"""
        self.sock.settimeout(timeout)
        try:
            while True:
                h = self._need(2)
                op = h[0] & 0x0F
                masked = h[1] & 0x80
                ln = h[1] & 0x7F
                if ln == 126:
                    ln = struct.unpack(">H", self._need(2))[0]
                elif ln == 127:
                    ln = struct.unpack(">Q", self._need(8))[0]
                mk = self._need(4) if masked else None
                data = self._need(ln) if ln else b""
                if mk:
                    data = bytes(b ^ mk[i % 4] for i, b in enumerate(data))
                if op == 0x8:
                    raise IOError("对端关闭")
                if op in (0x9, 0xA):       # ping / pong
                    continue
                if op in (0x1, 0x2, 0x0):
                    return data.decode("utf-8", "replace")
        except socket.timeout:
            return None

    def call(self, method, params=None, timeout=8):
        """发一条命令并等它的响应（期间的事件被丢弃；事件用 poll 收）"""
        self._id += 1
        mid = self._id
        self.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = self.poll(0.3)
            if msg is None:
                continue
            try:
                j = json.loads(msg)
            except ValueError:
                continue
            if j.get("id") == mid:
                return j
        return None

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# 抓取器
# --------------------------------------------------------------------------- #
class WebLoginCatcher:
    """启动浏览器 → 观察请求 → 一旦拿到列表接口就回调 on_captured(curl, info)

    回调都在 **后台线程** 里触发，GUI 侧请自行切回主线程。
    """

    def __init__(self, start_url=None, on_status=None, on_captured=None,
                 profile_dir=None, keyword=None, headless=False, keep_browser=False):
        self.start_url = start_url or DEFAULT_START
        self.on_status = on_status
        self.on_captured = on_captured
        self.profile_dir = profile_dir or default_profile_dir()
        self.keywords = (keyword or DEFAULT_KEYWORD,)
        self.headless = headless
        self.keep_browser = keep_browser

        self.browser = find_browser()
        self.port = None
        self.proc = None
        self._stop = threading.Event()
        self._thread = None
        self._ws_map = {}
        self._logged_in = False
        self._captured = False

    # ---------- 对外 ----------
    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()

    def running(self):
        return self._thread is not None and self._thread.is_alive()

    # ---------- 内部 ----------
    def _emit(self, text):
        if self.on_status:
            try:
                self.on_status(text)
            except Exception:
                pass

    def _http(self, path, timeout=4):
        with urllib.request.urlopen("http://127.0.0.1:%d%s" % (self.port, path),
                                    timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))

    def _run(self):
        try:
            self._inner()
        except Exception as e:
            self._emit("出错：%s" % (e,))
        finally:
            self._shutdown()

    def _inner(self):
        if not self.browser:
            self._emit("没找到 Edge / Chrome，无法使用「网页登录」。请改用粘贴 curl 的方式。")
            return

        self.port = _free_port()
        try:
            os.makedirs(self.profile_dir, exist_ok=True)
        except Exception:
            pass

        args = [self.browser,
                "--remote-debugging-port=%d" % self.port,
                "--remote-allow-origins=*",
                "--user-data-dir=%s" % self.profile_dir,
                "--no-first-run", "--no-default-browser-check",
                "--disable-background-networking", "--disable-sync",
                "--window-size=1180,880", "--window-position=140,60"]
        if self.headless:
            args.append("--headless=new")
        args.append(self.start_url)

        self._emit("正在启动浏览器…")
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL)

        ver = None
        for _ in range(70):
            if self._stop.is_set():
                return
            try:
                ver = self._http("/json/version")
                break
            except Exception:
                time.sleep(0.35)
        if not ver:
            self._emit("浏览器没起来（调试端口无响应）。如果上次的登录窗口还开着，请先关掉它再重试。")
            return

        self._emit("浏览器已打开 → 请在窗口里用手机号+验证码登录得物，然后点进「金币兑换」活动页")

        seen = {}
        last_tick = 0.0
        while not self._stop.is_set():
            # 1) 发现新页面 / 新标签
            try:
                targets = self._http("/json/list")
            except Exception:
                targets = []
            for t in targets:
                if t.get("type") != "page":
                    continue
                tid = t.get("id")
                if tid in self._ws_map:
                    continue
                try:
                    ws = _WS(t["webSocketDebuggerUrl"])
                    ws.call("Network.enable")
                    ws.call("Page.enable")
                    try:
                        ws.call("Network.setUserAgentOverride", {"userAgent": MOBILE_UA})
                    except Exception:
                        pass
                    self._ws_map[tid] = ws
                except Exception:
                    continue

            # 2) 收事件
            for tid, ws in list(self._ws_map.items()):
                while True:
                    raw = ws.poll(0.12)
                    if raw is None:
                        break
                    self._on_message(raw, seen)
                    if self._captured:
                        return

            # 3) 状态心跳
            now = time.time()
            if now - last_tick > 2.5:
                last_tick = now
                if self._logged_in:
                    self._emit("已登录 ✓　现在点进「金币兑换」活动页，我就能自动拿到接口了…")
                else:
                    self._emit("等待登录…（在浏览器窗口里登录得物）")
            time.sleep(0.15)

    def _on_message(self, raw, seen):
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        method = msg.get("method")
        p = msg.get("params") or {}

        if method == "Network.requestWillBeSent":
            rid = p.get("requestId")
            r = p.get("request") or {}
            d = seen.setdefault(rid, {"headers": {}})
            if r.get("url"):
                d["url"] = r["url"]
            if r.get("method"):
                d["method"] = r["method"]
            if r.get("postData"):
                d["postData"] = r["postData"]
            for k, v in (r.get("headers") or {}).items():
                d["headers"][k] = v
            self._inspect(d)

        elif method == "Network.requestWillBeSentExtraInfo":
            rid = p.get("requestId")
            d = seen.setdefault(rid, {"headers": {}})
            for k, v in (p.get("headers") or {}).items():
                d["headers"].setdefault(k, v)   # JS 显式设置的头优先
            self._inspect(d)

        elif method == "Network.loadingFinished":
            seen.pop(p.get("requestId"), None)
            if len(seen) > 400:                  # 兜底防膨胀
                seen.clear()

    def _inspect(self, d):
        if self._captured:
            return
        headers = d.get("headers") or {}
        token = _ci_get(headers, "x-auth-token")
        if token:
            if not self._logged_in:
                self._logged_in = True
                self._emit("已检测到登录态 ✓")
        url = d.get("url") or ""
        if token and any(k in url for k in self.keywords):
            self._captured = True
            curl = build_curl(url, headers, d.get("method") or "GET", d.get("postData"))
            info = {"url": url, "token": token, "activity": activity_of(url),
                    "method": d.get("method") or "GET",
                    "header_count": len([k for k in headers if not k.startswith(":")])}
            self._emit("已捕获「金币兑换」列表接口 ✓")
            if self.on_captured:
                try:
                    self.on_captured(curl, info)
                except Exception as e:
                    self._emit("回调异常：%s" % (e,))

    def _shutdown(self):
        for ws in list(self._ws_map.values()):
            ws.close()
        self._ws_map.clear()
        if self.proc and not self.keep_browser:
            try:
                subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=8)
            except Exception:
                try:
                    self.proc.terminate()
                except Exception:
                    pass
