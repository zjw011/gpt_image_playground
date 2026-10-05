# -*- coding: utf-8 -*-
"""本机迷你正向代理 —— 只用来**证明请求真的穿过了代理**。

不是 mock：它是个能跑的 HTTP 正向代理，会在内存里记下自己转发过什么，
于是「开着代理时代理侧看到了 CONNECT app.dewu.com」「关掉代理后代理侧一条都没收到」
这种 A/B 对照就能直接断言，而不是靠猜。

* ``CONNECT host:port`` → 建隧道双向 pipe（HTTPS 走这条）
* ``GET http://...``    → 绝对 URI 转发（requests 的 http:// 请求走这条）

Web 版真机测试（tools/test_proxy_live.py）和桌面版真机测试
（tools/test_proxy_desktop.py）都用它。
"""
import asyncio
import socket
import threading
import time
from urllib.parse import urlparse


class MiniProxy:
    def __init__(self, host="127.0.0.1"):
        self.connects = []      # 隧道目标 ["app.dewu.com:443", ...]
        self.gets = []          # 明文转发目标 ["http://api.ipify.org/", ...]
        self.host = host
        self.port = None
        self._srv = None
        self._loop = None

    # ---------------------------------------------------------------- 处理
    async def _pipe(self, r, w):
        try:
            while True:
                data = await asyncio.wait_for(r.read(65536), 60)
                if not data:
                    break
                w.write(data)
                await w.drain()
        except Exception:
            pass
        finally:
            try:
                w.close()
            except Exception:
                pass

    async def _handle(self, reader, writer):
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 15)
        except Exception:
            writer.close()
            return
        lines = head.decode("latin-1").split("\r\n")
        parts = lines[0].split()
        if len(parts) < 2:
            writer.close()
            return
        method, target = parts[0].upper(), parts[1]

        if method == "CONNECT":
            self.connects.append(target)
            host, _, port = target.rpartition(":")
            try:
                rr, ww = await asyncio.open_connection(host, int(port or 443))
            except Exception:
                writer.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                await writer.drain()
                writer.close()
                return
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
            await asyncio.gather(self._pipe(reader, ww), self._pipe(rr, writer))
            return

        # 明文 GET/POST：把绝对 URI 改成路径，转发给真实服务端
        if not target.lower().startswith("http"):
            writer.write(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        self.gets.append(target)
        u = urlparse(target)
        path = u.path or "/"
        if u.query:
            path += "?" + u.query
        try:
            rr, ww = await asyncio.open_connection(u.hostname, u.port or 80)
        except Exception:
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        out = ["%s %s %s" % (method, path, lines[0].split()[-1])]
        for ln in lines[1:]:
            if not ln:
                continue
            k = ln.split(":", 1)[0].lower()
            if k in ("proxy-connection", "proxy-authorization"):
                continue
            out.append(ln)
        ww.write(("\r\n".join(out) + "\r\n\r\n").encode("latin-1"))
        await ww.drain()
        # 请求体（POST 的表单就在这儿；丢了兑换请求就变味了）
        body = head.split(b"\r\n\r\n", 1)[1]
        if body:
            ww.write(body)
            await ww.drain()
        # 有些客户端是「发完头再发体」，补一次读
        try:
            more = await asyncio.wait_for(reader.read(65536), 0.2)
            if more:
                ww.write(more)
                await ww.drain()
        except Exception:
            pass
        await self._pipe(rr, writer)

    # ---------------------------------------------------------------- 生命周期
    async def _serve(self):
        self._srv = await asyncio.start_server(self._handle, self.host, 0)
        self.port = self._srv.sockets[0].getsockname()[1]
        async with self._srv:
            await self._srv.serve_forever()

    def start(self):
        self._loop = asyncio.new_event_loop()

        def _run():
            try:
                self._loop.run_until_complete(self._serve())
            except BaseException:
                # 收尾关 server 时 asyncio 会抛 CancelledError（它是 BaseException，
                # 不是 Exception），属于正常收摊，别让它冒到线程外面刷屏
                pass

        threading.Thread(target=_run, daemon=True, name="mini-proxy").start()
        for _ in range(80):
            if self.port:
                return self.port
            time.sleep(0.05)
        raise RuntimeError("迷你代理没起来")

    def stop(self):
        try:
            if self._srv:
                self._srv.close()
        except Exception:
            pass

    def clear(self):
        self.connects.clear()
        self.gets.clear()

    @property
    def url(self):
        return "http://%s:%d" % (self.host, self.port)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class MiniServer:
    """本机小目标站：固定回一段 JSON。用来当「被抢兑的接口」。

    有了它，桌面版真机测试不必真的去打 app.dewu.com —— 只要断言
    「请求进了迷你代理、并且回程拿到了这个 JSON」就够了。
    """

    def __init__(self, payload=None, status=200):
        import json as _json
        self.body = _json.dumps(payload if payload is not None else {"code": 200}).encode()
        self.status = status
        self.hits = []          # [(method, path), ...]
        self.port = None
        self._srv = None
        self._loop = None

    async def _handle(self, reader, writer):
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
        except Exception:
            writer.close()
            return
        first = head.decode("latin-1").split("\r\n")[0].split()
        self.hits.append((first[0] if first else "?", first[1] if len(first) > 1 else "?"))
        reason = "OK" if self.status == 200 else "ERR"
        writer.write(("HTTP/1.1 %d %s\r\nContent-Type: application/json\r\n"
                      "Content-Length: %d\r\nConnection: close\r\n\r\n"
                      % (self.status, reason, len(self.body))).encode())
        writer.write(self.body)
        await writer.drain()
        try:
            writer.close()
        except Exception:
            pass

    async def _serve(self):
        self._srv = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self._srv.sockets[0].getsockname()[1]
        async with self._srv:
            await self._srv.serve_forever()

    def start(self):
        self._loop = asyncio.new_event_loop()

        def _run():
            try:
                self._loop.run_until_complete(self._serve())
            except BaseException:
                pass

        threading.Thread(target=_run, daemon=True, name="mini-server").start()
        for _ in range(80):
            if self.port:
                return self.port
            time.sleep(0.05)
        raise RuntimeError("迷你服务端没起来")

    def stop(self):
        try:
            if self._srv:
                self._srv.close()
        except Exception:
            pass

    @property
    def url(self):
        return "http://127.0.0.1:%d/exchange" % self.port
