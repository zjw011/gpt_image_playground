# -*- coding: utf-8 -*-
"""
得物整点抢兑助手 · 核心逻辑 (账号 / 商品 / 定时任务 / 兑换 / 诊断)
（文件底部还留着一套本地 Web 界面, 仅在直接运行本文件时启用;
  正常使用请运行桌面版 得物整点抢兑助手.exe）
- 账号管理: 每个账号粘贴一次手机抓包的商品列表 curl 即可导入
- 每账号独立: 金币余额 / 商品列表 / 兑换任务
- 任务列表: 每条任务 = 账号 + 商品 + 定时(默认10:00:00), 多任务并行
- 双击 exe 自动打开浏览器操作页面
"""
import json
import os
import sys
import re
import socket
import struct
import shlex
import threading
import time
import random
import hashlib
import datetime
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

import dewu_push as PUSH

APP_DIR = os.path.dirname(os.path.abspath(sys.argv[0])) if getattr(sys, "frozen", False) else os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
ACCOUNTS_PATH = os.path.join(APP_DIR, "accounts.json")
TASKS_PATH = os.path.join(APP_DIR, "tasks.json")
WATCH_PATH = os.path.join(APP_DIR, "watch_state.json")   # 库存监听的商品快照
LOG_PATH = os.path.join(APP_DIR, "dewu_sniper.log")
PORT = 8642

EXCHANGE_URL = "https://app.dewu.com/hacking-game-platform/v1/gameplay/branch/exchange"
CODE_SUCCESS = 200
CODE_INSUFFICIENT = 906020010
CODE_NOT_LOGIN = 700
CODE_PARAM_ERR = 900

# 这些提示语代表「商品/活动已经没了」= 永久性错误, 再怎么重试也不会变好。
# 实测坑: 商品被下架后接口一直返回 code=110000003 msg=商品不存在,
#         旧逻辑会一路刷到 max_attempts(200 多次)才停, 把当天有限的抢兑机会全耗光。
# 注意: 故意**不**包含「库存不足 / 已售罄」—— 那些是瞬时竞争, 继续刷还有机会。
FATAL_MSG_HINTS = (
    "商品不存在", "商品已下架", "已下架", "商品已失效", "商品已过期",
    "活动不存在", "活动已结束", "活动结束", "活动已失效", "活动已过期",
    "链接已失效", "活动未开始", "不在活动",
)
# 连续命中几次才判定为真失效(防止单次抖动误杀)
FATAL_STRIKES = 2

DEFAULT_CONFIG = {
    "target_time": "10:00:00",
    "lead_ms": 300,
    "interval_ms": 200,
    "max_attempts": 600,
    "max_duration_sec": 180,
    "repeat_daily": False,
    # 商品已下架/不在列表里时, 直接停掉该任务(配置已失效, 重试没有意义)。
    # 想让任务即使商品没了也每天继续试, 把它改成 false。
    "stop_on_gone": True,
    # 微信推送(PushPlus): 详见 dewu_push.py
    "pushplus": {"key": "", "enabled": False, "on_fail": False, "sent": 0},
    # 每日答题: 详见 dewu_answer.py
    #   biz_activity 固定 2; sign 只与接口路径绑定(与账号无关), 一般不用改
    "answer": {"biz_activity": 2, "sign": "", "skip_answered": True},
    # 库存监听: 只用一个账号的 token 定时查商品列表, 发现「新品上架 / 补货」就推微信
    #   account_id 为 None = 用第一个账号
    "watch": {"enabled": False, "account_id": None, "interval_sec": 30,
              "notify_new": True, "notify_restock": True},
    # 自动降级兜底: 配置的商品没了 / 抢不到时, 自动改抢一个「有货且买得起」的替代品。
    #   ★ 语义提示: 这是「尽量把金币花出去」, 和「没抢到就留着金币」正好相反,
    #     所以是可关的 —— 新建任务时默认带上(enabled=True), 每个任务也能单独关。
    #   挑替代品的规则(固定): 价格降序 → 同价取商品列表顺序第一个 → 排除缺货的。
    #   on_gone    商品从列表消失(下架 / 活动换批次)  → 降级
    #   on_soldout 原商品一直没抢到(售罄 / 刷满次数)  → 降级(会牺牲掉等补货的机会)
    #   on_poor    余额买不起原商品                   → 降级(默认关, 免得不知情就把币花掉)
    #   min_ratio  最低价格门槛(相对原价): 0 = 不设门槛, 0.5 = 低于原价一半就不换
    "fallback": {
        "enabled": True, "on_gone": True, "on_soldout": True,
        "on_poor": False, "min_ratio": 0.0,
    },
}


def flog(msg):
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def parse_curl(text):
    text = text.strip().replace("^", " ")
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


def _xat_of_curl(curl_text):
    """取出一段 curl 里的 x-auth-token（大小写不敏感）。
    这是同一账号在不同导入渠道（手动抓包 / 浏览器自动登录）之间的稳定标识 ——
    Cookie 会随抓包时间变化，但 x-auth-token 在同一登录态下不变。"""
    try:
        _, headers, _, _ = parse_curl(curl_text or "")
    except Exception:
        return None
    for k, v in headers.items():
        if k.lower() == "x-auth-token" and v:
            return v
    return None


def ntp_offset(host="ntp.aliyun.com", timeout=2.0):
    try:
        msg = b"\x1b" + 47 * b"\0"
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(timeout)
        t0 = time.time()
        s.sendto(msg, (host, 123))
        data, _ = s.recvfrom(1024)
        t1 = time.time()
        s.close()
        secs = struct.unpack(">I", data[40:44])[0] - 2208988800
        frac = struct.unpack(">I", data[44:48])[0] / 2 ** 32
        server = secs + frac
        return ((server - t0) + (server - t1)) / 2
    except Exception:
        return None


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, obj):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


class Manager:
    def __init__(self):
        self.lock = threading.RLock()
        self.accounts = load_json(ACCOUNTS_PATH, [])
        self.tasks = load_json(TASKS_PATH, [])
        self.acct_state = {}     # id -> {balance, prizes, error, refreshed_at}
        self.logs = []
        self.last_diag = None    # 最近一次诊断结果
        self.diag_seq = 0
        self.cfg = dict(DEFAULT_CONFIG, **load_json(CONFIG_PATH, {}))
        # 嵌套段要逐键补齐: 用户的 config.json 里可能只写了其中几个键
        for _sec in ("watch", "answer", "pushplus", "fallback"):
            _d = DEFAULT_CONFIG.get(_sec)
            if isinstance(_d, dict):
                self.cfg[_sec] = dict(_d, **(self.cfg.get(_sec) or {}))
        save_json(CONFIG_PATH, self.cfg)
        self._next_account_id = 1 + max([a.get("id", 0) for a in self.accounts], default=0)
        self._next_task_id = 1 + max([t.get("id", 0) for t in self.tasks], default=0)
        # 库存监听
        self.watch_state = load_json(WATCH_PATH, {})   # {seen: {cId: {...}}, baseline, ...}
        self._watch_stop = threading.Event()
        self._watch_thread = None
        self._watch_lock = threading.Lock()            # 保证自动巡检 / 手动检查不会同时跑
        # 恢复未完成任务线程
        for t in self.tasks:
            # 老任务(升级前建的)没有 fb / _orig_prize → 按当前全局策略补齐,
            # 免得读的时候天天要做 None 判断, 也让人一眼能从 tasks.json 看出这个任务会不会降级
            t.setdefault("fb", dict(self.fb_cfg()))
            t.setdefault("_orig_prize", dict(t.get("prize") or {}))
            if t.get("status") in ("等待", "兑换中", ""):
                t["status"] = "等待"
                threading.Thread(target=self._task_worker, args=(t,), daemon=True).start()
        # 上次退出时库存监听是开着的 → 自动接着监听
        if self.watch_cfg().get("enabled") and self.watch_account():
            self.watch_start(silent=True)

    # ---------- 日志 ----------
    def log(self, msg):
        line = "%s  %s" % (datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3], msg)
        with self.lock:
            self.logs.append(line)
            self.logs = self.logs[-800:]
        flog(msg)

    # ---------- 账号 ----------
    def add_account(self, name, curl):
        try:
            url, headers, _, _ = parse_curl(curl)
            if not url or "dewu.com" not in url:
                return {"ok": False, "msg": "curl 解析失败：请粘贴完整的手机抓包 curl（含 Cookie）"}
            new_xat = _xat_of_curl(curl)
            token = headers.get("cookieToken") or headers.get("duToken") or headers.get("Cookie", "")
            if not token and new_xat:
                token = new_xat
            fp = hashlib.md5(token.encode("utf-8")).hexdigest()[:8]
            with self.lock:
                hit = None
                for a in self.accounts:
                    if a.get("fp") == fp:
                        hit = a
                        break
                if hit is None and new_xat:
                    # 跨渠道识别：手动粘贴的 curl 与「网页登录」自动抓取的 Cookie 不一样，
                    # 但 x-auth-token 相同 → 判定为同一账号，做更新而不是新增。
                    for a in self.accounts:
                        if _xat_of_curl(a.get("list_curl", "")) == new_xat:
                            hit = a
                            break
                if hit is not None:
                    a = hit
                    # 同一账号再次导入 = 用户重新抓了包(通常活动/登录态变了) → 直接更新抓包
                    old_act = self._activity_for(a)
                    a["list_curl"] = curl.strip()
                    a["fp"] = fp
                    if name:
                        a["name"] = name
                    new_act = self._activity_for(a)
                    save_json(ACCOUNTS_PATH, self.accounts)
                    self.log("更新账号抓包: %s (活动 %s -> %s)" % (a["name"], old_act, new_act))
                    threading.Thread(target=self.refresh_account, args=(a["id"],), daemon=True).start()
                    return {"ok": True, "updated": True,
                            "account": {"id": a["id"], "name": a["name"]},
                            "msg": "该账号已存在，已用最新登录态更新（活动 %s）" % new_act}
                acc = {"id": self._next_account_id, "name": name or ("账号%d" % self._next_account_id),
                       "list_curl": curl.strip(), "fp": fp}
                self._next_account_id += 1
                self.accounts.append(acc)
                save_json(ACCOUNTS_PATH, self.accounts)
            self.log("添加账号: %s" % acc["name"])
            threading.Thread(target=self.refresh_account, args=(acc["id"],), daemon=True).start()
            return {"ok": True, "account": {"id": acc["id"], "name": acc["name"]}}
        except Exception as e:
            return {"ok": False, "msg": "添加失败: %r" % e}

    def delete_account(self, acc_id):
        with self.lock:
            for t in self.tasks:
                if t["account_id"] == acc_id and t["status"] in ("等待", "兑换中"):
                    return {"ok": False, "msg": "该账号还有进行中的任务，请先删除任务"}
            self.accounts = [a for a in self.accounts if a["id"] != acc_id]
            save_json(ACCOUNTS_PATH, self.accounts)
            self.acct_state.pop(acc_id, None)
        self.log("已删除账号 #%s" % acc_id)
        return {"ok": True}

    def get_account(self, acc_id):
        with self.lock:
            return next((a for a in self.accounts if a["id"] == acc_id), None)

    def _headers_for(self, acc):
        _, headers, _, _ = parse_curl(acc["list_curl"])
        for k in ("Host", "Content-Length", "Accept-Encoding", "Connection"):
            headers.pop(k, None)
        headers.setdefault("Accept", "*/*")
        return headers

    def _list_url_for(self, acc):
        """直接使用抓包 curl 里的原始 URL。
        activity / sign 与抓包那一刻绑定，不能自行替换成"今天"——
        活动 id 是整场活动的编号（可能跨天持续），替换后服务端会返回"活动不存在"。
        """
        url, _, _, _ = parse_curl(acc["list_curl"])
        return url

    def _activity_for(self, acc):
        """从抓包 curl 的 URL 里取出该账号对应的活动 id。"""
        url, _, _, _ = parse_curl(acc["list_curl"])
        m = re.search(r"[?&]activity=([^&\s]+)", url or "")
        if m:
            return m.group(1)
        return datetime.datetime.now().strftime("%Y%m%d")

    def _fetch_list(self, acc):
        """拉一次商品列表（700 风控带退避重试）。返回 (ok, j)。

        ok=False 时 j 要么是 {"_exc": ...}（网络异常）要么是接口的 {code, msg}。
        这里只负责"拿数据"，**不写 acct_state、不打日志** ——
        库存监听每几十秒就要查一次，不能让日志被刷屏。
        """
        j = None
        for attempt in range(3):
            try:
                r = requests.get(self._list_url_for(acc), headers=self._headers_for(acc), timeout=8)
                j = r.json()
            except Exception as e:
                return False, {"_exc": repr(e)}
            if j.get("code") == CODE_SUCCESS:
                return True, j
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
        return False, (j if j is not None else {"_exc": "无响应"})

    def refresh_account(self, acc_id):
        acc = self.get_account(acc_id)
        if not acc:
            return
        state = self.acct_state.setdefault(acc_id, {})
        ok, j = self._fetch_list(acc)
        if not ok:
            err = j.get("_exc") or ("code=%s %s" % (j.get("code"), j.get("msg")))
            state["error"] = err
            if j.get("_exc"):
                self.log("[%s] 拉取列表异常: %s" % (acc["name"], err))
            elif any(k in str(err) for k in ("活动", "不存在", "结束", "失效", "过期")):
                self.log("[%s] 拉取列表失败: %s → 抓包链接绑定的活动已结束/更换，"
                         "请在手机上重新进入活动页抓包，再导入该账号（同一账号导入会自动更新链接）"
                         % (acc["name"], err))
            else:
                self.log("[%s] 拉取列表失败: %s（若持续出现: 1)账号被风控临时拦截,等几分钟再试; "
                         "2)在手机App里刷新登录态后重新抓包导入）" % (acc["name"], err))
            return
        self._apply_list(acc, j, log=True)

    def _apply_list(self, acc, j, log=False):
        """把一次成功的列表响应写进 acct_state，返回解析后的商品列表。"""
        data = j.get("data") or {}
        prizes = self._parse_prizes(data)
        state = self.acct_state.setdefault(acc["id"], {})
        state["balance"] = data.get("balance", "-")
        state["prizes"] = prizes
        state["error"] = None
        state["refreshed_at"] = datetime.datetime.now().strftime("%H:%M:%S")
        if log:
            self.log("[%s] 列表刷新成功: %d 个商品, 余额 %s"
                     % (acc["name"], len(prizes), state["balance"]))
        return prizes

    # ---------- 库存监听（新品上架 / 补货 就推微信） ----------
    def watch_cfg(self):
        w = dict(DEFAULT_CONFIG["watch"])
        w.update(self.cfg.get("watch") or {})
        try:
            w["interval_sec"] = max(5, min(3600, int(w.get("interval_sec") or 30)))
        except Exception:
            w["interval_sec"] = 30
        return w

    def watch_account(self):
        """监听用哪个账号 —— 指定的那个没了就退回第一个。"""
        aid = self.watch_cfg().get("account_id")
        if aid is not None:
            acc = self.get_account(aid)
            if acc:
                return acc
        return self.accounts[0] if self.accounts else None

    def watch_status(self):
        w = self.watch_cfg()
        acc = self.watch_account()
        snap = self.watch_state.get("seen") or {}
        return {
            "enabled": bool(w.get("enabled")),
            "running": bool(self._watch_thread and self._watch_thread.is_alive()),
            "account_id": (acc or {}).get("id"),
            "account_name": (acc or {}).get("name"),
            "interval_sec": w.get("interval_sec"),
            "notify_new": bool(w.get("notify_new")),
            "notify_restock": bool(w.get("notify_restock")),
            "tracked": len(snap),
            "baseline": bool(self.watch_state.get("baseline")),
            "checked_at": self.watch_state.get("checked_at"),
            "updated_at": self.watch_state.get("updated_at"),
            "notified": self.watch_state.get("notified", 0),
            "errors": self.watch_state.get("errors", 0),
            "last_error": self.watch_state.get("last_error"),
            "push_ready": PUSH.is_ready(),
        }

    def watch_save_cfg(self, **kw):
        w = self.watch_cfg()
        w.update({k: v for k, v in kw.items() if v is not None})
        self.cfg["watch"] = w
        save_json(CONFIG_PATH, self.cfg)
        return w

    def watch_start(self, silent=False, **kw):
        """开启库存监听。silent=True 时不重复写 config（用于启动时自动恢复）。"""
        if not silent:
            self.watch_save_cfg(enabled=True, **kw)
        acc = self.watch_account()
        if acc is None and not silent:
            self.watch_save_cfg(enabled=False)
            return {"ok": False, "msg": "还没有账号，先导入一个账号才能监听商品列表"}
        if acc is None:
            return {"ok": False, "msg": "还没有账号"}
        self.watch_stop(silent=True)
        self._watch_stop = threading.Event()
        self._watch_thread = threading.Thread(target=self._watch_loop, daemon=True,
                                              name="stock-watch")
        self._watch_thread.start()
        if not silent:
            self.log("[库存监听] 已开启：用「%s」每 %d 秒查一次商品列表"
                     % (acc["name"], self.watch_cfg()["interval_sec"]))
        return {"ok": True}

    def watch_stop(self, silent=False):
        ev = getattr(self, "_watch_stop", None)
        if ev is not None:
            ev.set()          # 让正在 sleep 的循环立刻醒来退出
        if not silent:
            self.watch_save_cfg(enabled=False)
            self.log("[库存监听] 已停止")
        return {"ok": True}

    def watch_once(self):
        """手动立刻检查一次（界面上的按钮）。返回 (ok, msg)。"""
        if not self._watch_lock.acquire(blocking=False):
            return False, "上一轮还在检查中，稍等一下再看"
        try:
            self._watch_tick()
            st = self.watch_status()
            if st.get("last_error"):
                return False, "检查失败：%s" % st["last_error"]
            return True, "检查完成 · 已监听 %d 个商品" % st.get("tracked", 0)
        except Exception as e:
            return False, "检查异常：%r" % (e,)
        finally:
            self._watch_lock.release()

    def _watch_loop(self):
        w = self.watch_cfg()
        self.log("[库存监听] 线程启动（间隔 %d 秒）" % w["interval_sec"])
        while not self._watch_stop.is_set():
            # 手动检查占着锁时这一轮就跳过, 免得两边同时写快照、同一变化推两遍
            if self._watch_lock.acquire(blocking=False):
                try:
                    self._watch_tick()
                except Exception as e:
                    self.log("[库存监听] 本轮异常: %r" % e)
                finally:
                    self._watch_lock.release()
            self._watch_stop.wait(self.watch_cfg()["interval_sec"])
        self.log("[库存监听] 线程已退出")

    def _watch_tick(self):
        acc = self.watch_account()
        if not acc:
            return
        ok, j = self._fetch_list(acc)
        st = self.acct_state.setdefault(acc["id"], {})
        if not ok:
            err = j.get("_exc") or ("code=%s %s" % (j.get("code"), j.get("msg")))
            st["error"] = err
            self.watch_state["last_error"] = err
            self.watch_state["errors"] = self.watch_state.get("errors", 0) + 1
            # 只在第 1 次、之后每 10 次记一条，免得失败重试把日志刷满
            if self.watch_state["errors"] % 10 == 1:
                self.log("[库存监听] 拉取列表失败（第 %d 次）: %s"
                         % (self.watch_state["errors"], err))
            self._watch_save()
            return
        prizes = self._apply_list(acc, j)
        self.watch_state["checked_at"] = datetime.datetime.now().strftime("%m-%d %H:%M:%S")
        self.watch_state["last_error"] = None
        self.watch_state["errors"] = 0
        self._watch_diff(prizes, acc)
        self._watch_save(prizes)

    def _watch_diff(self, prizes, acc):
        """和上一次的快照比对，找出「新品」和「补货」。"""
        w = self.watch_cfg()
        if not self.watch_state.get("baseline"):
            # 第一次只建立基线，不推送 —— 否则一开启就把整个列表推一遍
            self.watch_state["baseline"] = True
            self.log("[库存监听] 已建立基线：%d 个商品（首次不推送，之后发现变化才推）"
                     % len(prizes))
            return
        seen = self.watch_state.get("seen") or {}
        news, restock = [], []
        for p in prizes:
            key = str(p.get("cId"))
            old = seen.get(key)
            if old is None:
                # 新品：还没上架的(缺货)先不推，等它真有货了再说
                if not p.get("outOfStock"):
                    news.append({"cName": p.get("cName"), "cost": p.get("cost"),
                                 "stock": p.get("stock"), "kind": "new"})
                continue
            # 补货：上次缺货/库存为 0，这次有货了
            if old.get("out") and not p.get("outOfStock"):
                restock.append({"cName": p.get("cName"), "cost": p.get("cost"),
                                "stock": p.get("stock"), "kind": "restock"})
        if not news and not restock:
            return
        self.log("[库存监听] 发现变化：新品 %d 件、补货 %d 件%s"
                 % (len(news), len(restock),
                    "  → " + "、".join((x["cName"] or "")[:14]
                                      for x in (news + restock)[:3])))
        items = []
        if w.get("notify_new"):
            items += news
        if w.get("notify_restock"):
            items += restock
        if not items:
            return
        if PUSH.notify_stock(items, account=acc.get("name"),
                             interval_sec=w.get("interval_sec")):
            self.watch_state["notified"] = self.watch_state.get("notified", 0) + len(items)
            self.log("[库存监听] 已推送 %d 件变化到微信" % len(items))
        else:
            self.log("[库存监听] 检测到变化，但没推送（推送未开启 / 没填 token）")

    def _watch_save(self, prizes=None):
        if prizes is not None:
            self.watch_state["seen"] = {
                str(p.get("cId")): {"cName": p.get("cName"), "cost": p.get("cost"),
                                    "stock": p.get("stock"),
                                    "out": bool(p.get("outOfStock"))}
                for p in prizes}
            self.watch_state["updated_at"] = datetime.datetime.now().strftime("%m-%d %H:%M:%S")
        save_json(WATCH_PATH, self.watch_state)

    # ---------- 自动降级兜底（配置的商品没了 / 抢不到 → 换一个买得起的） ----------
    def fb_cfg(self):
        """全局降级策略 —— 新建任务时的默认值。"""
        d = dict(DEFAULT_CONFIG["fallback"])
        d.update(self.cfg.get("fallback") or {})
        for k in ("enabled", "on_gone", "on_soldout", "on_poor"):
            d[k] = bool(d.get(k))
        try:
            d["min_ratio"] = max(0.0, min(1.0, float(d.get("min_ratio") or 0)))
        except (TypeError, ValueError):
            d["min_ratio"] = 0.0
        return d

    def fb_save_cfg(self, **kw):
        c = self.fb_cfg()
        c.update({k: v for k, v in kw.items() if v is not None})
        self.cfg["fallback"] = c
        save_json(CONFIG_PATH, self.cfg)
        return c

    def fb_of(self, task):
        """某个任务实际生效的降级策略: 任务里存过的优先, 没存过就用全局默认。"""
        c = self.fb_cfg()
        c.update({k: v for k, v in (task.get("fb") or {}).items() if v is not None})
        return c

    def pick_fallback(self, task, state):
        """在「有货 + 价格 <= 余额」的商品里挑一个替代品。

        规则(固定, 不让人配):
          · 价格降序 —— 买得起里挑最贵的, 别把 110 币的号浪费在一个 5 币商品上
          · 同价取商品列表顺序第一个
          · 排除掉任务原来那个商品(它已经没了 / 抢不到, 换回来没意义)
          · min_ratio 门槛: 低于 原价*min_ratio 的一律不要(默认 0 = 不设门槛)

        返回 (prize, 说明文字)。prize 为 None 时, 说明文字写清为什么挑不出来。
        """
        prizes = state.get("prizes") or []
        if not prizes:
            return None, "商品列表是空的"
        try:
            bal = int(state.get("balance"))
        except (TypeError, ValueError):
            return None, "拿不到金币余额，不敢乱换"
        orig = task.get("_orig_prize") or task.get("prize") or {}
        old_cid = orig.get("cId")
        try:
            floor = int(int(orig.get("cost") or 0) * self.fb_of(task)["min_ratio"])
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
            if self._no_stock(p):
                oos += 1
                continue
            if cost > bal:
                poor += 1
                continue
            if floor and cost < floor:
                low += 1
                continue
            # 只在「更贵」时覆盖 → 价格相同时保留先遍历到的那个 = 列表顺序第一个
            if best_cost is None or cost > best_cost:
                best_cost, best = cost, p
        if best is None:
            return None, ("没有可换的商品（买不起 %d 个 · 低于门槛 %d 个 · 缺货 %d 个，余额 %d）"
                          % (poor, low, oos, bal))
        return best, ("同价位取列表顺序第一个 · 余额 %d" % bal)

    @staticmethod
    def _no_stock(p):
        """当前是否无货。接口的 outOfStock 标志并不总是准的 ——
        实测有商品 stock=0 但 outOfStock=false, 只信标志会漏掉一部分缺货商品。
        因此「标志为真」或「库存 <= 0」都算缺货。stock 缺失(None)不算。"""
        if p.get("outOfStock"):
            return True
        try:
            return int(p.get("stock")) <= 0
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _parse_prizes(data):
        """把 exchange_list 返回的 data 解析成扁平商品列表"""
        prizes = []
        for item in data.get("prizes") or []:
            p = item.get("prize") or {}
            prizes.append({
                "level": item.get("level", p.get("level", "")),
                "cId": p.get("cId"), "pId": p.get("pId"), "skuId": p.get("skuId"),
                "cName": p.get("cName") or p.get("displayName") or "",
                "cost": p.get("scoreCostOrigin"), "stock": p.get("stock"),
                # outOfStock = 综合判断(标志 或 库存<=0), 只看它即可
                "outOfStock": M._no_stock(p),
                "outOfStockFlag": bool(p.get("outOfStock", False)),
                "isLock": item.get("isLock", False),
            })
        prizes.sort(key=lambda x: (str(x["level"]), x["cost"] or 0))
        return prizes

    # ---------- 诊断 / 测试兑换 ----------
    def _set_diag(self, out):
        with self.lock:
            self.last_diag = out
            self.diag_seq += 1

    def diagnose(self, acc_id, cId=None):
        """全链路诊断: 鉴权头 -> 登录态 -> 兑换接口。
        安全优先: 未指定商品时自动挑一个「余额买不起」的商品去探测, 服务端会返回
        「余额不足」, 既证明 token/参数/链路全部正常, 又不会真的扣金币。
        """
        acc = self.get_account(acc_id)
        if not acc:
            out = {"ok": False, "level": "error", "verdict": "账号不存在",
                   "detail": "", "safe": True, "seq": self.diag_seq + 1}
            self._set_diag(out)
            return out
        name = acc["name"]
        self.log("========== 开始诊断: %s ==========" % name)
        out = {"ok": False, "level": "error", "verdict": "", "detail": "",
               "safe": True, "auto": False, "seq": 0}

        # ---- ① 鉴权头检查 ----
        headers = self._headers_for(acc)
        low = {k.lower(): v for k, v in headers.items()}
        cookie = low.get("cookie", "")
        has_cookie = "dutoken" in cookie.lower() or "x-auth-token" in cookie.lower()
        has_auth = bool(low.get("x-auth-token"))
        has_dup = low.get("dutoken")
        self.log("① 鉴权头: Cookie=%s · x-auth-token=%s · duToken头=%s" % (
            "有" if has_cookie else "缺失", "有" if has_auth else "缺失", "有" if has_dup else "缺失"))
        if not has_auth:
            out["verdict"] = "❌ Token 无效：请求头缺少 x-auth-token"
            out["detail"] = "兑换必须带 x-auth-token 请求头（只在 Cookie 里不够）。请在手机 App 重新抓包后删除该账号再重新导入。"
            self.log("✗ 缺少 x-auth-token 请求头 → Token 无效")
            self._set_diag(out)
            return out

        # ---- ② 登录态 ----
        try:
            r = requests.get(self._list_url_for(acc), headers=headers, timeout=8)
            j = r.json()
        except Exception as e:
            out["verdict"] = "❌ 网络异常：无法连接得物服务器"
            out["detail"] = repr(e)
            self.log("✗ 网络异常: %r" % e)
            self._set_diag(out)
            return out
        code, msg = j.get("code"), j.get("msg", "")
        if code != CODE_SUCCESS:
            if code == CODE_NOT_LOGIN:
                out["verdict"] = "❌ Token 失效 / 被风控拦截（请先登录）"
                out["detail"] = ("服务端返回 code=700 请先登录。两种可能："
                                 "① 登录态已过期 → 在手机 App 重新抓包并重新导入该账号；"
                                 "② 同一环境请求过于频繁触发风控软拦截 → 等几分钟再点测试。")
                self.log("✗ 登录态异常: code=700 msg=%s → Token 失效或被风控" % msg)
            else:
                low_msg = str(msg)
                if any(k in low_msg for k in ("活动", "不存在", "结束", "失效", "过期")):
                    out["verdict"] = "❌ 活动已失效 / 不存在（code=%s）" % code
                    out["detail"] = ("服务端返回: %s。说明这条抓包链接绑定的活动已经结束或更换了。"
                                     "请在手机 App 重新进入该活动页面抓包，再点「导入账号」——"
                                     "同一账号再次导入会自动更新为最新链接。" % msg)
                    self.log("✗ 活动失效: code=%s msg=%s → 请重新抓包导入" % (code, msg))
                else:
                    out["verdict"] = "❌ 登录态异常 code=%s" % code
                    out["detail"] = "服务端返回: %s" % msg
                    self.log("✗ 登录态异常: code=%s msg=%s" % (code, msg))
            self._set_diag(out)
            return out
        data = j.get("data") or {}
        balance = data.get("balance", "-")
        self.log("② 登录态: ✓ 正常 (code 200) · 金币余额 %s" % balance)

        # ---- ③ 选一个探测商品 ----
        prizes = self._parse_prizes(data)
        if not prizes:
            out.update(level="warn", ok=False, verdict="⚠️ 登录态正常，但商品列表为空",
                       detail="活动可能已结束或商品已下架，请确认抓包的活动链接是否最新。")
            self.log("⚠ 商品列表为空")
            self._set_diag(out)
            return out
        try:
            bal = int(balance)
        except Exception:
            bal = 0
        prize = None
        if cId:
            prize = next((p for p in prizes if p["cId"] == cId), None)
            if prize is not None:
                out["safe"] = (prize["cost"] or 0) > bal
                if not out["safe"]:
                    self.log("⚠ 指定商品可用当前余额兑换，测试将真实下单")
        if prize is None:
            unaffordable = [p for p in prizes if (p["cost"] or 0) > bal]
            if unaffordable:
                prize = min(unaffordable, key=lambda p: p["cost"] or 0)
                out["auto"], out["safe"] = True, True
                self.log("③ 自动选取「买不起」的商品探测（不会扣金币）: %s 金币%s > 余额%s"
                         % (prize["cName"], prize["cost"], bal))
            else:
                prize = max(prizes, key=lambda p: p["cost"] or 0)
                out["auto"], out["safe"] = True, False
                self.log("③ 余额充足，自动选取最贵商品探测: %s 金币%s" % (prize["cName"], prize["cost"]))

        # ---- ④ 兑换接口探测 ----
        headers2 = dict(headers)
        headers2["Content-Type"] = "application/x-www-form-urlencoded"
        activity = self._activity_for(acc)
        payload = {"cId": prize["cId"], "pId": prize["pId"], "skuId": prize["skuId"], "activity": activity}
        self.log("④ 兑换接口探测: %s · 金币%s · cId=%s pId=%s skuId=%s activity=%s"
                 % (prize["cName"], prize["cost"], prize["cId"], prize["pId"], prize["skuId"], activity))
        try:
            r2 = requests.post(EXCHANGE_URL, data=payload, headers=headers2, timeout=8)
            raw = r2.text
            j2 = r2.json()
        except Exception as e:
            out["verdict"] = "❌ 兑换接口请求异常"
            out["detail"] = repr(e)
            self.log("✗ 兑换接口异常: %r" % e)
            self._set_diag(out)
            return out
        code2, msg2 = j2.get("code"), j2.get("msg", "")
        self.log("   服务端原始返回: %s" % raw[:300])

        if code2 == CODE_SUCCESS:
            out.update(ok=True, level="warn",
                       verdict="✅ 兑换链路完全正常，且本次测试真的兑换成功了「%s」" % prize["cName"],
                       detail="token 有效、参数正确、库存充足。消耗金币 %s。原始返回: %s" % (prize["cost"], raw[:200]))
            self.log("✓ 兑换成功 → token / 参数 / 库存 全部正常（本次真实扣除了金币）")
        elif code2 == CODE_INSUFFICIENT:
            out.update(ok=True, level="ok",
                       verdict="✅ 兑换链路完全正常 · 仅余额不足",
                       detail=("token 有效、参数正确、接口可达。金币 %s 不足以兑换「%s」(需 %s)——"
                               "这正是正常状态，任务会在余额足够时顺利兑换。" % (bal, prize["cName"], prize["cost"])))
            self.log("✓ 收到「余额不足」(code=%s) → 说明 token 与参数都正确，链路完全正常" % code2)
        elif code2 == CODE_NOT_LOGIN:
            out.update(level="error",
                       verdict="❌ Token 无效 / 被风控拦截（请先登录）",
                       detail="列表接口能通但兑换接口返回 700。通常是风控软拦截，等几分钟重试；若持续出现请重新抓包导入。")
            self.log("✗ 兑换接口返回 700 → token 失效或被风控")
        elif code2 == CODE_PARAM_ERR:
            out.update(level="warn",
                       verdict="⚠️ 参数不合法（code=900）",
                       detail="接口可达、token 有效，但参数被拒。可能活动已更换或商品参数已变更，请重新抓包确认接口。")
            self.log("⚠ 兑换接口返回 900 参数不合法")
        else:
            out.update(level="warn",
                       verdict="⚠️ 兑换接口返回未知结果 code=%s" % code2,
                       detail="服务端消息: %s" % msg2)
            self.log("⚠ 兑换接口未知返回: code=%s msg=%s" % (code2, msg2))
        self._set_diag(out)
        return out

    # ---------- 任务 ----------
    def add_task(self, params):
        acc = self.get_account(params.get("account_id"))
        if not acc:
            return {"ok": False, "msg": "账号不存在"}
        cId = params.get("cId")
        if not cId:
            return {"ok": False, "msg": "未选择商品"}
        state = self.acct_state.get(acc["id"], {})
        prize = next((p for p in (state.get("prizes") or []) if p["cId"] == cId), None)
        if not prize:
            return {"ok": False, "msg": "商品不在当前列表中，请先刷新列表"}
        try:
            tstr = str(params.get("time", self.cfg["target_time"])).strip()
            hh, mm, ss = [int(x) for x in tstr.split(":")]
            assert 0 <= hh < 24 and 0 <= mm < 60 and 0 <= ss < 60
            lead = max(0, int(params.get("lead_ms", self.cfg["lead_ms"])))
            interval = max(30, int(params.get("interval_ms", self.cfg["interval_ms"])))
            max_attempts = max(1, int(params.get("max_attempts", self.cfg["max_attempts"])))
            repeat = bool(params.get("repeat_daily", self.cfg["repeat_daily"]))
        except Exception:
            return {"ok": False, "msg": "时间/参数格式错误（目标时间示例 10:00:00）"}
        with self.lock:
            fb = self.fb_cfg()
            if params.get("fallback") is not None:
                fb["enabled"] = bool(params["fallback"])
            task = {"id": self._next_task_id, "account_id": acc["id"], "account_name": acc["name"],
                    "prize": prize, "_orig_prize": dict(prize), "fb": fb,
                    "time": tstr, "lead_ms": lead, "interval_ms": interval,
                    "max_attempts": max_attempts, "repeat_daily": repeat,
                    "status": "等待", "detail": "", "attempts": 0,
                    "created": datetime.datetime.now().strftime("%m-%d %H:%M")}
            self._next_task_id += 1
            self.tasks.append(task)
            save_json(TASKS_PATH, self.tasks)
        self.log("创建任务#%d: [%s] %s 金币%s @ 每天%s%s" % (
            task["id"], acc["name"], prize["cName"], prize["cost"], tstr,
            " · 已开自动降级" if fb["enabled"] else ""))
        threading.Thread(target=self._task_worker, args=(task,), daemon=True).start()
        return {"ok": True, "task": task}

    def delete_task(self, task_id):
        with self.lock:
            task = next((t for t in self.tasks if t["id"] == task_id), None)
        if not task:
            return {"ok": False, "msg": "任务不存在"}
        task["status"] = "已删除"
        with self.lock:
            self.tasks = [t for t in self.tasks if t["id"] != task_id]
            save_json(TASKS_PATH, self.tasks)
        self.log("已删除任务#%d" % task_id)
        return {"ok": True}

    def clear_done(self):
        with self.lock:
            self.tasks = [t for t in self.tasks if t["status"] in ("等待", "兑换中")]
            save_json(TASKS_PATH, self.tasks)
        return {"ok": True}

    def _next_target(self, tstr):
        hh, mm, ss = [int(x) for x in tstr.split(":")]
        now = datetime.datetime.now()
        tgt = now.replace(hour=hh, minute=mm, second=ss, microsecond=0)
        if tgt <= now:
            tgt += datetime.timedelta(days=1)
        return tgt

    # ---------------- 微信推送(PushPlus) ----------------
    def _balance_after(self, acc, task):
        """抢兑成功后拿最新金币余额: 优先用兑换响应里带回来的, 没有再刷新一次列表。"""
        data = task.get("_last_data")
        if isinstance(data, dict):
            for k in ("balance", "gold", "coin", "coinBalance", "remainBalance"):
                v = data.get(k)
                if isinstance(v, (int, float)) or (isinstance(v, str) and v.isdigit()):
                    return v
        try:
            self.refresh_account(acc["id"])
            return (self.acct_state.get(acc["id"]) or {}).get("balance")
        except Exception:
            return None

    def _push_success(self, task, acc):
        """抢兑成功 → 微信推送。全程 try 包住: 推送绝不能影响抢兑本身。"""
        try:
            if not PUSH.is_ready():
                return
            p = task.get("prize") or {}
            bal = self._balance_after(acc, task)
            note = ""
            if task.get("_fell_back"):
                # 降级换商品 = 计划外花掉金币, 必须在卡片里说清楚, 免得用户一脸懵
                old = (task.get("_orig_prize") or {}).get("cName") or "原配置的商品"
                note = ("⚠ 原配置的「%s」已失效或抢不到，本单是【自动降级】后换商品抢到的。"
                        "如果这不是你想要的，去任务列表关掉「自动降级」。" % old)
            PUSH.notify_success(
                account=task.get("account_name") or acc.get("name"),
                prize=p.get("cName"),
                cost=p.get("cost"),
                balance=bal,
                attempts=task.get("attempts"),
                task_id=task.get("id"),
                note=note)
            self.log("[任务#%d] 已发微信推送（余额 %s）" % (task["id"], bal))
        except Exception as e:
            self.log("[任务#%d] 推送失败(不影响抢兑): %r" % (task["id"], e))

    def _push_fail(self, task, acc, reason):
        """抢兑失败 → 仅在设置里勾了「失败也推送」时才发。"""
        try:
            if acc is None:
                return
            p = task.get("prize") or {}
            bal = (self.acct_state.get(acc["id"]) or {}).get("balance")
            reason = reason or "本次未抢到"
            if task.get("_fell_back"):
                old = (task.get("_orig_prize") or {}).get("cName") or "原配置的商品"
                reason += ("（原配置「%s」已失效或抢不到，已自动降级换成「%s」，"
                           "但仍然没抢到）" % (old, p.get("cName")))
            PUSH.notify_fail(
                account=task.get("account_name") or acc.get("name"),
                prize=p.get("cName"),
                reason=reason,
                cost=p.get("cost"),
                balance=bal,
                task_id=task.get("id"))
        except Exception as e:
            self.log("[任务#%d] 失败推送异常: %r" % (task["id"], e))

    # ---------- 任务: 开抢前的商品校正 / 永久失效判定 ----------
    @staticmethod
    def _is_fatal_gone(msg):
        """接口返回的提示语是否属于「商品/活动已经没了」的永久性错误。"""
        s = str(msg or "")
        return any(k in s for k in FATAL_MSG_HINTS)

    def _resolve_prize(self, task, state):
        """开抢前用最新列表校正任务里存的商品信息。

        返回 (fresh, gone):
          fresh = 匹配到的最新商品(可能按名称纠正了 cId/pId/skuId); 没匹配到就是 None
          gone  = 列表刷新成功、但配置的商品确实不在了 → 这次一次都不用抢
        """
        prizes = state.get("prizes") or []
        if not prizes:
            return None, False              # 列表没数据, 沿用原配置(老行为)
        cid = task["prize"].get("cId")
        for p in prizes:
            if p.get("cId") == cid:
                return p, False
        # cId 对不上: 可能活动换了批次, 同款商品换了 cId → 按名称再救一次
        name = (task["prize"].get("cName") or "").strip()
        if name:
            for p in prizes:
                if (p.get("cName") or "").strip() == name:
                    self.log("[任务#%d] 商品 cId 已变化，按名称重新匹配到「%s」(cId %s → %s)"
                             % (task["id"], name, cid, p.get("cId")))
                    return p, False
        if state.get("error"):
            # 这次列表刷新失败, 手里可能还是旧数据 → 不能断定商品没了, 照原配置去抢
            self.log("[任务#%d] 列表刷新失败(%s)，无法确认商品是否还在，仍按原配置尝试"
                     % (task["id"], state.get("error")))
            return None, False
        return None, True

    def _try_fallback(self, task, acc, gone):
        """这一轮失败后，判断要不要自动降级换商品。

        返回 True = 已经换好了(调用方重置计数后再抢一轮); False = 不降级。
        每个任务最多降级一次 —— 否则会一路换到最便宜那个, 变成"清空金币"。
        """
        fb = self.fb_of(task)
        if not fb.get("enabled") or task.get("_fell_back"):
            return False
        detail = task.get("detail") or ""
        if gone or task.get("_fatal"):
            if not fb.get("on_gone"):
                return False
            why = "商品/活动已失效"
        elif "余额不足" in detail:
            if not fb.get("on_poor"):
                return False
            why = "余额买不起原商品"
        else:
            if not fb.get("on_soldout"):
                return False
            why = "原商品一直没抢到"

        state = self.acct_state.get(acc["id"], {})
        alt, tip = self.pick_fallback(task, state)
        if not alt:
            self.log("[任务#%d] %s，本想自动降级，但%s → 按失败处理"
                     % (task["id"], why, tip))
            return False

        old = (task.get("_orig_prize") or {}).get("cName") or \
              (task.get("prize") or {}).get("cName")
        task["prize"] = alt
        task["_fell_back"] = True
        # 换了商品 = 重新开始: 上一轮的失效/风控计数不能带过来, 否则刚开抢就被判死
        task["_fatal"] = False
        task["_fatal_n"] = 0
        task["_c700"] = 0
        self.log("[任务#%d] ↩ %s → 自动降级换商品：「%s」→「%s」金币%s（%s）"
                 % (task["id"], why, old, alt.get("cName"), alt.get("cost"), tip))
        return True

    def _task_worker(self, task):
        try:
            while True:
                if task["status"] not in ("等待",):
                    break
                # 上一轮如果降级换过商品，回到最初配置的那个 ——
                # 明天再试要抢的仍然是原商品，不是昨天临时换上的替代品。
                if task.get("_fell_back"):
                    _o = task.get("_orig_prize")
                    if _o:
                        task["prize"] = dict(_o)
                    task["_fell_back"] = False
                tgt = self._next_target(task["time"])
                task["detail"] = "将于 %s 兑换" % tgt.strftime("%m-%d %H:%M:%S")
                self.log("[任务#%d] %s -> %s (%s)" % (task["id"], task["account_name"], task["prize"]["cName"], task["detail"]))
                fire_ts = (tgt - datetime.timedelta(milliseconds=task["lead_ms"])).timestamp()
                # 倒计时提醒: 跨过里程碑就打一条日志, 让人随时能确认任务还活着、在正常倒数
                marks = [1800, 600, 300, 120, 60, 30]
                remain0 = fire_ts - time.time()
                # 建任务时若已经进入某个区间, 直接算作"已报过", 不再补打一堆没意义的里程碑
                announced = set(mk for mk in marks if remain0 <= mk)
                last_sec = None
                while task["status"] == "等待":
                    remain = fire_ts - time.time()
                    if remain <= 0:
                        break
                    for mk in marks:
                        if remain <= mk and mk not in announced:
                            announced.add(mk)
                            if mk >= 60:
                                self.log("[任务#%d] 倒计时 %d 分钟，将于 %s 开抢"
                                         % (task["id"], mk // 60, tgt.strftime("%H:%M:%S")))
                            else:
                                self.log("[任务#%d] 倒计时 %d 秒，准备中" % (task["id"], mk))
                            break
                    if 0 < remain <= 10:
                        sec = int(remain) + 1
                        if sec != last_sec:
                            last_sec = sec
                            self.log("[任务#%d] 倒计时 %d 秒..." % (task["id"], sec))
                    # 越接近开抢, 轮询越密 —— 保证最后 10 秒的逐秒日志一条不漏
                    if remain > 15:
                        time.sleep(min(remain - 14.5, 2.0))
                    elif remain > 5:
                        time.sleep(min(remain - 4.5, 0.5))
                    else:
                        time.sleep(min(remain, 0.05))
                if task["status"] != "等待":
                    break
                acc = self.get_account(task["account_id"])
                if not acc:
                    task["status"], task["detail"] = "失败", "账号已被删除"
                    break
                self.log("[任务#%d] ⏰ 时间到，开始刷新库存并抢兑" % task["id"])
                # 到点: 先刷新该账号列表拿最新库存, 再兑换
                self.refresh_account(acc["id"])
                state = self.acct_state.get(acc["id"], {})
                fresh, gone = self._resolve_prize(task, state)

                # 重置本次的失效计数(上一次开抢留下的不要带到今天)
                task["_fatal_n"] = 0
                task["_fatal"] = False

                ok = False
                if gone:
                    # 商品已经被下架/换掉 → 一次兑换请求都不发, 直接判失败
                    task["detail"] = "配置的商品已不在列表中（已下架或售罄），开抢前已停止"
                    self.log("[任务#%d] ⚠ %s" % (task["id"], task["detail"]))
                else:
                    if fresh:
                        task["prize"] = fresh
                    task["status"] = "兑换中"
                    ok = self._fire_loop(task, acc)

                # ---------- 没抢到 → 看要不要自动降级，换了商品立刻再抢一轮 ----------
                if not ok and self._try_fallback(task, acc, gone):
                    gone = False
                    task["attempts"] = 0
                    task["status"] = "兑换中"
                    ok = self._fire_loop(task, acc)

                if ok:
                    fallen = bool(task.get("_fell_back"))
                    task["status"] = "成功"
                    task["detail"] = "第 %d 次尝试成功%s" % (
                        task["attempts"], "（已自动降级换商品）" if fallen else "")
                    self.log("===== 任务#%d 兑换成功! [%s] %s%s =====" % (
                        task["id"], task["account_name"], task["prize"]["cName"],
                        "（自动降级）" if fallen else ""))
                    self._push_success(task, acc)
                    break

                # ---------- 失败收尾 ----------
                # 「商品/活动已经没了」= 配置作废, 再重试也没有意义 → 直接停, 别耗到明天
                dead = bool(gone or task.get("_fatal"))
                if dead and self.cfg.get("stop_on_gone", True):
                    task["status"] = "失败"
                    self._push_fail(task, acc, task.get("detail"))
                    self.log("[任务#%d] 已停止该任务（商品/活动已失效）。请到「商品列表」刷新后"
                             "重新选择商品、再建一个任务" % task["id"])
                    break
                self._push_fail(task, acc, task.get("detail"))
                if not task["repeat_daily"]:
                    task["status"] = "失败"
                    break
                # 勾了「每日重复」: 回到等待, 明天同一时间再来
                task["status"] = "等待"
                task["detail"] = "本次未成功，明天再试"
                self.log("[任务#%d] 等待明天同一时间再试..." % task["id"])
                time.sleep(2)
        except Exception as e:
            task["status"], task["detail"] = "失败", repr(e)
            self.log("任务#%d 异常: %r" % (task["id"], e))

    def _fire_loop(self, task, acc):
        p = task["prize"]
        activity = self._activity_for(acc)
        headers = self._headers_for(acc)
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        data = {"cId": p["cId"], "pId": p["pId"], "skuId": p["skuId"], "activity": activity}
        deadline = time.time() + self.cfg.get("max_duration_sec", 180)
        session = requests.Session()
        self.log("[任务#%d] 开始兑换: %s (金币%s) cId=%s pId=%s skuId=%s" % (
            task["id"], p["cName"], p["cost"], p["cId"], p["pId"], p["skuId"]))
        while task["status"] == "兑换中" and task["attempts"] < task["max_attempts"] and time.time() < deadline:
            task["attempts"] += 1
            try:
                r = session.post(EXCHANGE_URL, data=data, headers=headers, timeout=5)
                j = r.json()
                code = j.get("code")
                if code == CODE_SUCCESS:
                    task["detail"] = json.dumps(j.get("data"), ensure_ascii=False)[:120]
                    # 把原始 data 留下来: 若里面带 balance 就不必再发一次列表请求去查余额
                    task["_last_data"] = j.get("data")
                    self.log("[任务#%d] >>> 第 %d 次尝试: 兑换成功!" % (task["id"], task["attempts"]))
                    return True
                elif code == CODE_INSUFFICIENT:
                    task["status"], task["detail"] = "失败", "余额不足"
                    self.log("[任务#%d] 第 %d 次: 余额不足，停止" % (task["id"], task["attempts"]))
                    return False
                else:
                    task["detail"] = "code=%s %s" % (code, j.get("msg", ""))
                    if task["attempts"] <= 8 or task["attempts"] % 20 == 0:
                        self.log("[任务#%d] 第 %d 次: code=%s msg=%s" % (task["id"], task["attempts"], code, j.get("msg", "")))
                    # 商品/活动已失效 = 永久性错误。重试不会变好, 不该把 max_attempts 刷满,
                    # 连续命中 FATAL_STRIKES 次就收手(单次抖动不算)。
                    if self._is_fatal_gone(j.get("msg")):
                        task["_fatal_n"] = task.get("_fatal_n", 0) + 1
                        if task["_fatal_n"] >= FATAL_STRIKES:
                            task["_fatal"] = True
                            task["status"] = "失败"
                            task["detail"] = "%s（商品/活动已失效，第 %d 次即停止重试）" % (
                                task["detail"], task["attempts"])
                            self.log("[任务#%d] 连续 %d 次「%s」→ 判定商品/活动已失效，立即停止"
                                     "（只试了 %d 次，没有空刷）"
                                     % (task["id"], task["_fatal_n"], j.get("msg", ""), task["attempts"]))
                            return False
                    else:
                        task["_fatal_n"] = 0
                    # 700 请先登录 = 风控软拦截, 连续出现时拉长间隔避免火上浇油
                    if code == 700:
                        task["_c700"] = task.get("_c700", 0) + 1
                        if task["_c700"] >= 10:
                            task["status"], task["detail"] = "失败", "连续被风控拦截(请先登录)，请稍后重试或重新抓包导入"
                            self.log("[任务#%d] 连续 10 次 700，停止: %s" % (task["id"], task["detail"]))
                            return False
                        time.sleep(min(2.0, 0.3 * (2 ** min(task["_c700"], 3))))
                        continue
            except Exception as e:
                task["detail"] = repr(e)
                self.log("[任务#%d] 第 %d 次异常: %r" % (task["id"], task["attempts"], e))
            task["_c700"] = 0
            time.sleep(task["interval_ms"] / 1000.0 + random.uniform(0, 0.02))
        if task["status"] == "兑换中":
            task["status"] = "失败"
            task["detail"] = "尝试 %d 次未成功" % task["attempts"]
        self.log("[任务#%d] 停止: %s" % (task["id"], task["detail"]))
        return False


M = Manager()


# ---------------- Web 界面 ----------------
HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>得物整点抢兑助手 · 网页版(备用)</title>
<style>
:root{--red:#e6243f;--bg:#f4f5f7;--card:#fff;--txt:#1f2329;--sub:#8a919f;--line:#eceef1;}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Microsoft YaHei",system-ui,sans-serif;background:var(--bg);color:var(--txt);padding:0 0 30px}
header{background:linear-gradient(120deg,#e6243f,#ff6a3d);color:#fff;padding:18px 22px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
header h1{font-size:19px;font-weight:600}
header .sub{font-size:12px;opacity:.85;margin-top:3px}
#clock{font-family:Consolas,monospace;font-size:26px;font-weight:bold;letter-spacing:1px;text-shadow:0 1px 4px rgba(0,0,0,.25)}
.wrap{max-width:1080px;margin:14px auto 0;padding:0 14px}
.card{background:var(--card);border-radius:12px;padding:16px 18px;margin-bottom:14px;box-shadow:0 1px 6px rgba(31,35,41,.06)}
.card h2{font-size:15px;margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.card h2 .n{background:var(--red);color:#fff;font-size:11px;border-radius:9px;padding:1px 8px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.row .grow{flex:1}
input,select{padding:7px 10px;border:1px solid #d4d7de;border-radius:8px;font-size:13px;outline:none;background:#fff}
input:focus,select:focus{border-color:var(--red)}
button{padding:8px 16px;border:none;border-radius:8px;cursor:pointer;font-size:13px;transition:.15s}
button:disabled{opacity:.45;cursor:not-allowed}
.btn-p{background:var(--red);color:#fff}.btn-p:hover{background:#c81d35}
.btn-s{background:#eef0f3;color:#333}.btn-s:hover{background:#e2e5ea}
.btn-x{background:#fff0f1;color:var(--red);padding:4px 10px;font-size:12px}
.muted{color:var(--sub);font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--sub);font-weight:500;background:#fafbfc}
tr:hover td{background:#f7f9fc}
.tag{display:inline-block;padding:2px 10px;border-radius:20px;font-size:12px}
.tag.ok{background:#e8f8ec;color:#0a9d47}.tag.bad{background:#fdecec;color:#d5304f}
.tag.wait{background:#fff6e5;color:#b26b00}.tag.run{background:#e8f1ff;color:#1b6dd8}
.tag.dis{background:#f0f1f3;color:#8a919f}
.pill{display:inline-flex;align-items:center;gap:6px;background:#f6f7f9;border:1px solid var(--line);border-radius:20px;padding:5px 12px;font-size:13px}
.pill b{font-weight:600}
.pill .dot{width:7px;height:7px;border-radius:50%;background:#0a9d47}
.pill.err .dot{background:#d5304f}
#log{background:#12161c;color:#c9e3ff;font-family:Consolas,monospace;font-size:12px;height:170px;overflow-y:auto;padding:12px;border-radius:10px;white-space:pre-wrap;line-height:1.7}
.prize-table{max-height:340px;overflow-y:auto;border:1px solid var(--line);border-radius:10px}
.prize-table table th{position:sticky;top:0;z-index:1}
.err-line{color:#d5304f;font-size:12px;margin-top:6px}
</style>
</head>
<body>
<header>
  <div><h1>得物整点抢兑助手</h1><div class="sub">网页备用版 · 多账号 · 定时抢兑 · 数据保存在本目录 accounts.json / tasks.json</div></div>
  <div style="text-align:right"><div id="clock">--:--:--</div><button class="btn-s" style="margin-top:4px" onclick="api('/api/ntp')">NTP 校时</button></div>
</header>

<div class="wrap">

<div class="card">
  <h2>👤 账号管理</h2>
  <div class="row" id="acctPills"></div>
  <div style="margin-top:10px" class="row">
    <input id="acctName" placeholder="账号备注名(可留空)" style="width:160px">
    <input id="acctCurl" class="grow" placeholder="粘贴该账号手机抓包的商品列表 curl（含 Cookie 那一条）">
    <button class="btn-p" onclick="addAccount()">导入账号</button>
    <button class="btn-s" onclick="refreshAll()">刷新全部列表</button>
  </div>
  <div class="muted" style="margin-top:6px">提示：不同账号用各自的抓包 curl 导入；工具按 Token 指纹自动去重。</div>
</div>

<div class="card">
  <h2>📦 商品列表
    <select id="acctSel" onchange="render()"></select>
    <span class="muted" id="acctInfo"></span>
    <span class="grow"></span>
    <span id="balance" class="tag ok">金币: -</span>
  </h2>
  <div class="prize-table"><table>
    <thead><tr><th>等级</th><th>商品名称</th><th style="width:90px">所需金币</th><th style="width:60px">库存</th><th style="width:80px">状态</th><th style="width:80px"></th></tr></thead>
    <tbody id="prizeBody"></tbody>
  </table></div>
  <div class="err-line" id="acctErr"></div>
</div>

<div class="card">
  <h2>➕ 新建任务</h2>
  <div class="row">
    <span class="pill" id="pickPill">未选择商品（点列表右侧"选它"）</span>
    <label>目标时间 <input id="time" style="width:88px" value="10:00:00"></label>
    <label>提前(ms) <input id="lead" style="width:64px" value="300"></label>
    <label>重试间隔(ms) <input id="interval" style="width:64px" value="200"></label>
    <label>最大尝试 <input id="maxa" style="width:64px" value="600"></label>
    <label><input type="checkbox" id="repeat"> 每日重复</label>
    <button class="btn-p" onclick="addTask()">创建任务</button>
  </div>
</div>

<div class="card">
  <h2>🗂 任务列表 <span class="n" id="taskCount">0</span>
    <span class="grow"></span>
    <button class="btn-s" onclick="clearDone()">清除已完成/失败记录</button>
  </h2>
  <table>
    <thead><tr><th style="width:44px">#</th><th>账号</th><th>商品</th><th style="width:80px">金币</th><th style="width:80px">时间</th><th style="width:90px">状态</th><th>详情</th><th style="width:70px"></th></tr></thead>
    <tbody id="taskBody"></tbody>
  </table>
</div>

<div class="card"><h2>📜 运行日志</h2><div id="log"></div></div>

</div>
<script>
let S={accounts:[],tasks:[],state:{}};let lastLog=0;let pick=null;
function $i(id){return document.getElementById(id)}
function esc(s){return (s??'').toString().replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}
function fmt(n){return (n<10?'0':'')+n}
setInterval(()=>{const d=new Date();$i('clock').textContent=fmt(d.getHours())+':'+fmt(d.getMinutes())+':'+fmt(d.getSeconds())},200);
async function api(u,body){
  const opt=body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{};
  const r=await fetch(u,opt).then(x=>x.json()).catch(e=>({ok:false,msg:e+''}));
  if(r&&r.ok===false&&r.msg) alert(r.msg);
  await poll();return r;
}
function addAccount(){const c=$i('acctCurl').value.trim();if(!c){alert('请先粘贴抓包 curl');return}
  api('/api/account/add',{name:$i('acctName').value.trim(),curl:c}).then(r=>{if(r.ok){$i('acctCurl').value='';$i('acctName').value=''}})}
function refreshAll(){S.accounts.forEach(a=>api('/api/account/refresh',{id:a.id}))}
function refreshOne(id){api('/api/account/refresh',{id})}
function delAccount(id,name){if(confirm('删除账号「'+name+'」？'))api('/api/account/delete',{id})}
function pickPrize(cId){const st=S.state[$i('acctSel').value]||{};const p=(st.prizes||[]).find(x=>x.cId==cId);if(!p)return;
  pick=p;$i('pickPill').innerHTML='已选: <b>'+esc(p.cName)+'</b>（金币'+p.cost+'）';
  document.querySelectorAll('[data-cid]').forEach(b=>b.textContent='选它');
  const btn=document.querySelector('[data-cid="'+cId+'"]');if(btn)btn.textContent='✓ 已选';}
function addTask(){
  if(!pick){alert('请先在商品列表中选一个商品');return}
  api('/api/task/add',{account_id:+$i('acctSel').value,cId:pick.cId,time:$i('time').value,
    lead_ms:+$i('lead').value,interval_ms:+$i('interval').value,max_attempts:+$i('maxa').value,
    repeat_daily:$i('repeat').checked}).then(r=>{if(r.ok){pick=null;$i('pickPill').textContent='未选择商品（点列表右侧"选它"）'}});
}
function delTask(id){if(confirm('删除该任务？'))api('/api/task/delete',{id})}
function clearDone(){api('/api/task/clear_done',{})}
function render(){
  $i('acctPills').innerHTML=S.accounts.map(a=>{
    const st=S.state[a.id]||{};const err=st.error?' err':'';
    return '<span class="pill'+err+'"><span class="dot"></span><b>'+esc(a.name)+'</b>'+
      (st.balance!==undefined&&st.balance!==null?' 金币'+st.balance:'')+
      (st.error?' <span style="color:#d5304f">'+esc(st.error)+'</span>':'')+
      ' <button class="btn-x" onclick="refreshOne('+a.id+')">刷新</button>'+
      ' <button class="btn-x" onclick="delAccount('+a.id+',\''+esc(a.name)+'\')">删除</button></span>';
  }).join('')||'<span class="muted">还没有账号，请在上方粘贴抓包 curl 导入</span>';
  const sel=$i('acctSel');const old=sel.value;
  sel.innerHTML=S.accounts.map(a=>'<option value="'+a.id+'">'+esc(a.name)+'</option>').join('');
  if(old&&S.accounts.some(a=>a.id==old))sel.value=old;
  const sid=+sel.value||0;const st=S.state[sid]||{};
  $i('balance').textContent='金币: '+(st.balance??'-');
  $i('acctInfo').textContent=st.refreshed_at?('更新于 '+st.refreshed_at):'';
  $i('acctErr').textContent=st.error?('⚠ '+st.error):'';
  $i('prizeBody').innerHTML=(st.prizes||[]).map(p=>{
    const stt=p.isLock?'<span class="tag dis">未解锁</span>':p.outOfStock?'<span class="tag bad">缺货</span>':'<span class="tag ok">可兑换</span>';
    const picked=pick&&pick.cId==p.cId;
    return '<tr><td>'+p.level+'</td><td title="'+esc(p.cName)+'">'+esc(p.cName)+'</td><td>'+(p.cost??'-')+'</td><td>'+(p.stock??'-')+'</td><td>'+stt+'</td>'+
      '<td><button class="btn-s" style="padding:4px 10px;font-size:12px" data-cid="'+p.cId+'" onclick="pickPrize('+p.cId+')">'+(picked?'✓ 已选':'选它')+'</button></td></tr>';
  }).join('')||'<tr><td colspan="6" style="text-align:center;color:#8a919f;padding:16px">'+(S.accounts.length?'暂无数据，点上方"刷新全部列表"':'请先导入账号')+'</td></tr>';
  $i('taskCount').textContent=S.tasks.length;
  const stMap={等待:'wait',兑换中:'run',成功:'ok',失败:'bad'};
  $i('taskBody').innerHTML=S.tasks.map(t=>
    '<tr><td>'+t.id+'</td><td>'+esc(t.account_name)+'</td><td title="'+esc(t.prize.cName)+'">'+esc(t.prize.cName)+'</td><td>'+(t.prize.cost??'-')+'</td>'+
    '<td>'+t.time+'</td><td><span class="tag '+(stMap[t.status]||'wait')+'">'+t.status+'</span></td>'+
    '<td class="muted">'+esc(t.detail||'')+(t.attempts?(' · 已尝试'+t.attempts+'次'):'')+'</td>'+
    '<td><button class="btn-x" onclick="delTask('+t.id+')">删除</button></td></tr>').join('')
    ||'<tr><td colspan="8" style="text-align:center;color:#8a919f;padding:14px">暂无任务</td></tr>';
}
async function poll(){
  try{
    const s=await(await fetch('/api/state')).json();
    S=s;
    for(let i=lastLog;i<s.logs.length;i++){$i('log').textContent+=s.logs[i]+'\n';$i('log').scrollTop=1e9}
    lastLog=s.logs.length;
    render();
  }catch(e){}
}
fetch('/api/cfg').then(r=>r.json()).then(c=>{$i('time').value=c.target_time;$i('lead').value=c.lead_ms;$i('interval').value=c.interval_ms;$i('maxa').value=c.max_attempts;$i('repeat').checked=!!c.repeat_daily});
poll();setInterval(poll,700);
</script>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, ctype, body):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, obj):
        self._send(200, "application/json; charset=utf-8", json.dumps(obj, ensure_ascii=False))

    def _body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        try:
            return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except Exception:
            return {}

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._send(200, "text/html; charset=utf-8", HTML)
        elif self.path == "/api/state":
            with M.lock:
                tasks = [dict(t) for t in M.tasks]
            self._json({
                "accounts": [{"id": a["id"], "name": a["name"]} for a in M.accounts],
                "state": M.acct_state,
                "tasks": tasks,
                "logs": list(M.logs),
            })
        elif self.path == "/api/cfg":
            self._json(M.cfg)
        elif self.path == "/api/ntp":
            def _w():
                off = ntp_offset()
                if off is None:
                    M.log("NTP 校时失败（网络问题），仍使用本机时间")
                else:
                    ms = off * 1000
                    M.log("NTP 校时: NTP比本机 %+.0f ms%s" % (
                        ms, "（误差可忽略）" if abs(ms) < 200 else "（建议: Windows设置→时间和语言→立即同步）"))
            threading.Thread(target=_w, daemon=True).start()
            self._json({"ok": True})
        else:
            self._send(404, "text/plain", "not found")

    def do_POST(self):
        b = self._body()
        if self.path == "/api/account/add":
            self._json(M.add_account(b.get("name"), b.get("curl", "")))
        elif self.path == "/api/account/delete":
            self._json(M.delete_account(b.get("id")))
        elif self.path == "/api/account/refresh":
            threading.Thread(target=M.refresh_account, args=(b.get("id"),), daemon=True).start()
            self._json({"ok": True})
        elif self.path == "/api/task/add":
            self._json(M.add_task(b))
        elif self.path == "/api/task/delete":
            self._json(M.delete_task(b.get("id")))
        elif self.path == "/api/task/clear_done":
            self._json(M.clear_done())
        else:
            self._send(404, "text/plain", "not found")

    def log_message(self, *a):
        pass


def find_free_port(start, tries=20):
    for p in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return start


def main():
    flog("---- 启动(多账号版) ----")
    port = find_free_port(PORT)
    M.log("本地服务已启动: http://127.0.0.1:%d （浏览器将自动打开）" % port)
    for a in M.accounts:
        threading.Thread(target=M.refresh_account, args=(a["id"],), daemon=True).start()
    threading.Timer(1.2, lambda: webbrowser.open("http://127.0.0.1:%d" % port) if not os.environ.get("DEWU_NO_BROWSER") else None).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
