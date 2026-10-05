# -*- coding: utf-8 -*-
"""用一个「今日已答对」的账号试探 submit 的校验顺序与错误码。
无损失：该账号今日金币已到手（status=1, coinEarned=1），多打一次不会退币。"""
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
SIGN = "77af3e1a2c42f341d8f69d8661a39768"
SUB = BASE + "/hacking-game-platform/v1/gameplay/branch/answer/submit?sign=" + SIGN
TODAY = BASE + "/hacking-game-platform/v1/gameplay/branch/answer/today?bizActivity=2"
OUT = []


def say(s=""):
    print(s)
    OUT.append(str(s))


def main():
    accs = json.load(io.open(os.path.join(ROOT, "dist", "accounts.json"), encoding="utf-8"))
    a = accs[0]
    _, h, _, _ = parse_curl(a["list_curl"])
    for k in ("Host", "Content-Length", "Connection", "Accept-Encoding"):
        h.pop(k, None)
    h["Accept-Encoding"] = "identity"
    h["Content-Type"] = "application/json"
    h["Origin"] = "https://cdn-m.dewu.com"
    h["Referer"] = "https://cdn-m.dewu.com/"

    say("账号 %s（今日 status=1 已答对）" % a.get("name"))
    say("")

    def today():
        r = requests.get(TODAY, headers=h, timeout=10)
        d = r.json().get("data") or {}
        return d

    d0 = today()
    say("提交前: remain=%s/%s status=%s coinEarned=%s balance=%s"
        % (d0.get("remainAttempts"), d0.get("maxAttempts"), d0.get("status"),
           d0.get("coinEarned"), d0.get("balance")))
    say("")

    probes = [
        ("2字错误答案(长度不符)", "测试"),
        ("3字错误答案", "冰淇淋"),
        ("空答案", ""),
    ]
    for label, ans in probes:
        body = {"bizActivity": 2, "questionId": 853, "answer": ans}
        try:
            r = requests.post(SUB, headers=h,
                              data=json.dumps(body, ensure_ascii=False).encode("utf-8"), timeout=10)
            j = r.json()
            say("%-22s -> HTTP %s code=%s msg=%r data=%s"
                % (label, r.status_code, j.get("code"), j.get("msg"),
                   json.dumps(j.get("data"), ensure_ascii=False)))
        except Exception as e:
            say("%-22s -> 异常 %r" % (label, e))
        time.sleep(1.2)
        dd = today()
        say("    提交后: remain=%s/%s status=%s coinEarned=%s balance=%s"
            % (dd.get("remainAttempts"), dd.get("maxAttempts"), dd.get("status"),
               dd.get("coinEarned"), dd.get("balance")))
        say("")

    io.open(os.path.join(ROOT, "tools", "_probe_order.txt"), "w", encoding="utf-8").write("\n".join(OUT))
    say("已写入 tools/_probe_order.txt")


if __name__ == "__main__":
    main()
