# -*- coding: utf-8 -*-
"""多账号探测：sign 是否与账号相关、各账号今日答题状态、submit 的 sign 校验强度。"""
import io
import json
import os
import re
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from dewu_sniper import parse_curl  # noqa: E402

BASE = "https://app.dewu.com"
TODAY_URL = BASE + "/hacking-game-platform/v1/gameplay/branch/answer/today?bizActivity=2"
OUT = []
SIGN = "77af3e1a2c42f341d8f69d8661a39768"


def say(s=""):
    print(s)
    OUT.append(str(s))


def hdrs(curl):
    _, h, _, _ = parse_curl(curl)
    for k in ("Host", "Content-Length", "Connection", "Accept-Encoding"):
        h.pop(k, None)
    h["Accept-Encoding"] = "identity"
    return h


def jd(r):
    try:
        return r.json()
    except Exception:
        return {"_raw": (r.text or "")[:200]}


def main():
    accs = json.load(io.open(os.path.join(ROOT, "dist", "accounts.json"), encoding="utf-8"))
    say("账号 %d 个" % len(accs))
    say("")

    # ---- ① 各账号的 exchange_list sign 是否相同 ----
    say("=" * 72)
    say("① 各账号 exchange_list 的 sign（判断 sign 是否只与路径有关）")
    for a in accs:
        u = parse_curl(a["list_curl"])[0]
        m = re.search(r"[?&]sign=([0-9a-f]+)", u or "")
        say("   %-10s activity=%s  sign=%s" % (a.get("name"),
           (re.search(r"[?&]activity=([^&\s]+)", u or "") or [None, "?"])[1],
           m.group(1) if m else "(无)"))
    say("")

    # ---- ② 各账号今日答题状态 ----
    say("=" * 72)
    say("② 各账号 answer/today")
    states = []
    for a in accs:
        h = hdrs(a["list_curl"])
        try:
            r = requests.get(TODAY_URL, headers=h, timeout=10)
            j = jd(r)
            d = j.get("data") or {}
            states.append((a, d))
            say("   %-10s code=%s qId=%s status=%s remain=%s/%s balance=%s coinEarned=%s date=%s"
                % (a.get("name"), j.get("code"), d.get("questionId"), d.get("status"),
                   d.get("remainAttempts"), d.get("maxAttempts"), d.get("balance"),
                   d.get("coinEarned"), d.get("date")))
            if not d:
                say("        原始: %s" % json.dumps(j, ensure_ascii=False)[:200])
        except Exception as e:
            say("   %-10s 异常 %r" % (a.get("name"), e))
        time.sleep(0.6)
    say("")

    # ---- ③ submit 的 sign 校验强度 ----
    say("=" * 72)
    say("③ submit 接口对 sign 的校验强度")
    a0 = accs[0]
    h = hdrs(a0["list_curl"])
    h["Content-Type"] = "application/json"
    body = json.dumps({"bizActivity": 2, "questionId": 853, "answer": "导盲犬"}).encode("utf-8")
    tests = [
        ("正确 sign", "?sign=" + SIGN),
        ("去掉 sign", ""),
        ("乱写 sign", "?sign=00000000000000000000000000000000"),
    ]
    for label, q in tests:
        try:
            r = requests.post(BASE + "/hacking-game-platform/v1/gameplay/branch/answer/submit" + q,
                              headers=h, data=body, timeout=10)
            j = jd(r)
            say("   %-10s -> HTTP %s  code=%s  msg=%s" % (label, r.status_code, j.get("code"), j.get("msg")))
        except Exception as e:
            say("   %-10s -> 异常 %r" % (label, e))
        time.sleep(0.8)

    io.open(os.path.join(ROOT, "tools", "_probe_multi.txt"), "w", encoding="utf-8").write("\n".join(OUT))
    say("")
    say("已写入 tools/_probe_multi.txt")


if __name__ == "__main__":
    main()
