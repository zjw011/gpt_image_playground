# -*- coding: utf-8 -*-
"""得物接口层（Web 版）——复用桌面版已经逆向验证过的成果。

复用来源
--------
* ``dewu_login``：手机号 AES-128-ECB 加密、``md5(密码+"du")``、登录端点、
  以及数美风控设备指纹头。这些是纯函数/常量，import 无副作用。
* 商品列表 / 兑换 / 答题 的路径、sign、错误码语义，来自 ``dewu_sniper`` / ``dewu_answer``
  （但**不 import 它们**，因为 dewu_sniper 一 import 就会实例化 Manager 单例并可能
  自动拉起桌面版的监听线程；需要的 parse_curl 已在 curlparse.py 里单独搬了一份）。

与桌面版的关键差别
------------------
桌面版拉列表用的是「用户自己抓包的 H5 请求头」。Web 版没有抓包，所以这里**自己拼 H5 头**。
已实测（``tools/diag/probe_h5_headers.py``）：``exchange_list`` 实际只认 ``x-auth-token``，
四组请求头（抓包原样 / App 头 / 合成 H5 头 / 仅 token）**全部返回 200** ——
所以「手机号密码登录 → 直接拉列表」这条路是通的，用户不需要先抓包。
"""
import json
import random
import re
import time

import requests

import dewu_login as LOGIN

from .curlparse import parse_curl, xat_of_curl   # noqa: F401  (对外也导出)

BASE = "https://app.dewu.com"
LIST_PATH = "/hacking-game-platform/v1/gameplay/branch/exchange_list"
EXCHANGE_URL = BASE + "/hacking-game-platform/v1/gameplay/branch/exchange"
ANSWER_TODAY = BASE + "/hacking-game-platform/v1/gameplay/branch/answer/today"
ANSWER_SUBMIT = BASE + "/hacking-game-platform/v1/gameplay/branch/answer/submit"

CODE_SUCCESS = 200
CODE_INSUFFICIENT = 906020010
CODE_NOT_LOGIN = 700
CODE_PARAM_ERR = 900                 # 列表/兑换接口的参数错误
CODE_ALREADY_ANSWERED = 111100004
# ★ 答题接口的参数错误码和上面那个 900 不是一回事（见 dewu_answer.py 的 CODE_PARAM）
CODE_ANSWER_PARAM_ERR = 110000003

# 路径级固定 sign（与账号无关，实测同族接口的 sign 只跟路径绑定）
DEFAULT_LIST_SIGN = "a442082446d3167a557bb01e06012ee4"
DEFAULT_ANSWER_SIGN = "77af3e1a2c42f341d8f69d8661a39768"
DEFAULT_BIZ_ACTIVITY = 2

# 「商品/活动已经没了」的永久性错误 —— 重试不会变好，早停省下抢兑机会
FATAL_MSG_HINTS = (
    "商品不存在", "商品已下架", "已下架", "商品已失效", "商品已过期",
    "活动不存在", "活动已结束", "活动结束", "活动已失效", "活动已过期",
    "链接已失效", "活动未开始", "不在活动",
)
FATAL_STRIKES = 2

# 合成 H5 头的固定部分（值本身不敏感，服务端对 exchange_list 不校验设备）
_H5_STATIC = {
    "platform": "h5", "appid": "h5", "appVersion": "5.99.6",
    "channel": "App Store", "deviceTrait": "iPhone", "device_model": "iPhone 17",
    "networktype": "WIFI", "countryCode": "CN", "isRoot": "0", "emu": "0",
    "isProxy": "0", "imei": "", "Accept": "*/*",
    "Origin": "https://cdn-m.dewu.com", "Referer": "https://cdn-m.dewu.com/",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9",
}


# ------------------------------------------------------------------ 小工具
def _bearer(token):
    """统一成 'Bearer xxx' 形式。"""
    t = (token or "").strip()
    if not t:
        return ""
    return t if t.lower().startswith("bearer ") else "Bearer " + t


def _bare(token):
    return re.sub(r"^Bearer\s+", "", (token or "").strip(), flags=re.I)


def h5_headers(token, device=None):
    """拼一套可用的 H5 请求头。device 可用于覆盖（换设备指纹时）。"""
    tk = _bearer(token)
    bare = _bare(token)
    h = dict(_H5_STATIC)
    h["User-Agent"] = h["ua"] = LOGIN.DEVICE_HEADERS["webua"]
    h["shumeiId"] = LOGIN.DEVICE_HEADERS["shumeiid"]
    h["SK"] = LOGIN.DEVICE_HEADERS["SK"]
    h["duid"] = LOGIN.DEVICE_BODY["duid"]
    h["cookieToken"] = bare
    h["duToken"] = bare
    h["x-auth-token"] = tk
    h["Cookie"] = "duToken=" + bare
    if isinstance(device, dict) and device:
        for k, v in device.items():
            if v:
                h[k] = v
    return h


def list_url(activity, sign=None):
    act = str(activity or "").strip()
    sg = (sign or DEFAULT_LIST_SIGN).strip()
    return "%s%s?activity=%s&sign=%s" % (BASE, LIST_PATH, act, sg)


# ------------------------------------------------------------------ 登录
def login(phone, password, override=None, timeout=25):
    """手机号 + 密码登录得物（复用 dewu_login 的两个客户端加密 + 设备指纹）。

    返回 {ok, token, user_id, msg}。
    """
    return LOGIN.login(phone, password, override=override, timeout=timeout)


def token_from_curl(curl_text):
    """兜底登录方式：从用户粘贴的抓包 curl 里取 token。"""
    return xat_of_curl(curl_text)


def activity_from_curl(curl_text):
    try:
        url, _, _, _ = parse_curl(curl_text or "")
    except Exception:
        return ""
    m = re.search(r"[?&]activity=([^&\s]+)", url or "")
    return m.group(1) if m else ""


# ------------------------------------------------------------------ 商品列表
def no_stock(p):
    """是否无货。

    接口的 outOfStock 并不总是准（实测有 stock=0 但 outOfStock=false 的），
    所以「标志为真」或「库存 <= 0」都算缺货；stock 缺失(None)不算。
    """
    if p.get("outOfStock"):
        return True
    try:
        return int(p.get("stock")) <= 0
    except (TypeError, ValueError):
        return False


def parse_prizes(data):
    """把 exchange_list 的 data 解析成扁平商品列表（**保留图片/价格**）。

    相比桌面版只多了 picture / price / subName / typeDesc 几个字段 ——
    这些接口本来就返回，Web 版商品墙要用。
    """
    out = []
    for item in (data or {}).get("prizes") or []:
        p = item.get("prize") or {}
        pic = p.get("productPicture") or p.get("commodityPicture") or ""
        price = p.get("platformPrice")
        try:
            price_yuan = round(int(price) / 100.0, 2)
        except (TypeError, ValueError):
            price_yuan = None
        label = p.get("label") or {}
        out.append({
            "level": item.get("level", p.get("level", "")),
            "cId": p.get("cId"), "pId": p.get("pId"), "skuId": p.get("skuId"),
            "cName": p.get("cName") or p.get("displayName") or "",
            "subName": p.get("productName") or "",
            "cost": p.get("scoreCostOrigin"),
            "stock": p.get("stock"),
            "dailyStock": p.get("dailyStock"),
            "picture": pic,
            "price": price,                 # 单位：分
            "priceYuan": price_yuan,        # 单位：元
            "typeDesc": p.get("cTypeDesc") or "",
            "label": (label.get("value") if isinstance(label, dict) else "") or "",
            "outOfStock": no_stock(p),
            "outOfStockFlag": bool(p.get("outOfStock", False)),
            "isLock": bool(item.get("isLock", False)),
        })
    out.sort(key=lambda x: (str(x["level"]), x["cost"] or 0))
    return out


def parse_list(j):
    """把一个 exchange_list 响应整理成 {balance, prizes, refreshHour}。"""
    data = (j or {}).get("data") or {}
    return {"balance": data.get("balance", "-"),
            "prizes": parse_prizes(data),
            "refreshHour": data.get("refreshHour")}


def is_fatal(msg):
    s = str(msg or "")
    return any(k in s for k in FATAL_MSG_HINTS)


# ------------------------------------------------------------------ 自动降级
def pick_fallback(prizes, balance, orig, fb):
    """在「有货 + 买得起」里挑一个替代品。

    规则（照搬桌面版，固定不给配）：
      · 价格降序 —— 在买得起里挑最贵的，别把 110 币的号浪费在 5 币商品上
      · 同价取列表顺序第一个
      · 排除原商品自己
      · min_ratio 门槛：低于 原价*min_ratio 的一律不要
    返回 (prize|None, 说明文字)。
    """
    prizes = prizes or []
    if not prizes:
        return None, "商品列表是空的"
    try:
        bal = int(balance)
    except (TypeError, ValueError):
        return None, "拿不到金币余额，不敢乱换"
    old_cid = (orig or {}).get("cId")
    try:
        floor = int(int((orig or {}).get("cost") or 0) * float((fb or {}).get("min_ratio") or 0))
    except (TypeError, ValueError):
        floor = 0

    best_cost, best = None, None
    poor = low = oos = 0
    for p in prizes:
        if not p.get("cId") or p.get("cId") == old_cid:
            continue
        try:
            cost = int(p.get("cost"))
        except (TypeError, ValueError):
            continue
        if cost <= 0:
            continue
        if no_stock(p):
            oos += 1
            continue
        if cost > bal:
            poor += 1
            continue
        if floor and cost < floor:
            low += 1
            continue
        if best_cost is None or cost > best_cost:
            best_cost, best = cost, p
    if best is None:
        return None, ("没有可换的商品（买不起 %d 个 · 低于门槛 %d 个 · 缺货 %d 个，余额 %s）"
                      % (poor, low, oos, bal))
    return best, "同价位取列表顺序第一个 · 余额 %s" % bal


def resolve_prize(prizes, prize, list_error=None):
    """开抢前用最新列表校正任务里的商品信息。

    返回 (fresh|None, gone: bool)。cId 对不上时按商品名再救一次
    （活动换批次时同款商品可能换了 cId）。
    """
    prizes = prizes or []
    if not prizes:
        return None, False
    cid = (prize or {}).get("cId")
    for p in prizes:
        if p.get("cId") == cid:
            return p, False
    name = ((prize or {}).get("cName") or "").strip()
    if name:
        for p in prizes:
            if (p.get("cName") or "").strip() == name:
                return p, False
    if list_error:
        return None, False          # 列表这次没刷成功 → 不能断定商品没了
    return None, True


# ------------------------------------------------------------------ 库存变化
def diff_stock(prev_seen, prizes, notify_new=True, notify_restock=True):
    """比对上次快照，找出「新品上架 / 补货」。

    prev_seen: {cId(str): {"cName":.., "cost":.., "stock":.., "out":bool}}
    返回 (changes:list, new_seen:dict, baseline:bool)
    """
    seen = {}
    changes = []
    baseline = not prev_seen
    for p in prizes or []:
        cid = str(p.get("cId"))
        item = {"cName": p.get("cName"), "cost": p.get("cost"),
                "stock": p.get("stock"), "out": bool(p.get("outOfStock"))}
        seen[cid] = item
        if baseline:
            continue
        old = prev_seen.get(cid)
        if old is None:
            if notify_new and not item["out"]:
                changes.append({"cId": cid, "cName": item["cName"], "cost": item["cost"],
                                "stock": item["stock"], "kind": "new"})
            continue
        old_out = bool(old.get("out"))
        try:
            old_stock = int(old.get("stock"))
        except (TypeError, ValueError):
            old_stock = None
        try:
            new_stock = int(item["stock"])
        except (TypeError, ValueError):
            new_stock = None
        # 由无货变有货，或库存变多了 → 补货
        became_available = old_out and not item["out"]
        stock_up = (old_stock is not None and new_stock is not None and new_stock > old_stock)
        if notify_restock and not item["out"] and (became_available or stock_up):
            changes.append({"cId": cid, "cName": item["cName"], "cost": item["cost"],
                            "stock": item["stock"], "kind": "restock"})
    return changes, seen, baseline


# ------------------------------------------------------------------ 会话
class DewuSession:
    """一个得物账号的请求会话（token + 活动 id + 请求头 + 兑换循环）。"""

    def __init__(self, token, activity=None, device=None, sign=None, timeout=12):
        self.token = _bearer(token)
        self.activity = str(activity or "").strip()
        self.device = device or {}
        self.sign = (sign or DEFAULT_LIST_SIGN).strip()
        self.timeout = timeout

    # ---------- 列表 ----------
    def fetch_list(self, activity=None):
        """拉一次商品列表。返回 (ok, {balance, prizes}|错误dict)。"""
        act = str(activity or self.activity or "").strip()
        if not act:
            return False, {"_err": "还没设置活动 id（管理员可在全局设置里指定）"}
        url = list_url(act, self.sign)
        last = None
        for attempt in range(3):          # 700 风控时带退避重试
            try:
                r = requests.get(url, headers=h5_headers(self.token, self.device),
                                 timeout=self.timeout)
                j = r.json()
            except Exception as e:
                return False, {"_err": "网络异常：%r" % (e,)}
            last = j
            if j.get("code") == CODE_SUCCESS:
                return True, parse_list(j)
            if j.get("code") == CODE_PARAM_ERR:
                break
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
        code = (last or {}).get("code")
        msg = (last or {}).get("msg") or "未知错误"
        return False, {"code": code, "msg": msg, "_err": friendly_code(code, msg)}

    # ---------- 兑换 ----------
    def exchange(self, prize):
        """发一次兑换请求，返回接口原始 json（异常时返回 {_err:...}）。"""
        headers = h5_headers(self.token, self.device)
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        data = {"cId": prize.get("cId"), "pId": prize.get("pId"),
                "skuId": prize.get("skuId"), "activity": self.activity}
        try:
            r = requests.post(EXCHANGE_URL, data=data, headers=headers, timeout=8)
            return r.json()
        except Exception as e:
            return {"_err": repr(e)}

    def _fire(self, prize, cfg, attempt_offset, on_event, should_stop):
        """跑一轮抢兑。返回结果 dict（含 why，供上层决定要不要降级）。"""
        def log(msg, level="info"):
            if on_event:
                on_event(level, msg)

        interval = max(30, int(cfg.get("interval_ms", 200)))
        max_attempts = max(1, int(cfg.get("max_attempts", 600)))
        deadline = time.time() + int(cfg.get("max_duration_sec", 180))
        attempts = 0
        fatal_n = 0
        c700 = 0
        sess = requests.Session()
        res = {"ok": False, "why": "soldout", "attempts": attempt_offset,
               "detail": "", "raw": None, "balance": None, "sess": sess}

        log("开始兑换「%s」金币%s（cId=%s pId=%s skuId=%s，最多 %d 次 / %ds）"
            % (prize.get("cName"), prize.get("cost"), prize.get("cId"),
               prize.get("pId"), prize.get("skuId"), max_attempts,
               int(cfg.get("max_duration_sec", 180))))

        while attempts < max_attempts and time.time() < deadline:
            if should_stop and should_stop():
                res.update(why="cancelled", detail="已手动停止",
                           attempts=attempt_offset + attempts)
                return res
            attempts += 1
            headers = h5_headers(self.token, self.device)
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            data = {"cId": prize.get("cId"), "pId": prize.get("pId"),
                    "skuId": prize.get("skuId"), "activity": self.activity}
            try:
                r = sess.post(EXCHANGE_URL, data=data, headers=headers, timeout=6)
                j = r.json()
            except Exception as e:
                j = {"_err": repr(e)}
            code = j.get("code")

            if code == CODE_SUCCESS:
                d = j.get("data")
                res.update(ok=True, why="ok", raw=d,
                           detail=json.dumps(d, ensure_ascii=False)[:160],
                           attempts=attempt_offset + attempts,
                           balance=(d or {}).get("balance") if isinstance(d, dict) else None)
                log(">>> 第 %d 次尝试：兑换成功！" % (attempt_offset + attempts), "ok")
                return res

            if code == CODE_INSUFFICIENT:
                res.update(why="poor", detail="余额不足",
                           attempts=attempt_offset + attempts)
                log("第 %d 次：余额不足，停止" % (attempt_offset + attempts), "warn")
                return res

            msg = j.get("msg") or j.get("_err") or ""
            if attempts <= 8 or attempts % 20 == 0:
                log("第 %d 次：code=%s msg=%s" % (attempt_offset + attempts, code, msg))

            if is_fatal(msg):
                fatal_n += 1
                if fatal_n >= FATAL_STRIKES:
                    res.update(why="gone",
                               detail="%s（商品/活动已失效，第 %d 次即停止重试）"
                                      % (msg, attempt_offset + attempts),
                               attempts=attempt_offset + attempts)
                    log("连续 %d 次「%s」→ 判定商品/活动已失效，停止（只试了 %d 次，没空刷）"
                        % (fatal_n, msg, attempts), "warn")
                    return res
            else:
                fatal_n = 0

            if code == CODE_NOT_LOGIN:
                c700 += 1
                if c700 >= 10:
                    res.update(why="stop",
                               detail="连续被风控拦截(请先登录)，请稍后重试或重新登录",
                               attempts=attempt_offset + attempts)
                    log("连续 10 次 700，停止", "error")
                    return res
                time.sleep(min(2.0, 0.3 * (2 ** min(c700, 3))))
                continue
            c700 = 0
            time.sleep(interval / 1000.0 + random.uniform(0, 0.02))

        res.update(attempts=attempt_offset + attempts,
                   detail="尝试 %d 次未成功" % (attempt_offset + attempts))
        log("停止：%s" % res["detail"], "warn")
        return res

    def run_task(self, prize, cfg, on_event=None, should_stop=None):
        """完整的一次抢兑（含开抢前校正商品 + 失败后自动降级）。

        cfg: {interval_ms, max_attempts, max_duration_sec, fallback:{...}}
        返回 {ok, status, detail, attempts, prize, fell_back, balance, raw}
        """
        def log(msg, level="info"):
            if on_event:
                on_event(level, msg)

        orig = dict(prize)
        cur = dict(prize)
        fb = dict(cfg.get("fallback") or {})
        out = {"ok": False, "status": "失败", "detail": "", "attempts": 0,
               "prize": cur, "fell_back": False, "balance": None, "raw": None}

        # 开抢前校正：列表里商品可能换了 cId（活动换批次）
        ok, data = self.fetch_list()
        if ok:
            fresh, gone = resolve_prize(data["prizes"], cur, None)
            if fresh:
                cur = fresh
                out["prize"] = cur
            elif gone:
                log("商品「%s」已不在列表里" % (cur.get("cName") or ""), "warn")
        else:
            log("开抢前刷新列表失败（%s），按原配置继续尝试"
                % (data.get("_err") or data), "warn")

        for _round in (1, 2):
            res = self._fire(cur, cfg, out["attempts"], on_event, should_stop)
            out["attempts"] = res["attempts"]
            out["raw"] = res.get("raw")
            out["balance"] = res.get("balance") or out["balance"]
            if res["ok"]:
                out.update(ok=True, status="成功", detail=res["detail"])
                return out
            if res["why"] in ("stop", "cancelled"):
                out.update(status="已取消" if res["why"] == "cancelled" else "失败",
                           detail=res["detail"])
                return out

            out["detail"] = res["detail"]
            # ---- 判断要不要自动降级 ----
            if out["fell_back"] or not fb.get("enabled"):
                break
            why = res["why"]
            if why == "gone" and not fb.get("on_gone"):
                break
            if why == "poor" and not fb.get("on_poor"):
                break
            if why == "soldout" and not fb.get("on_soldout"):
                break

            ok2, data2 = self.fetch_list()
            if not ok2:
                log("本想自动降级，但列表刷新失败（%s）→ 按失败处理"
                    % (data2.get("_err") or data2), "warn")
                break
            alt, tip = pick_fallback(data2["prizes"], data2.get("balance"), orig, fb)
            if not alt:
                log("本想自动降级，但%s → 按失败处理" % tip, "warn")
                break
            reason = {"gone": "商品/活动已失效", "poor": "余额买不起原商品",
                      "soldout": "原商品一直没抢到"}.get(why, why)
            log("↩ %s → 自动降级换商品：「%s」→「%s」金币%s（%s）"
                % (reason, orig.get("cName"), alt.get("cName"), alt.get("cost"), tip), "warn")
            cur = alt
            out["prize"] = cur
            out["fell_back"] = True
            out["detail"] = ""

        out["status"] = "失败"
        return out

    # ---------- 安全探针 ----------
    def probe_chain(self, prizes, balance):
        """不花金币地验证「token/参数/链路」是否正常。

        手法：挑一个**余额买不起**的商品去兑换，服务端会回「余额不足」——
        既证明整条链路通，又不会真的扣币。返回 (ok, 文案)。
        """
        try:
            bal = int(balance)
        except (TypeError, ValueError):
            return None, "拿不到余额，无法安全探测"
        cand = None
        for p in prizes or []:
            try:
                if int(p.get("cost")) > bal:
                    cand = p
                    break
            except (TypeError, ValueError):
                continue
        if not cand:
            return None, "所有商品都买得起，找不到可安全探测的商品（探测会真的兑换）"
        j = self.exchange(cand)
        code = j.get("code")
        if code == CODE_INSUFFICIENT:
            return True, "链路正常：token / 参数 / 兑换接口都通（用「%s」探测，回的是余额不足，没扣币）" % cand.get("cName")
        if code == CODE_SUCCESS:
            return True, "⚠ 链路正常，但探测商品居然兑换成功了（金币已扣）：%s" % cand.get("cName")
        return False, "链路异常：code=%s msg=%s" % (code, j.get("msg"))

    # ---------- 每日答题 ----------
    def answer_today(self, biz=DEFAULT_BIZ_ACTIVITY, sign=None):
        url = "%s?bizActivity=%s" % (ANSWER_TODAY, biz)
        try:
            r = requests.get(url, headers=h5_headers(self.token, self.device),
                             timeout=self.timeout)
            j = json.loads(r.content.decode("utf-8", "replace"))
        except Exception as e:
            return None, "网络异常：%r" % (e,)
        if j.get("code") != CODE_SUCCESS:
            return None, answer_friendly(j)
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
            "answered": d.get("status") == 1,
        }, None

    def answer_submit(self, question_id, answer, biz=DEFAULT_BIZ_ACTIVITY, sign=None):
        sg = (sign or DEFAULT_ANSWER_SIGN).strip()
        h = h5_headers(self.token, self.device)
        h["Content-Type"] = "application/json"
        body = {"bizActivity": biz, "questionId": question_id, "answer": answer}
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        last = None
        for s in ((sg, None) if sg else (None,)):      # sign 有问题就不带 sign 再试一次
            url = "%s?sign=%s" % (ANSWER_SUBMIT, s) if s else ANSWER_SUBMIT
            try:
                r = requests.post(url, headers=h, data=data, timeout=self.timeout)
                j = json.loads(r.content.decode("utf-8", "replace"))
            except Exception as e:
                return None, "网络异常：%r" % (e,)
            last = j
            if s and _sign_problem(j):
                continue
            return j, None
        return last, None


def _sign_problem(j):
    if not isinstance(j, dict):
        return False
    msg = str(j.get("msg") or "")
    return any(k in msg for k in ("签名", "sign", "非法请求", "校验失败"))


# ------------------------------------------------------------------ 文案
def friendly_code(code, msg=""):
    """把列表/兑换接口的错误码翻译成人话。"""
    s = str(msg or "")
    if code == CODE_NOT_LOGIN:
        return "登录态失效或被风控拦截（code=700）—— 请重新登录，或稍后再试"
    if code == 460:
        return "被风控拦截（code=460）—— 稍后再试，或用「粘贴 curl 登录」刷新设备指纹"
    if any(k in s for k in ("活动不存在", "活动已结束", "活动结束", "已失效", "过期")):
        return ("活动已结束或活动 id 不对（code=%s %s）—— "
                "请管理员在「全局设置」里更新活动 id" % (code, s))
    if code == CODE_PARAM_ERR:
        return "参数错误（code=%s %s）—— 活动 id / sign 可能已失效" % (code, s)
    return "code=%s %s" % (code, s or "未知错误")


def answer_friendly(j):
    if not isinstance(j, dict):
        return "响应异常"
    code, msg = j.get("code"), str(j.get("msg") or "")
    if code == CODE_SUCCESS:
        return "成功"
    if code == CODE_ALREADY_ANSWERED:
        return "今日已答对（跳过）"
    if code == CODE_ANSWER_PARAM_ERR:
        return "参数错误：答案不能为空"
    if code == CODE_NOT_LOGIN:
        return "登录态失效 —— 请重新登录"
    if code == 460:
        return "被风控拦截（460）—— 稍后再试"
    return "code=%s %s" % (code, msg or "未知错误")


def answer_classify(j):
    """→ (kind, 文案)，kind: ok / wrong / done / err"""
    if not isinstance(j, dict):
        return "err", "响应异常"
    code = j.get("code")
    d = j.get("data") or {}
    if code == CODE_SUCCESS:
        if d.get("correct") is True:
            coin = d.get("coinEarned")
            return "ok", ("答对，+%s 金币" % coin) if coin is not None else "答对"
        if d.get("correct") is False:
            remain = d.get("remainAttempts")
            return "wrong", "答案不对" + (("，还剩 %s 次机会" % remain) if remain is not None else "")
        return "ok", "提交成功"
    if code == CODE_ALREADY_ANSWERED:
        return "done", "今日已答对"
    return "err", answer_friendly(j)


def answer_hint(info):
    if not info:
        return ""
    parts = []
    if info.get("word_count"):
        parts.append("%s 个字" % info["word_count"])
    if info.get("category"):
        parts.append(info["category"])
    return " · ".join(parts)
