# -*- coding: utf-8 -*-
"""探测「答题」接口：确认鉴权可用、参数要求、是否有获取今日题目的接口。

只做只读探测 + 一次提交试探；不写任何数据文件。
"""
import io
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import requests  # noqa: E402

from dewu_sniper import parse_curl  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = []


def say(s=""):
    print(s)
    OUT.append(str(s))


def headers_of(curl):
    _, h, _, _ = parse_curl(curl)
    for k in ("Host", "Content-Length", "Accept-Encoding", "Connection", "Cookie"):
        h.pop(k, None)
    # 保留 cookieToken / duToken / shumeiId / SK / duid 等 H5 头；Cookie 单独重组
    return h


def cookie_of(curl):
    _, h, _, _ = parse_curl(curl)
    return h.get("Cookie", "")


def show(tag, r):
    try:
        j = r.json()
    except Exception:
        j = None
    say("[%s] HTTP %s" % (tag, r.status_code))
    if j is not None:
        s = json.dumps(j, ensure_ascii=False)
        say("    %s" % (s[:900] + (" ..." if len(s) > 900 else "")))
    else:
        t = r.text or ""
        say("    %s" % (t[:400].replace("\n", " ")))
    return j


def main():
    accs = json.load(io.open(os.path.join(ROOT, "dist", "accounts.json"), encoding="utf-8"))
    say("账号数: %d" % len(accs))
    acc = accs[0]
    curl = acc["list_curl"]
    url, hdrs, _, _ = parse_curl(curl)
    h = headers_of(curl)
    ck = cookie_of(curl)
    if ck:
        h["Cookie"] = ck
    say("账号: %s" % acc.get("name"))
    say("列表 URL: %s" % url[:120])
    say("H5 关键头: cookieToken=%s duToken=%s shumeiId=%s SK=%s duid=%s"
        % (bool(h.get("cookieToken")), bool(h.get("duToken")),
           (h.get("shumeiId") or "")[:16], (h.get("SK") or "")[:12], (h.get("duid") or "")[:12]))
    say("")

    # ---- ① 列表接口：确认鉴权是否还活着 ----
    say("=" * 70)
    say("① GET exchange_list （确认账号鉴权）")
    try:
        r = requests.get(url, headers=h, timeout=10)
        j = show("list", r)
        if isinstance(j, dict) and j.get("code") == 200:
            d = j.get("data") or {}
            say("    data 顶层键: %s" % list(d.keys()))
            say("    balance=%s" % d.get("balance"))
            # 看看有没有答题相关的字段
            s = json.dumps(d, ensure_ascii=False)
            for kw in ("answer", "question", "quiz", "exam", "答题", "coin", "task", "branch"):
                if kw.lower() in s.lower():
                    idx = s.lower().find(kw.lower())
                    say("    ★ 含关键词 %r: ...%s..." % (kw, s[max(0, idx - 90):idx + 130]))
    except Exception as e:
        say("    异常: %r" % (e,))
    say("")

    # ---- ② 直接提交一次（今天已答过，期望拿到业务错误而不是风控/鉴权错误）----
    sign = "77af3e1a2c42f341d8f69d8661a39768"
    sub_url = "https://app.dewu.com/hacking-game-platform/v1/gameplay/branch/answer/submit?sign=" + sign
    body = {"bizActivity": 2, "questionId": 853, "answer": "探测"}
    say("=" * 70)
    say("② POST answer/submit  body=%s" % json.dumps(body, ensure_ascii=False))
    hh = dict(h)
    hh["Content-Type"] = "application/json"
    hh["Origin"] = "https://cdn-m.dewu.com"
    hh["Referer"] = "https://cdn-m.dewu.com/"
    try:
        r = requests.post(sub_url, headers=hh, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), timeout=10)
        show("submit", r)
    except Exception as e:
        say("    异常: %r" % (e,))
    say("")

    # ---- ③ 猜几个「取今日题目」的候选接口 ----
    say("=" * 70)
    say("③ 探测可能的「取题目」接口")
    cands = [
        "/hacking-game-platform/v1/gameplay/branch/answer/question?bizActivity=2",
        "/hacking-game-platform/v1/gameplay/branch/answer/current?bizActivity=2",
        "/hacking-game-platform/v1/gameplay/branch/answer/info?bizActivity=2",
        "/hacking-game-platform/v1/gameplay/branch/answer/detail?bizActivity=2",
        "/hacking-game-platform/v1/gameplay/branch/answer/get?bizActivity=2",
        "/hacking-game-platform/v1/gameplay/branch/detail?activity=20260917",
        "/hacking-game-platform/v1/gameplay/branch/info?activity=20260917",
        "/hacking-game-platform/v1/gameplay/branch/answer/list?bizActivity=2",
    ]
    for p in cands:
        u = "https://app.dewu.com" + p
        try:
            r = requests.get(u, headers=h, timeout=8)
            code = None
            try:
                code = r.json().get("code")
            except Exception:
                pass
            say("  %-64s -> HTTP %s code=%s" % (p, r.status_code, code))
            if r.status_code == 200 and code not in (404, None):
                show("    hit", r)
        except Exception as e:
            say("  %-64s -> 异常 %r" % (p, e))
        time.sleep(0.6)

    io.open(os.path.join(ROOT, "tools", "_probe_answer.txt"), "w", encoding="utf-8").write("\n".join(OUT))
    say("")
    say("已写入 tools/_probe_answer.txt")


if __name__ == "__main__":
    main()
