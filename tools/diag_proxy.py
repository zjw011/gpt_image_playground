# -*- coding: utf-8 -*-
"""代理体检：一个 IP 测不通时，逐层定位到底卡在哪。

界面上的「检测」只告诉你通/不通；这个告诉你**为什么**：

  ① TCP      能不能连上 IP:端口          （连不上 → 地址过期 / 被防火墙挡）
  ② 握手     SOCKS5 协商                 （0x00 接受无认证 / 0xFF 拒绝你 / 0x02 要密码）
  ③ CONNECT  用域名和 IP 两种寻址各试一次（分辨 socks5 与 socks5h 的差别）
  ④ 结论     一句人话，告诉你该去干什么

    python tools/diag_proxy.py 1.2.3.4:1080
    python tools/diag_proxy.py socks5://user:pass@1.2.3.4:1080
    python tools/diag_proxy.py 1.2.3.4:1080 --scheme socks5
    python tools/diag_proxy.py --myip        # 查本机公网 IP（白名单要填这个）

为什么不带参数也能跑：默认值就在下面，改一行直接复现。
"""
import argparse
import os
import socket
import struct
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

DEFAULT_PROXY = "180.119.116.48:40019"

# 走代理时用来判定的目标：一个国内域名 + 一个国外 IP。
# 两个都试是为了区分「代理整个坏了」和「只是某些目标被挡」。
TARGETS = (
    ("域名 www.baidu.com:80    [socks5h 寻址]", "domain", "www.baidu.com", 80),
    ("IP   1.1.1.1:80          [socks5 寻址]", "ip", "1.1.1.1", 80),
)

AUTH_NAMES = {0x00: "接受「无认证」", 0x01: "要 GSSAPI", 0x02: "要「用户名/密码」",
              0xFF: "★ 0xFF —— 所有认证方式都不接受（= 拒绝你）"}
REPLY = {0x00: "成功", 0x01: "一般性失败", 0x02: "规则不允许", 0x03: "网络不可达",
         0x04: "主机不可达", 0x05: "连接被拒", 0x06: "TTL 过期", 0x07: "命令不支持",
         0x08: "地址类型不支持"}


# ------------------------------------------------------------------ 解析参数
def split_url(raw, scheme="socks5h"):
    """拆 ``[scheme://][user:pass@]host:port`` 和四段式 ``host:port:user:pass``。"""
    s = (raw or "").strip()
    user = pw = ""
    if "://" in s:
        scheme, _, s = s.partition("://")
        scheme = scheme.lower()
    s = s.strip("/")
    if "@" in s:
        cred, _, s = s.rpartition("@")
        user, _, pw = cred.partition(":")
    elif s.count(":") == 3 and not s.startswith("["):
        host, port, user, pw = s.split(":", 3)
        s = "%s:%s" % (host, port)
    host, _, port = s.rpartition(":")
    try:
        port = int(port)
    except ValueError:
        raise SystemExit("端口不对：%r（要写成 host:port）" % raw)
    if not 0 < port < 65536:
        raise SystemExit("端口不在范围内：%d" % port)
    return host.strip("[]"), port, user, pw, scheme


# ------------------------------------------------------------------ 各层探测
def sock(host, port, timeout=8):
    s = socket.socket()
    s.settimeout(timeout)
    s.connect((host, port))
    return s


def step1_tcp(host, port):
    print("[1] TCP 连 %s:%d" % (host, port))
    t0 = time.time()
    try:
        s = sock(host, port)
        s.close()
        print("    ✓ 通了，%dms" % ((time.time() - t0) * 1000))
        return True
    except socket.timeout:
        print("    ✗ 超时 —— 包被丢弃（端口没开，或被防火墙 DROP）")
    except ConnectionRefusedError:
        print("    ✗ 被拒绝（RST）—— 端口没在监听，或被防火墙 REJECT")
    except Exception as e:
        print("    ✗ %s: %s" % (type(e).__name__, e))
    return False


def step2_handshake(host, port, user="", pw="", quiet=False):
    """做一次 SOCKS5 协商。返回 (socket 或 None, 服务端选的认证方式 或 None)。

    ``quiet`` —— 步骤 3 每个目标都要重新握手，不想把同一段过程打三遍。
    """
    if not quiet:
        print("[2] SOCKS5 握手" + ("（带用户名密码）" if user else "（无认证）"))

    def log(msg):
        if not quiet:
            print(msg)

    try:
        s = sock(host, port)
    except Exception as e:
        log("    ✗ 连不上：%s" % e)
        return None, None
    try:
        s.sendall(b"\x05\x01\x02" if user else b"\x05\x01\x00")
        rep = s.recv(2)
        if len(rep) < 2:
            log("    ✗ 只回了 %r（不像 SOCKS5）" % rep)
            s.close()
            return None, None
        if rep[0] != 0x05:
            log("    ✗ 版本 0x%02x ≠ 0x05 —— 这**不是 SOCKS5**"
                "（如果商家给的是 HTTP 代理，要写成 http://）" % rep[0])
            s.close()
            return None, None
        log("    服务端回 0x%02x：%s" % (rep[1], AUTH_NAMES.get(rep[1], "未知")))
        if rep[1] == 0x02:
            if not user:
                log("    → 它要账号密码，但你没给。换成「用户名:密码@host:port」再试。")
                s.close()
                return None, rep[1]
            u, p = user.encode(), pw.encode()
            s.sendall(b"\x01" + bytes([len(u)]) + u + bytes([len(p)]) + p)
            r = s.recv(2)
            if r[1:] != b"\x00":
                log("    ✗ 账号密码校验失败：%r" % r)
                s.close()
                return None, rep[1]
            log("    ✓ 账号密码通过")
            return s, rep[1]
        if rep[1] != 0x00:
            log("    ✗ 这个认证方式我们用不了（需要 PySocks 支持）")
            s.close()
            return None, rep[1]
        return s, rep[1]
    except Exception as e:
        log("    ✗ %s: %s" % (type(e).__name__, e))
        s.close()
        return None, None


def connect_once(host, port, user, pw, kind, thost, tport):
    """独立建连接 → 握手 → CONNECT。返回回应码（0x00 即成功），拿不到返 None。"""
    h, _ = step2_handshake(host, port, user, pw, quiet=True)
    if h is None:
        return None
    try:
        h.settimeout(8)
        if kind == "domain":
            payload = b"\x03" + bytes([len(thost)]) + thost.encode() + struct.pack("!H", tport)
        else:
            payload = b"\x01" + socket.inet_aton(thost) + struct.pack("!H", tport)
        h.sendall(b"\x05\x01\x00" + payload)
        t0 = time.time()
        rep = h.recv(10)
        ms = int((time.time() - t0) * 1000)
        if not rep:
            print("    - 服务端直接关连接（recv 空）—— 它不想让你连这个目标")
            return None
        if rep[0] != 0x05:
            print("    - ✗ 回的不是 SOCKS5：%r" % rep)
            return None
        print("    - 0x%02x %s（%dms）" % (rep[1], REPLY.get(rep[1], "?"), ms))
        return rep[1]
    except socket.timeout:
        print("    - ★ 静默超时：收到了 CONNECT 但不应答（多半在拦你）")
        return None
    except Exception as e:
        print("    - ✗ %s: %s" % (type(e).__name__, e))
        return None
    finally:
        h.close()


# ------------------------------------------------------------------ 查本机 IP
def my_ip():
    print("本机公网 IP（白名单要填的就是这个）")
    print("-" * 72)
    try:
        import requests
    except ImportError:
        print("  没装 requests，跳过")
        return
    # ★ 国内优先：这台机器的国外流量可能走了别的出口（VPN/中转），
    #   拿国外站查出来的 IP 不一定是「代理看到你」的那个 IP。
    for u in ("http://ip.3322.net/", "http://myip.ipip.net/", "http://ifconfig.me/ip"):
        try:
            t = requests.get(u, timeout=10).text.strip().replace("\n", " ")[:70]
            print("  %-24s %s" % (u, t))
        except Exception as e:
            print("  %-24s ✗ %s" % (u, str(e)[:60]))
    print("-" * 72)
    print("以**国内站**报出的那个为准 —— 代理看到的就是它。")


# ------------------------------------------------------------------ 主流程
def main():
    ap = argparse.ArgumentParser(description="代理体检：定位一个 IP 为什么测不通")
    ap.add_argument("proxy", nargs="?", default=DEFAULT_PROXY,
                    help="host:port / host:port:user:pass / 完整 URL（默认 %s）" % DEFAULT_PROXY)
    ap.add_argument("--scheme", default="socks5h", help="没写协议时按这个算（默认 socks5h）")
    ap.add_argument("--myip", action="store_true", help="只查本机公网 IP")
    a = ap.parse_args()

    if a.myip:
        return my_ip() or 0

    host, port, user, pw, scheme = split_url(a.proxy, a.scheme)
    if scheme not in ("socks5", "socks5h", "socks4"):
        print("! 这个体检工具只讲 SOCKS（你给的是 %s）。HTTP 代理用 requests 直接试更合适。"
              % scheme)
    print("=" * 72)
    print("代理体检：%s:%d   协议=%s   %s"
          % (host, port, scheme, ("有账号密码" if user else "★ 无账号密码")))
    print("=" * 72)

    if not step1_tcp(host, port):
        print()
        print("-" * 72)
        print("【结论】连不上代理服务器本身（不是本程序的毛病）")
        print("  · 地址 / 端口写错了？")
        print("  · 是动态/短效 IP？多半**已经过期** —— 去服务商后台重新提取一个。")
        print("  · 白名单模式的代理，掉线时也可能这样。")
        return 2

    hand, method = step2_handshake(host, port, user, pw)

    print("[3] CONNECT 试目标（用来区分「代理坏了」和「某些目标被挡」）")
    results = {}
    for label, kind, thost, tport in TARGETS:
        print("  试 %s" % label)
        results[label] = connect_once(host, port, user, pw, kind, thost, tport)

    print()
    print("=" * 72)
    print("【结论】")
    print("=" * 72)
    ok = [k for k, v in results.items() if v == 0x00]
    if ok:
        print("代理本身是**好的**：至少这些目标通了 →")
        for k in ok:
            print("    ✓ %s" % k)
        print("→ 所以界面上「测不通」多半是**探测地址被这个代理的出口策略挡了**，")
        print("  不是代理坏。抢购只打 app.dewu.com，直接导入用就行。")
    elif method == 0xFF:
        print("代理在**握手阶段就拒绝了你**（0xFF）。最可能的原因：")
        print("  · 这是**免密（无账号密码）的 s5** —— 那它只能靠「来源 IP 白名单」认人。")
        print("    去服务商后台，把本机公网 IP 填进白名单：")
        print("        python tools/diag_proxy.py --myip")
        print("  · 或者这个 IP 已被回收 / 掉线（动态 IP 常见）—— 重新提取一个。")
    elif method is None:
        print("握手就没过，但 TCP 是通的 —— 端口后面可能不是 SOCKS5，")
        print("或协议不对（商家给的是 http 代理？试试改成 http://）。")
    else:
        print("握手能过（0x%02x），但每个目标都不通 —— 代理处于**半死状态**"
              "（限流 / 下游不通 / 出口策略只放行特定站）。" % method)
        print("→ 过几分钟再测；仍不行就换一个 IP。")
    if hand:
        hand.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
