# -*- coding: utf-8 -*-
"""curl 解析（从桌面版 dewu_sniper.py 原样搬过来）。

为什么不直接 import dewu_sniper：
    那个模块一被 import 就会执行 `M = Manager()`，而 Manager.__init__ 会
    读程序目录的 config.json、恢复未完成任务线程、甚至在 watch.enabled=True 时
    自动拉起库存监听线程 —— Web 版不能有这种副作用，所以只把需要的纯函数搬过来。
"""
import re
import shlex


def parse_curl(text):
    """解析一段 curl，返回 (url, headers, body, method)。"""
    text = (text or "").strip().replace("^", " ")
    text = re.sub(r"\\\r?\n", " ", text)
    try:
        tokens = shlex.split(text, posix=True)
    except ValueError:
        tokens = shlex.split(text, posix=False)
    url, headers, body, method = None, {}, None, None
    arg_flags = {"-A", "--user-agent", "-b", "--cookie", "-e", "--referer", "-H", "--header",
                 "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
                 "-X", "--request", "-o", "--output", "-u", "--user", "-x", "--proxy",
                 "-m", "--max-time", "--connect-timeout", "-w", "--write-out"}
    bool_flags = {"--compressed", "-s", "-sS", "-S", "-k", "--insecure", "-L", "--location",
                  "-v", "--verbose", "-i", "--include", "-#", "--silent"}
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t == "curl":
            i += 1
            continue
        if t in arg_flags:
            flag, val = t, (tokens[i + 1] if i + 1 < len(tokens) else "")
            if flag in ("-H", "--header") and ":" in val:
                k, v = val.split(":", 1)
                headers[k.strip()] = v.strip()
            elif flag in ("-d", "--data", "--data-raw", "--data-binary", "--data-urlencode"):
                body = val
            elif flag in ("-X", "--request"):
                method = val.upper()
            i += 2
            continue
        if t in bool_flags or t.startswith("-"):
            i += 1
            continue
        if url is None:
            url = t
        i += 1
    if method is None:
        method = "POST" if body is not None else "GET"
    return url, headers, body, method


def xat_of_curl(curl_text):
    """取 curl 里的 x-auth-token（大小写不敏感）。"""
    try:
        _, headers, _, _ = parse_curl(curl_text or "")
    except Exception:
        return None
    for k, v in headers.items():
        if k.lower() == "x-auth-token" and v:
            return v
    return None
