# -*- coding: utf-8 -*-
"""细探 answer/today 与 branch/home：试各种参数组合，挖出今日题目的取法。"""
import io
import json
import os
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from dewu_sniper import parse_curl  # noqa: E402

BASE = "https://app.dewu.com"
OUT = []


def say(s=""):
    print(s)
    OUT.append(str(s))


def dump(tag, r):
    say("  [%s] HTTP %s" % (tag, r.status_code))
    try:
        j = r.json()
        s = json.dumps(j, ensure_ascii=False)
        say("      %s" % (s[:1500] + (" ..." if len(s) > 1500 else "")))
        return j
    except Exception:
        t = (r.text or "")[:300].replace("\n", " ")
        say("      %s" % t)
        return None


def main():
    acc = json.load(io.open(os.path.join(ROOT, "dist", "accounts.json"), encoding="utf-8"))[0]
    _, h, _, _ = parse_curl(acc["list_curl"])
    for k in ("Host", "Content-Length", "Connection", "Accept-Encoding"):
        h.pop(k, None)
    h["Accept-Encoding"] = "identity"
    hj = dict(h)
    hj["Content-Type"] = "application/json"

    # ---- home ----
    say("=" * 72)
    say("① branch/home —— 活动首页")
    for q in ("", "?activity=20260917", "?bizActivity=2", "?activity=20260917&bizActivity=2"):
        u = BASE + "/hacking-game-platform/v1/gameplay/branch/home" + q
        try:
            r = requests.get(u, headers=h, timeout=10)
            say("  URL %s" % (u.split("?")[1] if "?" in u else "(无参数)"))
            dump("home", r)
        except Exception as e:
            say("  异常 %r" % (e,))
        time.sleep(0.5)
    say("")

    # ---- answer/today ----
    say("=" * 72)
    say("② branch/answer/today —— 今日题目")
    cands = [
        ("GET", "?bizActivity=2", None),
        ("GET", "?bizActivity=2&activity=20260917", None),
        ("GET", "?activity=20260917", None),
        ("POST", "", {"bizActivity": 2}),
        ("POST", "?bizActivity=2", {"bizActivity": 2}),
        ("POST", "", {"bizActivity": 2, "activity": "20260917"}),
    ]
    u = BASE + "/hacking-game-platform/v1/gameplay/branch/answer/today"
    for m, q, body in cands:
        try:
            if m == "GET":
                r = requests.get(u + q, headers=h, timeout=10)
            else:
                r = requests.post(u + q, headers=hj, timeout=10,
                                  data=json.dumps(body, ensure_ascii=False).encode("utf-8"))
            say("  %-4s %-34s body=%s" % (m, q or "(无)", json.dumps(body, ensure_ascii=False) if body else "-"))
            dump("today", r)
        except Exception as e:
            say("  异常 %r" % (e,))
        time.sleep(0.5)

    io.open(os.path.join(ROOT, "tools", "_probe_today.txt"), "w", encoding="utf-8").write("\n".join(OUT))
    say("")
    say("已写入 tools/_probe_today.txt")


if __name__ == "__main__":
    main()
