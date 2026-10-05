# -*- coding: utf-8 -*-
"""用抓包里的 iPhone UA 拉 cdn-m.dewu.com 首页，找 H5 的 JS bundle，
再从 bundle 里挖出 hacking-game-platform 相关接口路径 + sign 算法。"""
import io
import os
import re
import sys

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA_MOBILE = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 "
             "(KHTML, like Gecko) Mobile/15E148/duapp/6.0.3")
OUT = []


def say(s=""):
    print(s)
    OUT.append(str(s))


def main():
    h = {"User-Agent": UA_MOBILE, "Accept": "text/html,application/xhtml+xml,*/*",
         "Accept-Language": "zh-CN,zh-Hans;q=0.9"}
    for url in ("https://cdn-m.dewu.com/", "https://cdn-m.dewu.com/index.html"):
        say("=" * 70)
        say("GET %s" % url)
        try:
            r = requests.get(url, headers=h, timeout=15, allow_redirects=True)
            say("  HTTP %s  len=%d  ct=%s" % (r.status_code, len(r.content),
                                              r.headers.get("Content-Type")))
            say("  最终 URL: %s" % r.url)
            t = r.text
            say("  前 600 字: %s" % t[:600].replace("\n", " "))
            srcs = re.findall(r'<script[^>]+src="([^"]+)"', t)
            links = re.findall(r'<link[^>]+href="([^"]+)"', t)
            say("  script src (%d):" % len(srcs))
            for s in srcs[:30]:
                say("     %s" % s)
            say("  link href (%d):" % len(links))
            for s in links[:20]:
                say("     %s" % s)
            if srcs:
                # 下载第一个看起来像主 bundle 的
                for s in srcs:
                    if not s.startswith("http"):
                        s = "https://cdn-m.dewu.com/" + s.lstrip("/")
                    say("  --- 下载 %s" % s)
                    try:
                        rj = requests.get(s, headers=h, timeout=25)
                        say("      HTTP %s len=%d" % (rj.status_code, len(rj.content)))
                        js = rj.text
                        fn = os.path.join(ROOT, "tools", "_h5_%s.js" % re.sub(r"\W", "_", s)[-40:])
                        io.open(fn, "w", encoding="utf-8", errors="replace").write(js)
                        say("      存到 %s" % fn)
                        for kw in ("hacking-game-platform", "answer/submit", "bizActivity",
                                   "questionId", "gameplay"):
                            for m in re.finditer(re.escape(kw), js):
                                i = m.start()
                                say("      ★ %s @%d: %s" % (kw, i, js[max(0, i - 120):i + 200].replace("\n", " ")))
                                break
                        # 找所有 /hacking-* 路径
                        paths = sorted(set(re.findall(r'["\'`](/[a-z0-9\-]+/v\d+/[A-Za-z0-9/_\-]+)', js)))
                        say("      路径候选 (%d):" % len(paths))
                        for p in paths[:60]:
                            say("        %s" % p)
                    except Exception as e:
                        say("      下载失败 %r" % (e,))
        except Exception as e:
            say("  异常 %r" % (e,))

    io.open(os.path.join(ROOT, "tools", "_probe_h5.txt"), "w", encoding="utf-8").write("\n".join(OUT))
    say("")
    say("已写入 tools/_probe_h5.txt")


if __name__ == "__main__":
    main()
