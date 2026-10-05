# -*- coding: utf-8 -*-
"""得物「每日答题」模块。

接口（H5，与抢兑同一个 hacking-game-platform 平台，鉴权头复用账号里的抓包 curl）：

  取今日题目  GET  /hacking-game-platform/v1/gameplay/branch/answer/today?bizActivity=2
  提交答案    POST /hacking-game-platform/v1/gameplay/branch/answer/submit?sign=<固定>

参数哪些会变（实测结论）：
  · questionId  每天变（题号自增），**自动从 answer/today 取**，不需要人工填
  · answer      每天变 —— 用户输入
  · bizActivity 固定 2
  · sign        只与「路径」绑定，与账号/参数无关（三个账号的 exchange_list sign 完全相同），
                实测去掉或乱写也能进业务层；这里仍带上真实 sign，并保留无 sign 重试兜底
  · 请求头      每账号不同，但账号导入的 curl 里已经全带了（cookieToken / duToken /
                shumeiId / SK / duid / x-auth-token），直接复用

不需要任何新依赖：requests 本来就在包里。
"""
import json as _json
import re

import requests

BASE = "https://app.dewu.com"
TODAY_PATH = "/hacking-game-platform/v1/gameplay/branch/answer/today"
SUBMIT_PATH = "/hacking-game-platform/v1/gameplay/branch/answer/submit"

# 路径级固定签名（从抓包得到；同族的 exchange_list 已验证「只与路径有关」）
DEFAULT_SIGN = "77af3e1a2c42f341d8f69d8661a39768"
DEFAULT_BIZ = 2

CODE_OK = 200
CODE_NOT_LOGIN = 700
CODE_ALREADY = 111100004        # 今日已答对，明日再来
CODE_PARAM = 110000003          # 参数错误

STATUS_ANSWERED = 1             # answer/today 里 status==1 表示今日已答对

DROP_HEADERS = ("Host", "Content-Length", "Accept-Encoding", "Connection")


# ---------------- 请求头 ----------------

def headers_for(acc, sign=None):
    """从账号的抓包 curl 里取出 H5 请求头。"""
    from dewu_sniper import parse_curl          # 延迟导入，避免与 dewu_sniper 循环引用
    _, h, _, _ = parse_curl(acc.get("list_curl", ""))
    for k in list(h.keys()):
        if k in DROP_HEADERS:
            h.pop(k, None)
    h["Accept-Encoding"] = "identity"           # 免去 gzip 分支，便于直接读 JSON
    h.setdefault("Accept", "*/*")
    h.setdefault("Origin", "https://cdn-m.dewu.com")
    h.setdefault("Referer", "https://cdn-m.dewu.com/")
    if sign is None:
        # 从账号 curl 里能读到 bizActivity 就用它
        pass
    return h


def biz_from_acc(acc, default=DEFAULT_BIZ):
    """活动号：优先从抓包 curl 的 URL 里认，认不出用默认 2。"""
    from dewu_sniper import parse_curl
    url = parse_curl(acc.get("list_curl", ""))[0] or ""
    m = re.search(r"[?&](?:bizActivity|biz_activity)=(\d+)", url)
    if m:
        return int(m.group(1))
    return default


def _url(path, sign=None, params=None):
    q = []
    if params:
        q.append("&".join("%s=%s" % (k, v) for k, v in params.items()))
    if sign:
        q.append("sign=" + sign)
    return BASE + path + ("?" + "&".join(q) if q else "")


# ---------------- 取今日题目 ----------------

def today(acc, biz=None, timeout=10):
    """取今日题目。返回 (接口原始 json, 异常)。"""
    biz = biz or biz_from_acc(acc)
    url = _url(TODAY_PATH, None, {"bizActivity": biz})
    try:
        r = requests.get(url, headers=headers_for(acc), timeout=timeout)
        return _json.loads(r.content.decode("utf-8", "replace")), None
    except Exception as e:
        return None, e


def today_info(acc, biz=None, timeout=10):
    """取今日题目并整理成好用的 dict。返回 (info, 错误文本)。"""
    j, err = today(acc, biz, timeout)
    if err is not None:
        return None, "网络异常：%r" % (err,)
    if not isinstance(j, dict):
        return None, "响应异常"
    code = j.get("code")
    if code != CODE_OK:
        return None, friendly(j)
    d = j.get("data") or {}
    return {
        "question_id": d.get("questionId"),
        "image_url": d.get("imageUrl") or "",
        "word_count": d.get("hintWordCount"),
        "category": d.get("hintCategory") or "",
        "date": d.get("date") or "",
        "status": d.get("status"),
        "remain": d.get("remainAttempts"),
        "max_attempts": d.get("maxAttempts"),
        "balance": d.get("balance"),
        "coin_earned": d.get("coinEarned"),
        "answered": d.get("status") == STATUS_ANSWERED,
    }, None


# ---------------- 提交答案 ----------------

def submit(acc, question_id, answer, biz=None, sign=DEFAULT_SIGN, timeout=10):
    """提交答案。返回 (接口原始 json, 异常)。"""
    biz = biz or biz_from_acc(acc)
    body = {"bizActivity": biz, "questionId": question_id, "answer": answer}
    h = headers_for(acc)
    h["Content-Type"] = "application/json"
    data = _json.dumps(body, ensure_ascii=False).encode("utf-8")
    # 带上 sign；若服务端说签名有问题，再原样重试一次（不带 sign）
    last = None
    for sg in ((sign, None) if sign else (None,)):
        try:
            r = requests.post(_url(SUBMIT_PATH, sg), headers=h, data=data, timeout=timeout)
            j = _json.loads(r.content.decode("utf-8", "replace"))
        except Exception as e:
            return None, e
        last = j
        if _sign_problem(j) and sg:
            continue
        return j, None
    return last, None


def _sign_problem(j):
    if not isinstance(j, dict):
        return False
    msg = str(j.get("msg") or "")
    return any(k in msg for k in ("签名", "sign", "非法请求", "校验失败"))


def _cfg():
    """读 config.json 里的 answer 段（缺失/异常时给安全默认）。"""
    d = {"biz_activity": DEFAULT_BIZ, "sign": DEFAULT_SIGN, "skip_answered": True}
    try:
        from dewu_sniper import load_json, CONFIG_PATH, DEFAULT_CONFIG
        cfg = load_json(CONFIG_PATH, dict(DEFAULT_CONFIG))
        got = cfg.get("answer") or {}
        if got.get("biz_activity"):
            d["biz_activity"] = int(got["biz_activity"])
        if (got.get("sign") or "").strip():
            d["sign"] = got["sign"].strip()
        if got.get("skip_answered") is not None:
            d["skip_answered"] = bool(got["skip_answered"])
    except Exception:
        pass
    return d


def _sign_from_config():
    return _cfg()["sign"]


# ---------------- 结果翻译 ----------------

def friendly(j):
    """把接口返回翻译成人话。"""
    if not isinstance(j, dict):
        return "响应异常"
    code, msg = j.get("code"), str(j.get("msg") or "")
    if code == CODE_OK:
        return "成功"
    if code == CODE_ALREADY:
        return "今日已答对（跳过）"
    if code == CODE_PARAM:
        return "参数错误：答案不能为空"
    if code == CODE_NOT_LOGIN:
        return "登录态失效（请在手机上重新抓包导入该账号）"
    if code == 460:
        return "被风控拦截（460）：稍后再试，或用抓包导入刷新该账号指纹"
    return "code=%s %s" % (code, msg or "未知错误")


def classify(j):
    """→ (kind, 文案)  kind: ok / wrong / done / err"""
    if not isinstance(j, dict):
        return "err", "响应异常"
    code = j.get("code")
    d = j.get("data") or {}
    if code == CODE_OK:
        correct = d.get("correct")
        coin = d.get("coinEarned")
        remain = d.get("remainAttempts")
        if correct is True:
            return "ok", ("答对，+%s 金币" % coin) if coin is not None else "答对"
        if correct is False:
            tail = ("，还剩 %s 次机会" % remain) if remain is not None else ""
            return "wrong", "答案不对" + tail
        return "ok", "提交成功"
    if code == CODE_ALREADY:
        return "done", "今日已答对"
    return "err", friendly(j)


def hint_text(info):
    """拼一句提示，例如「3 个字 · 谐音」。"""
    if not info:
        return ""
    parts = []
    if info.get("word_count"):
        parts.append("%s 个字" % info["word_count"])
    if info.get("category"):
        parts.append(info["category"])
    return " · ".join(parts)


# ---------------- 图片 ----------------

def fetch_image(url, timeout=20):
    """下载题目图片。返回 bytes 或 None。"""
    if not url:
        return None
    try:
        r = requests.get(url, timeout=timeout)
        if r.status_code == 200 and r.content:
            return r.content
    except Exception:
        pass
    return None


# ---------------- 批量答题 ----------------

def answer_all(accounts, answer, on_result=None, on_log=None, biz=None,
               skip_answered=None, stop=None):
    """依次给所有账号用同一个答案答题。

    accounts    : Manager.accounts 的快照（list of dict）
    answer      : 今日答案
    on_result   : 每答完一个账号回调一次 (acc, result_dict)
    on_log      : 日志回调 (str)
    skip_answered: 今日已答对的账号是否直接跳过（None = 读 config.json，默认 True）
    stop        : 可选的可调用对象，返回 True 时中止（用户关了窗口）
    返回        : list of result dict
    """
    cfg = _cfg()
    sign = cfg["sign"]
    if skip_answered is None:
        skip_answered = cfg["skip_answered"]
    if biz is None:
        biz = cfg["biz_activity"]
    results = []
    for i, acc in enumerate(accounts, 1):
        if stop and stop():
            break
        nm = acc.get("name") or acc.get("id")
        res = {"acc_id": acc.get("id"), "name": nm, "kind": "err", "text": "", "qid": None}

        info, err = today_info(acc, biz)
        if err:
            res["text"] = err
            results.append(res)
            if on_log:
                on_log("[答题] %s → %s" % (nm, err))
            if on_result:
                on_result(acc, res)
            continue

        res["qid"] = info["question_id"]
        res["balance_before"] = info["balance"]

        if info["remain"] is not None and info["remain"] <= 0:
            res["kind"], res["text"] = "done", "今日次数已用完，跳过"
            res["balance"] = info["balance"]
            results.append(res)
            if on_log:
                on_log("[答题] %s → 今日次数已用完，跳过（余额 %s）" % (nm, info["balance"]))
            if on_result:
                on_result(acc, res)
            continue

        if skip_answered and info["answered"]:
            res["kind"], res["text"] = "done", "今日已答对，跳过"
            res["balance"] = info["balance"]
            results.append(res)
            if on_log:
                on_log("[答题] %s → 今日已答对，跳过（余额 %s）" % (nm, info["balance"]))
            if on_result:
                on_result(acc, res)
            continue

        if on_log:
            on_log("[答题] %s → 第 %d/%d 个，题目 #%s，提交答案「%s」…"
                   % (nm, i, len(accounts), info["question_id"], answer))

        j, err = submit(acc, info["question_id"], answer, biz, sign)
        if err is not None:
            res["kind"], res["text"] = "err", "网络异常：%r" % (err,)
        else:
            res["kind"], res["text"] = classify(j)
            d = j.get("data") or {}
            res["coin"] = d.get("coinEarned")
            res["raw"] = j

        # 成功后回读一次余额，好显示「60 → 61」
        if res["kind"] == "ok":
            info2, err2 = today_info(acc, biz)
            if not err2 and info2:
                res["balance"] = info2["balance"]
                res["coin"] = info2.get("coin_earned") or res.get("coin")
        res.setdefault("balance", info["balance"])

        results.append(res)
        if on_log:
            extra = ""
            if res.get("balance") is not None and res.get("balance_before") is not None \
                    and res["balance"] != res["balance_before"]:
                extra = "（余额 %s → %s）" % (res["balance_before"], res["balance"])
            elif res.get("balance") is not None:
                extra = "（余额 %s）" % res["balance"]
            on_log("[答题] %s → %s %s" % (nm, res["text"], extra))
        if on_result:
            on_result(acc, res)

    return results
