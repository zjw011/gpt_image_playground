# -*- coding: utf-8 -*-
"""扫描 hacking-game-platform 的候选路径，用「404 = 无此路由」当判别信号找今日题目接口。"""
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


def main():
    acc = json.load(io.open(os.path.join(ROOT, "dist", "accounts.json"), encoding="utf-8"))[0]
    _, h, _, _ = parse_curl(acc["list_curl"])
    for k in ("Host", "Content-Length", "Connection"):
        h.pop(k, None)
    h["Accept-Encoding"] = "identity"

    prefixes = [
        "/hacking-game-platform/v1/gameplay/branch/answer/",
        "/hacking-game-platform/v1/gameplay/branch/",
        "/hacking-game-platform/v1/gameplay/answer/",
        "/hacking-game-platform/v1/gameplay/question/",
        "/hacking-game-platform/v1/gameplay/quiz/",
        "/hacking-game-platform/v1/gameplay/task/",
        "/hacking-game-platform/v1/gameplay/",
    ]
    names = ["submit", "get", "info", "detail", "list", "question", "current", "today",
             "today_question", "quiz", "config", "init", "start", "begin", "one", "daily",
             "epoch", "progress", "status", "result", "record", "history", "rank", "index",
             "home", "answer", "exchange", "exchange_list", "check", "verify", "do",
             "getQuestion", "get_question", "query", "pre", "prepare", "next", "latest",
             "reward", "receive", "money", "coin", "coin_earn", "earn", "puzzle", "bank"]

    # 先验证方法学：已知存在的路径用 GET 打，应该不是 404
    say("--- 方法学校验：已知路径 GET ---")
    for p in ("/hacking-game-platform/v1/gameplay/branch/answer/submit",
              "/hacking-game-platform/v1/gameplay/branch/exchange_list"):
        try:
            r = requests.get(BASE + p, headers=h, timeout=8)
            say("  %-56s GET -> %s" % (p, r.status_code))
        except Exception as e:
            say("  %-56s GET -> %r" % (p, e))
    say("")

    hits = []
    tested = 0
    for pre in prefixes:
        for n in names:
            p = pre + n
            # 已确认存在的跳过（避免重复）
            if p.endswith(("/answer/submit", "/exchange_list")):
                continue
            tested += 1
            try:
                r = requests.get(BASE + p, headers=h, timeout=8)
                if r.status_code != 404:
                    try:
                        j = r.json()
                        code = j.get("code")
                        msg = j.get("msg")
                    except Exception:
                        code, msg = None, (r.text or "")[:80]
                    line = "  ★ %-62s -> HTTP %s code=%s msg=%s" % (p, r.status_code, code, msg)
                    say(line)
                    hits.append((p, r.status_code, code, msg))
                time.sleep(0.35)
            except Exception as e:
                say("  ! %-62s -> %r" % (p, e))
    say("")
    say("共测 %d 条, 非 404 命中 %d 条" % (tested, len(hits)))
    for p, sc, code, msg in hits:
        say("   %-62s HTTP=%s code=%s msg=%s" % (p, sc, code, msg))

    io.open(os.path.join(ROOT, "tools", "_scan_paths.txt"), "w", encoding="utf-8").write("\n".join(OUT))


if __name__ == "__main__":
    main()
