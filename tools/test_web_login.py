# -*- coding: utf-8 -*-
"""端到端验证 WebLoginCatcher：本地页面发出带 x-auth-token 的 exchange_list 请求，
   看抓取器能否自动捕获，并用工程自带的 parse_curl 做回环校验。"""
import http.server
import socketserver
import threading
import sys
import os
import time

sys.path.insert(0, r"D:\work\workbuudy\dewu")
from web_login import WebLoginCatcher  # noqa: E402

PAGE = b"""<!doctype html><html><body>probe
<script>
fetch('/exchange_list?activity=20260919', {headers: {'x-auth-token': 'Bearer TESTTOKEN1234567890'}})
  .then(function(r){return r.text();}).catch(function(e){});
</script></body></html>"""


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, *a):
        pass


srv = socketserver.TCPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
print("本地测试页端口:", port)
print()

got = {}
statuses = []


def on_cap(curl, info):
    got["curl"] = curl
    got["info"] = info


c = WebLoginCatcher(
    start_url="http://127.0.0.1:%d/" % port,
    headless=True,
    profile_dir=os.path.join(os.environ.get("TEMP", "."), "dewu_wl_selftest"),
    on_status=lambda s: (statuses.append(s), print("[状态]", s)),
    on_captured=on_cap,
)
c.start()
t0 = time.time()
while time.time() - t0 < 70 and not got:
    time.sleep(0.4)
c.stop()
time.sleep(1.2)

print()
if not got:
    print("=== 未捕获到 ✗ ===")
    sys.exit(1)

print("=== 捕获成功 ✓ ===")
print("URL      :", got["info"]["url"])
print("method   :", got["info"]["method"])
print("activity :", got["info"]["activity"])
print("请求头数 :", got["info"]["header_count"])
print("curl 预览:", got["curl"][:260], "...")
print()

from dewu_sniper import parse_curl   # noqa: E402
url, headers, body, method = parse_curl(got["curl"])
print("=== 回环校验（用工程自带 parse_curl 解一遍）===")
print("URL     :", url)
print("method  :", method)
print("请求头数:", len(headers))
print("x-auth-token:", repr(headers.get("x-auth-token")))
print("Cookie  :", repr((headers.get("Cookie") or "")[:60]))

ok = ("exchange_list" in (url or "")
      and headers.get("x-auth-token") == "Bearer TESTTOKEN1234567890"
      and "activity=20260919" in (url or ""))
print()
print("结论:", "PASS ✓ 抓取器 → curl → 工程解析 全链路打通" if ok else "FAIL ✗")
sys.exit(0 if ok else 1)
